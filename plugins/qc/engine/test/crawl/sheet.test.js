// Task 16 follow-up: loadStrategySheet always called the real
// docs.google.com export endpoint, so a reviewer (or CI) could not exercise
// it against a controlled fixture without monkeypatching globalThis.fetch
// (which test/crawl/xlsx.test.js already does, extensively). This file
// covers the same function through the *other* injection point --
// `fetchImpl`, the same pattern discover.js's discoverPages already uses --
// proving a genuine local node:http server can stand in for Google, with
// nothing global mutated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { loadStrategySheet } from '../../src/crawl/sheet.js'

const FIX = new URL('../fixtures/strategy.xlsx', import.meta.url)

test('loadStrategySheet downloads and parses a workbook served by a local server via fetchImpl', async () => {
  const buf = readFileSync(FIX)
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(buf)
  })
  try {
    await new Promise((r) => server.listen(0, r))
    const base = `http://127.0.0.1:${server.address().port}`
    // fetchImpl deliberately ignores the exportUrl it's given and always
    // hits the local server -- the point is that loadStrategySheet never
    // touches the real network when a fetchImpl is supplied, not that the
    // URL construction itself is under test here (that's covered elsewhere).
    const fetchImpl = (_url, opts) => fetch(`${base}/export.xlsx`, opts)

    const out = await loadStrategySheet(
      'https://docs.google.com/spreadsheets/d/13MQeTTUR85z6gbp1NPqVi7xJVQBn-bETZ3gTbMJu7Rc/export?format=xlsx',
      { fetchImpl }
    )
    assert.equal(out.sheet, 'Phase 3 Page Design List')
    assert.ok(out.rows.length > 300)
    assert.ok(out.rows.some((r) => r.devUrl && r.devUrl.includes('patest.website')))
  } finally {
    server.close()
  }
})

test('loadStrategySheet via fetchImpl still enforces the timeout (fetchImpl is not exempt)', async () => {
  const stalled = (_url, _opts) => new Promise(() => {}) // never settles
  const started = Date.now()
  await assert.rejects(
    () => loadStrategySheet('https://docs.google.com/spreadsheets/d/FAKE/export?format=xlsx', {
      fetchImpl: stalled, timeout: 50,
    }),
    /timed out/i
  )
  assert.ok(Date.now() - started < 2000, 'must reject promptly, not hang')
})

test('loadStrategySheet via fetchImpl surfaces a non-ok response as a clear error', async () => {
  const notFound = async () => ({ ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0) } })
  await assert.rejects(
    () => loadStrategySheet('https://docs.google.com/spreadsheets/d/FAKE/export?format=xlsx', { fetchImpl: notFound }),
    /404/
  )
})
