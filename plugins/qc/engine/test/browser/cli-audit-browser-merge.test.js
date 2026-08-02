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

// A page that FAILED and a page that was never attempted both leave
// `pagesDone < pagesTotal`, and the report used to say the same thing about
// both -- "остальные ещё не проверены" -- which is simply false for a page
// the site refused to serve. The spec requires the count and the list of
// pages that would not open to reach the report header.
test('pages that would not open reach the report header, named, with their reason', async () => {
  const host = 'failed-pages.example.com'
  const urlA = `https://${host}/a`
  const urlB = `https://${host}/b`
  const urlC = `https://${host}/c`
  const mk = (u, t) => parsePage({ url: u, html: CLEAN_HTML(t), status: 200, headers: { 'content-type': 'text/html' } })
  seedStaticSnapshot(host, [mk(urlA, 'a'), mk(urlB, 'b'), mk(urlC, 'c')])

  appendBrowserResult(host, { url: urlA, widths: [360], error: null, findings: [] })
  appendBrowserResult(host, { url: urlB, widths: [360], error: 'Timeout 45000ms exceeded', findings: [] })

  const summary = await audit(`https://${host}`, {})
  assert.equal(summary.browserCoverage.pagesDone, 1, 'a failed page is not done')
  assert.equal(summary.browserCoverage.pagesFailed, 1)
  assert.deepEqual(
    summary.browserCoverage.failedUrls,
    [{ url: urlB, error: 'Timeout 45000ms exceeded' }],
  )

  const html = readFileSync(summary.reportPath, 'utf8')
  assert.match(html, /не открылись/i)
  assert.match(html, new RegExp(urlB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(html, /Timeout 45000ms exceeded/)
})

// A page retried after a failure leaves BOTH rows in the append-only log.
// Counting raw rows would report it as done AND failed at the same time.
test('a page that failed and was then retried successfully counts once, as done', async () => {
  const host = 'retried-page.example.com'
  const url = `https://${host}/a`
  const page = parsePage({ url, html: CLEAN_HTML('a'), status: 200, headers: { 'content-type': 'text/html' } })
  seedStaticSnapshot(host, [page])

  appendBrowserResult(host, { url, widths: [360], error: 'net::ERR_CONNECTION_REFUSED', findings: [] })
  appendBrowserResult(host, { url, widths: [360], error: null, findings: [] })

  const summary = await audit(`https://${host}`, {})
  assert.equal(summary.browserCoverage.pagesDone, 1)
  assert.equal(summary.browserCoverage.pagesFailed, 0, 'the superseded failure must not still count')

  const html = readFileSync(summary.reportPath, 'utf8')
  assert.doesNotMatch(html, /не открылись/i)
})

// `dropped` reached browse's stdout and the snapshot meta and stopped there.
// The spec says excluded widths are listed in the report rather than
// swallowed -- otherwise a reader has no way to know that e.g. 1200 was
// never measured at all.
test('widths the breakpoint budget excluded reach the report', async () => {
  const host = 'dropped-widths.example.com'
  const url = `https://${host}/a`
  const page = parsePage({ url, html: CLEAN_HTML('a'), status: 200, headers: { 'content-type': 'text/html' } })
  saveSnapshot(host, {
    meta: {
      host, env: 'prod', envReason: 'боевой хост', source: 'sitemap', sitemapStatus: 'ok',
      pairedAsDev: false, pairedAsDevReason: null, prodHost: null,
      pageCount: 1, pagesRequested: 1, pagesFailed: 0, failedUrls: [],
      browserWidths: [360, 768, 1024, 1440],
      browserWidthsDropped: [639, 1199, 1200],
    },
    pages: [page],
    links: [],
  })
  appendBrowserResult(host, { url, widths: [360, 768, 1024, 1440], error: null, findings: [] })

  const summary = await audit(`https://${host}`, {})
  assert.deepEqual(summary.browserCoverage.droppedWidths, [639, 1199, 1200])

  const html = readFileSync(summary.reportPath, 'utf8')
  assert.match(html, /исключённые ширины/i)
  assert.match(html, /1200/)
})
