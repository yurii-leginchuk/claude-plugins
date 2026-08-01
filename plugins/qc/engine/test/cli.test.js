// plugins/qc/engine/test/cli.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Direct (in-process) imports, used only by the pairedAsDev-precedence test
// below. `audit` is safe to import directly: src/cli.js guards its own
// main()/process.exit side effects behind an "am I the entry script?"
// check, so importing it here (where process.argv[1] is this test file, not
// cli.js) never runs the CLI -- it only makes `audit` callable in-process,
// which is what lets that test seed a snapshot via saveSnapshot() and then
// call audit() directly against the very same QC_CACHE_DIR, without the
// awkwardness of passing a fetchImpl through a subprocess's argv.
import { audit } from '../src/cli.js'
import { parsePage } from '../src/parse/page.js'
import { saveSnapshot } from '../src/crawl/store.js'

const run = promisify(execFile)
const cwd = new URL('..', import.meta.url).pathname

let server, base, cache

// NOTE on the phone number below: E4 rates a *bare 10-digit* tel: as only
// 'heuristic' confidence (it cannot be sure a country code is missing vs.
// just unformatted), and counts.major here -- like verdict() and the HTML
// report's tiles elsewhere in this engine -- deliberately excludes
// heuristic-confidence findings, since those are set aside for human review
// rather than treated as confirmed defects. An 11-digit number (country
// code present, just unformatted) is what actually reaches 'high'
// confidence and lands in counts.major.
const PAGE = (extra = '') => `<!doctype html><html lang="en"><head>
<title>Test page</title><link rel="canonical" href="BASE/a">
</head><body><header>h</header><main><h1>Hello</h1>
<a href="tel:1-855-607-8758">call</a>${extra}</main></body></html>`

before(async () => {
  cache = mkdtempSync(join(tmpdir(), 'qc-cli-'))
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${base}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<urlset><url><loc>${base}/a</loc></url></urlset>`)
    }
    if (req.url === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(PAGE().replaceAll('BASE', base))
    }
    res.writeHead(404); res.end('nope')
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); rmSync(cache, { recursive: true, force: true }) })

test('audit crawls, finds the tel defect and writes a report', async () => {
  const { stdout } = await run('node', ['src/cli.js', 'audit', base, '--env', 'prod'], {
    cwd,
    env: { ...process.env, QC_CACHE_DIR: cache },
  })
  const out = JSON.parse(stdout)
  assert.equal(out.pages, 1)
  assert.equal(out.env, 'prod')
  assert.ok(out.counts.major >= 1, 'expected the E4 tel finding')
  assert.ok(existsSync(out.reportPath))
})

test('cache list shows the crawled host', async () => {
  const { stdout } = await run('node', ['src/cli.js', 'cache', 'list'], {
    cwd,
    env: { ...process.env, QC_CACHE_DIR: cache },
  })
  assert.match(stdout, /127\.0\.0\.1/)
})

test('cache clear --all empties the cache', async () => {
  await run('node', ['src/cli.js', 'cache', 'clear', '--all'], {
    cwd,
    env: { ...process.env, QC_CACHE_DIR: cache },
  })
  const { stdout } = await run('node', ['src/cli.js', 'cache', 'list'], {
    cwd,
    env: { ...process.env, QC_CACHE_DIR: cache },
  })
  assert.match(stdout, /пусто|\[\]/)
})

// --- Judgement call 1: exit codes -----------------------------------------
//
// audit must exit non-zero only when it could not COMPLETE (no pages found,
// unreadable input, unknown rule id, ...). A Fail verdict is a completed,
// successful run of the tool and must exit 0.

test('audit exits non-zero and explains itself when no pages can be found', async () => {
  const cache1 = mkdtempSync(join(tmpdir(), 'qc-cli-nopages-'))
  const empty = createServer((_req, res) => { res.writeHead(404); res.end('nope') })
  try {
    await new Promise(r => empty.listen(0, r))
    const emptyBase = `http://127.0.0.1:${empty.address().port}`
    await assert.rejects(
      run('node', ['src/cli.js', 'audit', emptyBase], { cwd, env: { ...process.env, QC_CACHE_DIR: cache1 } }),
      (err) => {
        assert.notEqual(err.code, 0)
        assert.match(err.stderr, /не найдено ни одной страницы/)
        return true
      }
    )
  } finally {
    empty.close()
    rmSync(cache1, { recursive: true, force: true })
  }
})

test('audit exits zero even when the verdict is Fail', async () => {
  const cache2 = mkdtempSync(join(tmpdir(), 'qc-cli-fail-'))
  // No <h1> at all on the page triggers I1 (critical) -> verdict 'Fail'.
  const noH1 = `<!doctype html><html lang="en"><head><title>No heading</title></head>
<body><header>h</header><main><p>no heading here</p></main></body></html>`
  const s = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end() }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(noH1) }
    res.writeHead(404); res.end('nope')
  })
  try {
    await new Promise(r => s.listen(0, r))
    const failBase = `http://127.0.0.1:${s.address().port}`
    const { stdout } = await run('node', ['src/cli.js', 'audit', failBase, '--env', 'prod'], {
      cwd, env: { ...process.env, QC_CACHE_DIR: cache2 },
    })
    const out = JSON.parse(stdout)
    assert.equal(out.verdict, 'Fail')
    assert.ok(out.counts.critical >= 1)
  } finally {
    s.close()
    rmSync(cache2, { recursive: true, force: true })
  }
})

