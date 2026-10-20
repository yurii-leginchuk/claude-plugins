// plugins/qc/engine/test/browser/region-end-to-end.test.js
//
// The region chain, end to end, against real markup -- the one thing the
// suite never had.
//
// Every existing test that asserts `region: 'footer'` reaches a finding does
// it with an INJECTED probe rule (run.test.js's ZZ_* rules) over hand-written
// two-div fixtures. That proves run.js's plumbing, and nothing else: no test
// anywhere proved that a single one of the nine PRODUCTION browser rules
// calls `ctx.helpers.containerId(el)` at all. A rule that quietly stopped
// setting containerId -- or never set it in the first place -- would lose its
// region silently, and every test would stay green, because the only rules
// under test were the ones the test itself wrote.
//
// test/fixtures/opura-office-cleaning.html has been sitting in the repo the
// whole time: 1289 lines of real WordPress/Elementor markup carrying
// `elementor-3374 elementor-location-header` and `elementor-3381
// elementor-location-footer`. This test serves it, parses it with the REAL
// parser, proves regions from that snapshot the way runBrowserPass does on a
// real run, runs the REAL rule bundle in a real browser, and asserts a
// PRODUCTION rule's finding comes back tagged with its region.
//
// No public URL is ever loaded: the fixture is served from a loopback server,
// and every request the page makes to anything other than 127.0.0.1 is
// aborted at the route level (see blockOffHost below). Real WordPress markup
// references fonts, analytics and CDN assets by absolute URL; those are
// refused, not fetched.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBrowserPass } from '../../src/browser/run.js'
import { launchBrowser } from '../../src/browser/launch.js'
import { parsePage, PARSE_VERSION } from '../../src/parse/page.js'
import { proveRegions } from '../../src/browser/regions.js'
import { saveSnapshot } from '../../src/crawl/store.js'
import { allBrowserRules } from '../../src/rules/browser-index.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opura-office-cleaning.html')

let server, base, cache, html

before(async () => {
  cache = mkdtempSync(join(tmpdir(), 'qc-region-e2e-'))
  process.env.QC_CACHE_DIR = cache
  html = readFileSync(FIXTURE, 'utf8')
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); rmSync(cache, { recursive: true, force: true }) })

// Wraps the real browser factory so every request to a host other than the
// loopback fixture server is aborted. Real WordPress markup is full of
// absolute references to fonts, plugin CDNs and analytics; this test must
// never reach any of them.
const blockOffHost = async (opts) => {
  const { browser, newPage } = await launchBrowser(opts)
  return {
    browser,
    newPage: async () => {
      const page = await newPage()
      await page.route('**/*', (route) => {
        let host
        try {
          host = new URL(route.request().url()).hostname
        } catch {
          return route.abort()
        }
        return (host === '127.0.0.1' || host === 'localhost') ? route.continue() : route.abort()
      })
      return page
    },
  }
}

test('a production rule\'s finding on real Elementor markup carries its proved region', async () => {
  const host = 'region-e2e.example.com'
  const urls = [`${base}/office-cleaning/`, `${base}/window-cleaning/`]

  // The snapshot regions are proved from is built by the REAL parser, from
  // the REAL markup -- not a hand-written elementor: {...} literal.
  const pages = urls.map(url => parsePage({
    url, html, status: 200, headers: { 'content-type': 'text/html' },
  }))
  saveSnapshot(host, {
    meta: {
      parseVersion: PARSE_VERSION,
      host, env: 'prod', envReason: 'fixture', source: 'sitemap', sitemapStatus: 'ok',
      pairedAsDev: false, pairedAsDevReason: null, prodHost: null,
      pageCount: pages.length, pagesRequested: pages.length, pagesFailed: 0, failedUrls: [],
    },
    pages,
    links: [],
  })

  // What the parser actually found, before any browser is involved: if this
  // ever stops holding, the failure below would otherwise look like a rule
  // bug rather than a parser one.
  const regions = proveRegions(pages)
  assert.equal(regions.get('3374')?.name, 'header', 'the real header container is proved and named')
  assert.equal(regions.get('3381')?.name, 'footer', 'the real footer container is proved and named')

  // runBrowserPass derives regions from the stored snapshot itself here (no
  // `regions` override), which is the path a real `qc browse` takes.
  const summary = await runBrowserPass({
    host, pages: urls, widths: [1440],
    opts: { timeout: 20000, launchBrowserImpl: blockOffHost },
  })
  assert.equal(summary.pagesFailed, 0, 'the fixture pages must open')
  assert.ok(summary.findings.length, 'the real bundle produced findings on real markup')

  const productionRuleIds = new Set((await allBrowserRules()).map(r => r.id))
  const tagged = summary.findings.filter(
    f => productionRuleIds.has(f.rule) && (f.region === 'footer' || f.region === 'header')
  )
  assert.ok(
    tagged.length,
    'no production rule tagged a finding with header/footer; rules that never call ' +
    'ctx.helpers.containerId lose their region silently. Findings seen: ' +
    JSON.stringify(summary.findings.slice(0, 5).map(f => ({
      rule: f.rule, containerId: f.containerId, region: f.region,
    })))
  )

  // The whole payoff: one defect in a shared region, on two pages, is ONE
  // defect to fix -- and the region is what says so.
  const example = tagged[0]
  assert.ok(productionRuleIds.has(example.rule))
  assert.ok(example.containerId, 'the rule set containerId at the element itself')

  // No finding may carry a bare container id in its `region` slot: the
  // fixture also has shared containers with no elementor-location-* class
  // (the JetPopup, the page container), and those must be labelled as ids,
  // not passed off as names.
  for (const f of summary.findings) {
    if (!f.region) continue
    assert.ok(
      /^[a-z]/.test(f.region) || f.region.startsWith('#'),
      `region ${JSON.stringify(f.region)} is a bare id presented as a name`,
    )
  }
})

// A container proved shared but never named must not be handed to the report
// as though its id were a name -- the real fixture has exactly such
// containers (the JetPopup 8077 and the page container 6766 carry no
// elementor-location-* class) alongside the named header and footer.
test('an unnamed shared container is labelled as an id, while header/footer keep their names', async () => {
  const pages = [`${base}/a`, `${base}/b`].map(url => parsePage({
    url, html, status: 200, headers: { 'content-type': 'text/html' },
  }))
  const regions = proveRegions(pages)

  assert.equal(regions.get('3374').name, 'header')
  assert.equal(regions.get('3381').name, 'footer')
  const unnamed = [...regions.values()].filter(r => r.name === null)
  assert.ok(unnamed.length, 'the fixture has shared containers with no location class')
  for (const r of unnamed) {
    assert.ok(r.id, 'an unnamed region still carries its id')
    assert.notEqual(r.name, r.id, 'and never presents that id as a name')
  }
})
