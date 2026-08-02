// plugins/qc/engine/test/browser/cli-audit-browser-merge.test.js
//
// Task 10: `qc audit` merges whatever `qc browse` has already recorded for
// a host into the report -- without ever launching a browser itself. This
// exercises that wiring end to end: seed a static snapshot (as a prior
// `audit` would), seed a browser.jsonl row (as a prior `browse` would,
// including a real PNG on disk for the screenshot inlining path), then call
// `audit()` in-process against that exact QC_CACHE_DIR -- same pattern
// test/cli.test.js's pairedAsDev-precedence test already uses, for the same
// reason: a subprocess's argv cannot carry a seeded cache directory's
// contents.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audit } from '../../src/cli.js'
import { parsePage } from '../../src/parse/page.js'
import { saveSnapshot, appendBrowserResult, snapshotDir } from '../../src/crawl/store.js'

let cache, originalCacheDir

before(() => {
  originalCacheDir = process.env.QC_CACHE_DIR
  cache = mkdtempSync(join(tmpdir(), 'qc-cli-browser-merge-'))
  process.env.QC_CACHE_DIR = cache
})
after(() => {
  if (originalCacheDir === undefined) delete process.env.QC_CACHE_DIR
  else process.env.QC_CACHE_DIR = originalCacheDir
  rmSync(cache, { recursive: true, force: true })
})

function seedStaticSnapshot(host, pages) {
  saveSnapshot(host, {
    meta: {
      host, env: 'prod', envReason: 'боевой хост', source: 'sitemap', sitemapStatus: 'ok',
      pairedAsDev: false, pairedAsDevReason: null, prodHost: null,
      pageCount: pages.length, pagesRequested: pages.length, pagesFailed: 0, failedUrls: [],
    },
    pages,
    links: [],
  })
}

const CLEAN_HTML = (title) => `<!doctype html><html lang="en"><head><title>${title}</title>
</head><body><header>h</header><main><h1>Hi</h1></main></body></html>`

test('audit merges browser findings from browser.jsonl, reports coverage, and inlines the screenshot', async () => {
  const host = 'browser-merge.example.com'
  const url = `https://${host}/a`
  const page = parsePage({ url, html: CLEAN_HTML('t'), status: 200, headers: { 'content-type': 'text/html' } })
  seedStaticSnapshot(host, [page])

  // A real (tiny) PNG on disk, at the path a real capture would have left --
  // inlineScreenshots() in cli.js must read this file and turn it into the
  // data URI the report embeds, not just pass the path through.
  const shotDir = join(snapshotDir(host), 'shots')
  mkdirSync(shotDir, { recursive: true })
  const shotPath = join(shotDir, 'fake.png')
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  writeFileSync(shotPath, pngBytes)

  appendBrowserResult(host, {
    url, widths: [360, 768], error: null,
    findings: [{
      rule: 'C1', title: 'Горизонтальный скролл документа', severity: 'critical', engine: 'browser',
      confidence: 'high', page: url, breakpoint: 360, selector: 'html',
      found: 'ширина документа 3000px при вьюпорте 360px', expected: 'документ не шире вьюпорта',
      shot: shotPath, shotWidth: 360,
    }],
  })

  const summary = await audit(`https://${host}`, {})
  assert.equal(summary.fromCache, true, 'the seeded static snapshot should be reused, not re-crawled')

  assert.ok(summary.browserCoverage, 'browserCoverage must be present once browser.jsonl exists')
  assert.equal(summary.browserCoverage.pagesDone, 1)
  assert.equal(summary.browserCoverage.pagesTotal, 1)
  assert.deepEqual(summary.browserCoverage.widths, [360, 768])
  assert.ok(summary.counts.critical >= 1, 'the C1 browser finding must count toward the severity totals')
  assert.ok(summary.distinct.critical >= 1, 'and toward distinct, same as any static finding')

  const html = readFileSync(summary.reportPath, 'utf8')
  assert.match(html, />C1</, 'the browser rule id reaches the report')
  assert.match(html, /360/, 'the breakpoint reaches the report')
  assert.match(html, /<img[^>]+data:image\/png;base64/, 'the screenshot file was read and inlined as a data URI')
})

test('audit omits browserCoverage (and says so in the report) when qc browse has never run for this host', async () => {
  const host = 'no-browser.example.com'
  const url = `https://${host}/a`
  const page = parsePage({ url, html: CLEAN_HTML('t'), status: 200, headers: { 'content-type': 'text/html' } })
  seedStaticSnapshot(host, [page])

  const summary = await audit(`https://${host}`, {})
  assert.equal(summary.browserCoverage, null, 'no browser.jsonl for this host means no coverage claim at all')

  const html = readFileSync(summary.reportPath, 'utf8')
  assert.match(html, /не выполнялась/i, 'the report must say the browser pass never ran, not stay silent about it')
})

test('a partial browser pass (fewer pagesDone than pagesTotal) is stated as partial, not silently complete', async () => {
  const host = 'partial-browser.example.com'
  const urlA = `https://${host}/a`
  const urlB = `https://${host}/b`
  const pageA = parsePage({ url: urlA, html: CLEAN_HTML('a'), status: 200, headers: { 'content-type': 'text/html' } })
  const pageB = parsePage({ url: urlB, html: CLEAN_HTML('b'), status: 200, headers: { 'content-type': 'text/html' } })
  seedStaticSnapshot(host, [pageA, pageB])

  // Only page A was ever visited by the browser pass -- page B has no row
  // at all, the same partial state a killed/interrupted `qc browse` leaves.
  appendBrowserResult(host, { url: urlA, widths: [360], error: null, findings: [] })

  const summary = await audit(`https://${host}`, {})
  assert.equal(summary.browserCoverage.pagesDone, 1)
  assert.equal(summary.browserCoverage.pagesTotal, 2)

  const html = readFileSync(summary.reportPath, 'utf8')
  assert.match(html, /частично/i, 'a partial browser pass must be visibly flagged as partial in the report')
})