// --- Judgement call 2: --fresh vs the snapshot cache -----------------------
//
// Without --fresh, a snapshot younger than 24h is reused and no network
// request is made at all. --fresh always forces a live re-crawl. Either way
// the summary says which happened via `fromCache`/`cacheAgeDays`.

test('--fresh forces a re-crawl; without it a young snapshot is reused and reported as such', async () => {
  const cache3 = mkdtempSync(join(tmpdir(), 'qc-cli-fresh-'))
  let hits = 0
  const s = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${b}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<urlset><url><loc>${b}/a</loc></url></urlset>`)
    }
    if (req.url === '/a') {
      hits++
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(PAGE().replaceAll('BASE', b))
    }
    res.writeHead(404); res.end('nope')
  })
  let b
  try {
    await new Promise(r => s.listen(0, r))
    b = `http://127.0.0.1:${s.address().port}`
    const env = { ...process.env, QC_CACHE_DIR: cache3 }

    const first = JSON.parse((await run('node', ['src/cli.js', 'audit', b], { cwd, env })).stdout)
    assert.equal(first.fromCache, false)
    assert.equal(hits, 1)

    const second = JSON.parse((await run('node', ['src/cli.js', 'audit', b], { cwd, env })).stdout)
    assert.equal(second.fromCache, true)
    assert.equal(hits, 1, 'reusing a young snapshot must not touch the network at all')

    const third = JSON.parse((await run('node', ['src/cli.js', 'audit', b, '--fresh'], { cwd, env })).stdout)
    assert.equal(third.fromCache, false)
    assert.equal(hits, 2, '--fresh must force a live re-crawl regardless of snapshot age')
  } finally {
    s.close()
    rmSync(cache3, { recursive: true, force: true })
  }
})

// --- Judgement call 3: partial page failures -------------------------------
//
// A 404/error on one page in a multi-page crawl must not abort the run --
// it is counted and surfaced, and the pages that DID succeed are still
// audited.

test('a page that 404s mid-crawl is counted, not dropped silently, and the run still succeeds', async () => {
  const cache4 = mkdtempSync(join(tmpdir(), 'qc-cli-partial-'))
  const s = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${b}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<urlset><url><loc>${b}/ok</loc></url><url><loc>${b}/missing</loc></url></urlset>`)
    }
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(PAGE().replaceAll('BASE', b))
    }
    res.writeHead(404); res.end('not found')
  })
  let b
  try {
    await new Promise(r => s.listen(0, r))
    b = `http://127.0.0.1:${s.address().port}`
    const { stdout } = await run('node', ['src/cli.js', 'audit', b], {
      cwd, env: { ...process.env, QC_CACHE_DIR: cache4 },
    })
    const out = JSON.parse(stdout)
    assert.equal(out.pages, 1, 'only the successfully-fetched page counts as audited')
    assert.equal(out.pagesRequested, 2)
    assert.equal(out.pagesFailed, 1)
    assert.equal(out.failedUrls.length, 1)
    assert.match(out.failedUrls[0].url, /\/missing$/)
    assert.equal(out.failedUrls[0].status, 404)
  } finally {
    s.close()
    rmSync(cache4, { recursive: true, force: true })
  }
})

// --- Judgement call 4: unknown rule id in --only/--skip --------------------

test('--only with an unknown rule id fails loudly instead of silently auditing nothing', async () => {
  const cache5 = mkdtempSync(join(tmpdir(), 'qc-cli-unknown-rule-'))
  const s = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${b}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<urlset><url><loc>${b}/a</loc></url></urlset>`)
    }
    if (req.url === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(PAGE().replaceAll('BASE', b))
    }
    res.writeHead(404); res.end('nope')
  })
  let b
  try {
    await new Promise(r => s.listen(0, r))
    b = `http://127.0.0.1:${s.address().port}`
    await assert.rejects(
      run('node', ['src/cli.js', 'audit', b, '--only', 'ZZZ'], {
        cwd, env: { ...process.env, QC_CACHE_DIR: cache5 },
      }),
      (err) => {
        assert.notEqual(err.code, 0)
        assert.match(err.stderr, /ZZZ/)
        assert.match(err.stderr, /E4/) // a real rule id, from the "available" list
        return true
      }
    )
  } finally {
    s.close()
    rmSync(cache5, { recursive: true, force: true })
  }
})

