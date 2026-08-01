import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fetchAll, fetchOne } from '../../src/crawl/fetch.js'

let server, base
let hits = 0

before(async () => {
  server = createServer((req, res) => {
    hits++
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>ok</h1>') }
    if (req.url === '/missing') { res.writeHead(404); return res.end('nope') }
    if (req.url === '/moved') { res.writeHead(301, { location: '/ok' }); return res.end() }
    if (req.url === '/flaky') {
      if (hits % 2 === 1) { res.writeHead(503); return res.end() }
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>recovered</h1>')
    }
    res.writeHead(200); res.end('x')
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

test('fetchOne returns the body and status', async () => {
  const r = await fetchOne(`${base}/ok`)
  assert.equal(r.status, 200)
  assert.match(r.body, /<h1>ok<\/h1>/)
  assert.equal(r.ok, true)
})

test('fetchOne reports a 404 without throwing', async () => {
  const r = await fetchOne(`${base}/missing`)
  assert.equal(r.status, 404)
  assert.equal(r.ok, false)
})

test('fetchOne follows a redirect and records the final URL', async () => {
  const r = await fetchOne(`${base}/moved`)
  assert.equal(r.status, 200)
  assert.ok(r.finalUrl.endsWith('/ok'))
})

test('fetchOne retries a 503 and succeeds', async () => {
  hits = 0
  const r = await fetchOne(`${base}/flaky`, { retries: 2 })
  assert.equal(r.status, 200)
})

test('fetchOne exhausts retries and resolves with status 0 and an error, never throwing', async () => {
  // Nothing is listening on this port on 127.0.0.1, so every attempt fails at the
  // connection level. fetchOne must swallow that and return a FetchResult, not throw.
  const r = await fetchOne('http://127.0.0.1:1/nope', { retries: 1, timeout: 500 })
  assert.equal(r.status, 0)
  assert.equal(r.ok, false)
  assert.ok(r.error, 'expected a populated error message')
})

test('fetchAll returns one entry per unique url', async () => {
  const map = await fetchAll([`${base}/ok`, `${base}/missing`, `${base}/ok`], { concurrency: 2 })
  assert.equal(map.size, 2)
  assert.equal(map.get(`${base}/ok`).status, 200)
})

test('fetchAll reports progress', async () => {
  const seen = []
  await fetchAll([`${base}/ok`, `${base}/missing`], { concurrency: 1, onProgress: (d, t) => seen.push([d, t]) })
  assert.equal(seen.at(-1)[0], 2)
})

// --- Throttle behaviour ---------------------------------------------------
//
// The brief's reference fetchAll sets `active = 2` inside a worker on a 429/503,
// but the worker pool size was already fixed (via Math.min(active, ...)) before
// any request ran, so that assignment is a no-op and concurrency never actually
// drops. This test proves a real implementation must react: it stands up its own
// server that records, for every request, how many requests were concurrently
// in flight (including itself) at the moment it arrived. One path answers 503
// on first hit; every other path answers 200 after an artificial delay so that
// overlap is observable.
//
// The before/after split is done by queue position, not by server arrival
// order: with concurrency 6, a correct scheduler dispatches queue[0..5] (the
// "batch 1" paths, which include /trigger) all at once, and can only ever
// reach queue[6..] (the "batch 2" paths) once a slot frees up later in the
// run -- by which time the 503 has long since been seen and the limit
// lowered. That makes the split deterministic regardless of exactly which
// millisecond each connection lands on the server, so the test isn't racy.
// We assert:
//   - batch 1 (the initial wave) shows concurrency above 2 at some point,
//     proving the fetcher really does run at the configured concurrency, and
//   - batch 2 (everything dispatched afterward) never exceeds concurrency 2,
//     proving the throttle engages and holds for the rest of the run.
test('fetchAll drops concurrency to 2 the moment a 503 is seen, and keeps it there', async () => {
  const CONCURRENCY = 6
  const N = 14 // more than default concurrency, so we get a real second wave
  let inFlight = 0
  const arrivals = [] // { path, peekInFlight }

  const throttleServer = createServer((req, res) => {
    inFlight++
    arrivals.push({ path: req.url, peekInFlight: inFlight })

    const finish = (status, delayMs) => {
      const send = () => {
        inFlight--
        res.writeHead(status, { 'content-type': 'text/plain' })
        res.end('x')
      }
      if (delayMs) setTimeout(send, delayMs)
      else send()
    }

    if (req.url === '/trigger') {
      finish(503, 0) // answers instantly, so the throttle decision lands early
    } else {
      finish(200, 60) // deliberately slow, so concurrent overlap is observable
    }
  })
  await new Promise(r => throttleServer.listen(0, r))
  const tbase = `http://127.0.0.1:${throttleServer.address().port}`

  try {
    const paths = ['/trigger', ...Array.from({ length: N - 1 }, (_, i) => `/n${i}`)]
    const batch1Paths = new Set(paths.slice(0, CONCURRENCY))
    const batch2Paths = new Set(paths.slice(CONCURRENCY))
    const urls = paths.map(p => `${tbase}${p}`)

    const results = await fetchAll(urls, { concurrency: CONCURRENCY, retries: 0, timeout: 5000 })

    // Sanity: fetchAll must still resolve every url, including the 503 one.
    assert.equal(results.size, N)
    assert.equal(results.get(`${tbase}/trigger`).status, 503)
    for (const p of urls.slice(1)) assert.equal(results.get(p).status, 200)

    const batch1Arrivals = arrivals.filter(a => batch1Paths.has(a.path))
    const batch2Arrivals = arrivals.filter(a => batch2Paths.has(a.path))

    assert.equal(batch1Arrivals.length, CONCURRENCY)
    assert.equal(batch2Arrivals.length, N - CONCURRENCY)

    const peakBefore = Math.max(...batch1Arrivals.map(a => a.peekInFlight))
    const peakAfter = Math.max(...batch2Arrivals.map(a => a.peekInFlight))

    assert.ok(peakBefore > 2, `expected concurrency above 2 in the initial wave (saw ${peakBefore})`)
    assert.ok(peakAfter <= 2, `expected concurrency capped at 2 after the 503 (saw ${peakAfter})`)
  } finally {
    throttleServer.close()
  }
})
