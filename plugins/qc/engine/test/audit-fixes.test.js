// Regression tests for the ponytail audit of 2026-10-20: cache reuse that
// answered for the wrong parser or page set, diffs after --only, stale
// browser rows, and the rule-level false positives it found.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { audit } from '../src/cli.js'
import { parsePage, PARSE_VERSION } from '../src/parse/page.js'
import { saveSnapshot, appendBrowserResult } from '../src/crawl/store.js'
import { isPost } from '../src/lib/kinds.js'
import { stateOfAddress } from '../src/lib/address.js'
import { normalizeFacts } from '../src/lib/facts.js'
import E12 from '../src/rules/static/E12-phone-consistency.js'
import F12 from '../src/rules/static/F12-dead-anchors.js'
import K13 from '../src/rules/static/K13-dev-vs-live.js'

let server, base, host
const HTML = `<!doctype html><html lang="en"><head><title>A</title></head>
<body><header>h</header><main><h1>Hello</h1><a href="tel:1-855-607-8758">call</a>
<img src="/x.png"></main></body></html>`

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${base}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') { res.writeHead(200); return res.end(`<urlset><url><loc>${base}/a</loc></url></urlset>`) }
    if (req.url === '/a') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HTML) }
    res.writeHead(404); res.end('nope')
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
  host = '127.0.0.1'
})
after(() => server.close())

async function withCache(fn) {
  const original = process.env.QC_CACHE_DIR
  const dir = mkdtempSync(join(tmpdir(), 'qc-fixes-'))
  process.env.QC_CACHE_DIR = dir
  try { return await fn() } finally {
    if (original === undefined) delete process.env.QC_CACHE_DIR
    else process.env.QC_CACHE_DIR = original
    rmSync(dir, { recursive: true, force: true })
  }
}

const seed = (meta) => saveSnapshot(host, {
  meta: {
    host, env: 'prod', envReason: 'x', source: 'sitemap', sitemapStatus: 'ok', pairedAsDev: false,
    pairedAsDevReason: null, prodHost: null, pageCount: 1, pagesRequested: 1, pagesFailed: 0, failedUrls: [],
    parseVersion: PARSE_VERSION, ...meta,
  },
  pages: [parsePage({ url: `${base}/a`, html: HTML, status: 200, headers: {} })],
  links: [],
})

test('a snapshot from another parser version is re-crawled, not reused', () => withCache(async () => {
  seed({ parseVersion: undefined })
  assert.equal((await audit(base, {})).fromCache, false)
  assert.equal((await audit(base, {})).fromCache, true, 'the fresh crawl is stamped with the current version')
}))

test('a sheet snapshot does not answer a whole-site audit', () => withCache(async () => {
  seed({ source: 'sheet:Pages', requestedUrls: [`${base}/a`] })
  const out = await audit(base, {})
  assert.equal(out.fromCache, false)
  assert.equal(out.source, 'sitemap')
}))

test('a --only run does not turn every other rule into "fixed", and back into "new"', () => withCache(async () => {
  const full = await audit(base, { fresh: true })
  assert.ok(full.counts.major + full.counts.minor + full.counts.critical > 1, 'the page trips more than one rule')
  const only = await audit(base, { only: 'E4' })
  assert.equal(only.diff.fixed, 0)
  const again = await audit(base, {})
  assert.equal(again.diff.added, 0)
}))

test('browser rows older than the crawl are left out and counted as stale', () => withCache(async () => {
  seed({})
  const finding = { rule: 'C1', title: 'h-scroll', severity: 'major', engine: 'browser', confidence: 'high', page: `${base}/a`, found: 'scroll' }
  appendBrowserResult(host, { url: `${base}/a`, at: Date.now() - 3600e3, widths: [360], error: null, findings: [finding] })
  const out = await audit(base, {})
  assert.equal(out.fromCache, true)
  assert.equal(out.browserCoverage.stalePages, 1)
  assert.equal(out.browserCoverage.pagesDone, 0)
  const findings = JSON.parse(readFileSync(join(out.runDir, 'findings.json'), 'utf8'))
  assert.ok(!findings.some(f => f.rule === 'C1'))

  appendBrowserResult(host, { url: `${base}/a`, at: Date.now(), widths: [360], error: null, findings: [finding] })
  const fresh = await audit(base, {})
  assert.equal(fresh.browserCoverage.stalePages, 0)
  assert.equal(fresh.browserCoverage.pagesDone, 1)
}))

test('a Yoast service page with datePublished in its WebPage node is not a post', () => {
  const html = readFileSync(new URL('./fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
  const p = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })
  assert.ok(p.published, 'the fixture does carry a JSON-LD datePublished')
  assert.equal(isPost(p), false)
  assert.equal(isPost({ bodyClass: 'single-post' }), true)
  assert.equal(isPost({ isArticle: true }), true)
})

test('K13 counts a dev menu linking production with absolute URLs as the same menu', () => {
  const link = (href, text) => ({ raw: href, href, text, internal: href.includes('dev.ex.com'), region: 'nav' })
  const dev = { url: 'https://dev.ex.com/', links: [link('https://www.ex.com/about/', 'About')], headings: [], jsonLdRaw: [] }
  const live = { url: 'https://www.ex.com/', links: [{ ...link('https://www.ex.com/about/', 'About'), internal: true }], headings: [], jsonLdRaw: [] }
  const prod = { host: 'www.ex.com', pairs: [{ dev: dev.url, prod: live.url, status: 200 }], pages: [live], missing: [] }
  assert.deepEqual(K13.check(dev, { env: 'dev', pages: [dev], prod }), [])
})

test('F12 ignores the #fragment of an external link', () => {
  const p = { url: 'https://ex.com/', ids: [], links: [{ raw: 'https://partner.org/#find-help', href: 'https://partner.org/', internal: false, region: 'main', text: 'Help' }] }
  assert.deepEqual(F12.check(p, { pages: [p] }), [])
})

test('E12 with facts: a number in the copy is heuristic, a tel: link stays certain', () => {
  const facts = normalizeFacts({ phones: ['+18556078758'] }, 'f.json')
  const p = {
    url: 'https://ex.com/', text: 'SAMHSA Helpline 1-800-662-4357', jsonLdRaw: [],
    links: [{ raw: 'tel:+18005550000', protocol: 'tel:', selector: 'a' }],
  }
  const f = E12.check(p, { facts })
  assert.equal(f.find(x => /тексте/.test(x.found)).confidence, 'heuristic')
  assert.equal(f.find(x => /tel|не из фактов сайта: tel/.test(x.found) && !/тексте/.test(x.found)).confidence, 'high')
})

test('stateOfAddress reads the state after the street line', () => {
  assert.equal(stateOfAddress('100 Georgia Ave, Silver Spring, Maryland'), 'Maryland')
  assert.equal(stateOfAddress('5806 Culebra Road, San Antonio, TX 78228'), 'Texas')
})