// --- Review follow-up 1: pairedAsDev must come from THIS invocation, not
// from whatever a stale-but-not-yet-expired cached snapshot remembers -----
//
// A snapshot saved by an earlier run with pairedAsDev: false must not
// silently override a dev/prod-pairing signal (sheet Dev Link column, or
// --prod) that the CURRENT invocation supplies, even on a cache hit. Getting
// this backwards means a genuinely-dev site gets audited as production,
// which flips I4 (noindex-vs-env) from silent to a false Critical on every
// page. --prod exercises the exact same `invocationPairedAsDev` precedence
// code path a sheet's Dev Link column does (see src/cli.js), and isolates
// it from any hostname-based dev detection: 'shop.example.com' does not
// match the dev-host pattern in lib/env.js, so 'dev' here can only come from
// the pairing signal, never from the hostname.
//
// This test calls audit() directly (imported above) instead of going
// through the CLI subprocess, so it can seed the snapshot with
// crawl/store.js's saveSnapshot() and then run audit() against that exact
// QC_CACHE_DIR in-process -- no subprocess argv can carry a seeded snapshot
// or a fetchImpl, which is also why sheet.js gained a fetchImpl injection
// point in this same follow-up (see test/crawl/sheet.test.js).
test('a --prod (or sheet Dev Link) signal on THIS run overrides a stale pairedAsDev:false in the cache', async () => {
  const originalCacheDir = process.env.QC_CACHE_DIR
  const cache6 = mkdtempSync(join(tmpdir(), 'qc-cli-paired-'))
  process.env.QC_CACHE_DIR = cache6
  try {
    const host = 'shop.example.com'
    const url = `https://${host}/`
    const html = `<!doctype html><html lang="en"><head><title>Shop</title>
<link rel="canonical" href="${url}"></head>
<body><header>h</header><main><h1>Shop</h1></main></body></html>`
    const page = parsePage({ url, html, status: 200, headers: { 'content-type': 'text/html' } })

    // Seed a snapshot for this host that remembers pairedAsDev: false (as a
    // prior plain-URL audit of this same host would have saved).
    saveSnapshot(host, {
      meta: {
        host, env: 'prod', envReason: 'боевой хост, страницы индексируются',
        source: 'crawl', sitemapStatus: null, pairedAsDev: false, pairedAsDevReason: null,
        pageCount: 1, pagesRequested: 1, pagesFailed: 0, failedUrls: [],
      },
      pages: [page],
      links: [],
    })

    // This run supplies its own pairedAsDev signal via --prod. It must win,
    // and it must be reported as a cache hit (proving the signal really was
    // read from a reused snapshot, not from a fresh crawl that would have
    // recomputed everything anyway).
    const out = await audit(`https://${host}`, { prod: 'https://shop-prod.example.com' })
    assert.equal(out.fromCache, true, 'expected the young snapshot to actually be reused')
    assert.equal(out.env, 'dev', 'the --prod signal on this run must override the cached pairedAsDev:false')
    assert.match(out.envReason, /--prod/, 'the reason should name --prod as the signal source (minor fix)')
  } finally {
    if (originalCacheDir === undefined) delete process.env.QC_CACHE_DIR
    else process.env.QC_CACHE_DIR = originalCacheDir
    rmSync(cache6, { recursive: true, force: true })
  }
})

// --- Review follow-up 2: heuristic-only findings must not vanish from the
// JSON summary --------------------------------------------------------------
//
// counts.* deliberately excludes heuristic-confidence findings (matching
// verdict()/rollUp()/renderReport() elsewhere), so a heuristic-only page
// reports verdict: 'Pass' and every counts.* at 0. Without a separate
// `heuristics` field, that is indistinguishable in the JSON summary from a
// genuinely clean site -- and stdout is the only contract a caller that
// never opens the HTML report actually sees.
test('a heuristic-only page reports verdict Pass with a non-zero heuristics count', async () => {
  const cache7 = mkdtempSync(join(tmpdir(), 'qc-cli-heuristic-'))
  // A bare 10-digit tel: (no country code, no +) is E4's heuristic case --
  // confidence: 'heuristic' -- not a confirmed defect. Everything else on
  // the page is clean (single h1, self-referencing canonical, no forms/
  // images/other links), so nothing else contributes a solid major/critical
  // finding.
  const s = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end() }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(`<!doctype html><html lang="en"><head>
<title>Clean-ish page</title><link rel="canonical" href="${b}/">
</head><body><header>h</header><main><h1>Hello</h1>
<a href="tel:7189690845">call</a></main></body></html>`)
    }
    res.writeHead(404); res.end('nope')
  })
  let b
  try {
    await new Promise(r => s.listen(0, r))
    b = `http://127.0.0.1:${s.address().port}`
    const { stdout } = await run('node', ['src/cli.js', 'audit', b, '--env', 'prod'], {
      cwd, env: { ...process.env, QC_CACHE_DIR: cache7 },
    })
    const out = JSON.parse(stdout)
    assert.equal(out.verdict, 'Pass')
    assert.equal(out.counts.critical, 0)
    assert.equal(out.counts.major, 0)
    assert.ok(out.heuristics >= 1, `expected at least one heuristic finding, got ${out.heuristics}`)
  } finally {
    s.close()
    rmSync(cache7, { recursive: true, force: true })
  }
})
