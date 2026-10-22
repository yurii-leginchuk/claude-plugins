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
  assert.equal(f.find(x => /in text/.test(x.found)).confidence, 'heuristic')
  assert.equal(f.find(x => /tel|not in the site facts: tel/.test(x.found) && !/in text/.test(x.found)).confidence, 'high')
})

test('stateOfAddress reads the state after the street line', () => {
  assert.equal(stateOfAddress('100 Georgia Ave, Silver Spring, Maryland'), 'Maryland')
  assert.equal(stateOfAddress('5806 Culebra Road, San Antonio, TX 78228'), 'Texas')
})

test('qc findings lists distinct defects with ids, qc review moves false positives out of the verdict', () => withCache(async () => {
  const { listFindings, applyReview, reviewedRun } = await import('../src/review.js')
  const { writeFileSync: write } = await import('node:fs')
  const out = await audit(base, { fresh: true })
  const listed = listFindings(host)
  assert.ok(listed.profile, 'the run carries the site profile')
  assert.ok(listed.defects.length > 0)
  const e4 = listed.defects.find(d => d.rule === 'E4')
  assert.match(e4.id, /^D\d+$/)
  const file = join(out.runDir, 'my-review.json')
  write(file, JSON.stringify({ summary: 'Test site', items: [{ id: e4.id, verdict: 'false-positive', note: 'the number is right' }] }))
  const res = applyReview(host, file)
  assert.equal(res.falsePositive, 1)
  const html = readFileSync(res.reportPath, 'utf8')
  // Rejected findings are left out of the report altogether.
  assert.doesNotMatch(html, /Rejected in Claude’s review/)
  assert.doesNotMatch(html, /the number is right/)
  assert.match(html, /About the site:/)
  assert.throws(() => { write(file, JSON.stringify({ items: [{ id: 'D999', verdict: 'confirmed' }] })); applyReview(host, file) }, /no defect D999/)

  // A heuristic confirmed by Claude counts as a defect.
  const heur = listed.defects.find(d => d.confidence === 'heuristic')
  if (heur) {
    write(file, JSON.stringify({ items: [{ id: heur.id, verdict: 'confirmed', note: 'checked in Playwright' }] }))
    const promoted = applyReview(host, file)
    const sum = (o) => o.critical + o.major + o.minor + o.note
    assert.equal(sum(promoted.distinct), sum(res.distinct) + 1 + 1, 'the rejected one counts again, the confirmed heuristic now counts')
  }
  // The mobile menu, checked by Claude in Playwright: screenshots are copied
  // next to the report, a defect counts, a bad rule id is refused.
  const shot = join(out.runDir, 'menu.png')
  write(shot, 'png')
  write(file, JSON.stringify({ items: [], manual: [
    { check: 'menu', page: 'https://ex.com/', width: 360, status: 'defect', checked: 'opens', shots: [shot],
      defects: [{ rule: 'C6', impact: 'broken', verified: 'reproduced', found: 'menu sticks out 40 px on the right', expected: 'within the screen' }] },
    { check: 'content', page: 'https://ex.com/', status: 'defect', checked: 'read 2 pages',
      defects: [{ rule: 'H16', impact: 'broken', verified: 'reproduced', found: 'quote time: “under an hour” and “within 48 hours”', expected: 'one time frame', pages: ['https://ex.com/', 'https://ex.com/b/'] }] },
    { check: 'journey', title: 'Book a cleaning from the home page', page: 'https://ex.com/', width: 360, status: 'defect', shots: [shot],
      steps: ['Opened the home page', 'Tapped «Get a Quote»', 'Filled the form with a wrong email and sent it'],
      defects: [
        { rule: 'G14', impact: 'blocker', verified: 'reproduced', found: 'the form jumps to the top after an error', expected: 'stays at the error' },
        { rule: 'K4', impact: 'broken', verified: 'not-reproduced', found: 'the popup did not open', expected: 'it opens' },
        { rule: 'C2', impact: 'cosmetic', verified: 'unable', found: 'the button label touches the edge', expected: 'padding' },
      ] },
    { check: 'visual', page: 'https://ex.com/b/', width: 1440, status: 'ok', checked: 'looked at the full page', shots: [shot] },
  ], menu: [{ page: 'https://ex.com/', width: 768, status: 'ok', checked: 'fine' }] }))
  const withManual = applyReview(host, file)
  assert.equal(withManual.manualChecked, 5, 'the older `menu` field is read too')
  assert.equal(withManual.manualDefects, 5, 'a content defect counts once per page it names; one the verifier could not repeat is dropped')
  assert.equal(withManual.notReproduced, 1)
  assert.deepEqual(withManual.journeys, [{ title: 'Book a cleaning from the home page', width: 360, status: 'defect' }])
  const journeyRun = reviewedRun(host)
  assert.equal(journeyRun.kept.find(x => x.rule === 'G14').severity, 'critical', 'a blocker is critical, from the table')
  assert.equal(journeyRun.kept.find(x => x.rule === 'C2' && x.engine === 'claude').confidence, 'heuristic', 'unverified either way: needs a look, does not count')
  assert.match(readFileSync(withManual.reportPath, 'utf8'), /<h2>Visitor journeys with problems<\/h2>[\s\S]*Book a cleaning from the home page[\s\S]*<ol class="steps"><li>Opened the home page/)
  assert.ok(readFileSync(join(out.runDir, 'visual', 'manual-0-0.png')))
  const manualHtml = readFileSync(withManual.reportPath, 'utf8')
  assert.match(manualHtml, /menu sticks out 40 px on the right/)
  const m1 = reviewedRun(host).kept.find(x => x.id === 'M1')
  assert.equal(m1.shot, join(out.runDir, 'visual', 'manual-0-0.png'), 'a manual defect carries its check screenshot, so the card and qc push show it')
  assert.match(manualHtml, /<b>Copy<\/b><span class="cnt">1 problem/)
  // Every defect carries the id `qc findings` gave it, manual ones M1…, and the report can find them.
  for (const d of listFindings(host).defects.filter(x => x.id !== e4.id && !x.verify && !x.judge)) assert.match(manualHtml, new RegExp(`id="${d.id}"`), d.id)
  assert.match(manualHtml, /<div class="defect" id="M1">|id="M1"/)
  assert.match(manualHtml, /id="qc-find"/)
  assert.match(manualHtml, /\/\^\[DM\]\\d\+\$\//, 'the id pattern survives escaping')
  assert.match(manualHtml, /<b>Menu<\/b><span class="cnt">1 problem/)
  assert.match(manualHtml, /<li><a href="https:\/\/ex\.com\/b\/"/, 'a content defect lists every page it names')
  const bad = (d, m = {}) => { write(file, JSON.stringify({ manual: [{ check: 'menu', page: 'https://ex.com/', width: 360, status: 'defect', shots: [shot], defects: [{ rule: 'C6', impact: 'broken', verified: 'reproduced', found: 'a', expected: 'b', ...d }], ...m }] })); applyReview(host, file) }
  assert.throws(() => bad({ rule: 'H16' }), /rule for menu must be one of/)
  assert.throws(() => bad({ impact: undefined, severity: 'major' }), /impact must be one of/)
  assert.throws(() => bad({ verified: undefined }), /verified must be/)
  assert.throws(() => bad({}, { shots: [] }), /needs its evidence: .*screenshot/)
  assert.throws(() => bad({}, { check: 'content', width: undefined, shots: [] }), /rule for content/)
  assert.throws(() => { write(file, JSON.stringify({ manual: [{ check: 'content', page: 'https://ex.com/', status: 'defect', defects: [{ rule: 'H16', impact: 'broken', verified: 'reproduced', found: 'two times differ', expected: 'one' }] }] })); applyReview(host, file) }, /quoted in found/)
  assert.throws(() => { write(file, JSON.stringify({ manual: [{ check: 'journey', page: 'https://ex.com/', width: 360, status: 'ok', title: 'Call' }] })); applyReview(host, file) }, /journey needs a title and its steps/)
  assert.throws(() => { write(file, JSON.stringify({ manual: [{ check: 'visual', page: 'https://ex.com/', width: 360, status: 'defect', shots: [shot], defects: [{ rule: 'Z99', impact: 'broken', verified: 'reproduced', found: 'a', expected: 'b' }] }] })); applyReview(host, file) }, /needs a title/)
  assert.throws(() => { write(file, JSON.stringify({ manual: [{ check: 'popup', page: 'https://ex.com/', status: 'ok' }] })); applyReview(host, file) }, /width is required/)
}))

test('scopeOf files chrome and near-every-page defects as global, one section as template', async () => {
  const { scopeOf } = await import('../src/report/html.js')
  const pages = (paths) => paths.map(p => `https://ex.com${p}`)
  assert.equal(scopeOf({ zones: new Set(['footer']), pages: pages(['/a/']) }, 10), 'global')
  assert.equal(scopeOf({ zones: new Set(), pages: pages(['/1/', '/2/', '/3/', '/4/', '/5/', '/6/', '/7/', '/8/']) }, 10), 'global')
  assert.equal(scopeOf({ zones: new Set(['main']), pages: pages(['/services/a/', '/services/b/']) }, 10), 'template:/services/')
  assert.equal(scopeOf({ zones: new Set(['main']), pages: pages(['/about/']) }, 10), 'page')
})

test('no false positives for Cloudflare email protection, thank-you orphans, archive self-links', async () => {
  const E1 = (await import('../src/rules/static/E1-broken-links.js')).default
  const E14 = (await import('../src/rules/static/E14-orphan-pages.js')).default
  const E15 = (await import('../src/rules/static/E15-extra-links.js')).default
  const cf = 'https://ex.com/cdn-cgi/l/email-protection'
  const p = { url: 'https://ex.com/', links: [{ raw: '/cdn-cgi/l/email-protection#ab', href: cf, internal: true }] }
  assert.deepEqual(E1.check(p, { linkStatus: new Map([[cf, { ok: false, status: 404 }]]) }), [])
  const pages = ['/', '/a/', '/b/', '/c/', '/thank-you/'].map(x => ({ url: `https://ex.com${x}`, links: [] }))
  assert.deepEqual(E14.check(pages[4], { pages, source: 'sitemap' }), [])
  const cat = { url: 'https://ex.com/category/tips/', links: [{ raw: '/category/tips/', href: 'https://ex.com/category/tips/', text: 'Tips', region: 'main' }] }
  assert.deepEqual(E15.check(cat), [])
})

test('E3: a Privacy Policy link inside a form must open in a new tab, not the other way round', async () => {
  const E3 = (await import('../src/rules/static/E3-target-blank.js')).default
  const p = parsePage({ url: 'https://ex.com/', html: `<body><form><label>I agree to <a href="/privacy-policy/" target="_blank">Privacy Policy</a></label></form>
    <form><label>I agree to <a href="/terms/">Terms</a></label></form><main><a href="/about/" target="_blank">About</a></main></body>` })
  const f = E3.check(p)
  assert.deepEqual(f.map(x => x.found), [
    'link “Terms” in a form opens in the same tab, so the filled-in form is lost',
    'internal page link opens in a new tab: /about/',
  ])
})

test('thank-you pages may share a title, description and H1', async () => {
  const I6 = (await import('../src/rules/static/I6-title.js')).default
  const I7 = (await import('../src/rules/static/I7-meta-description.js')).default
  const { buildIndex } = await import('../src/parse/index.js')
  const pg = (u) => ({ url: `https://ex.com${u}`, title: 'Thanks | Ex', metaDescription: 'We got it', headings: [], links: [] })
  const pages = [pg('/thank-you/'), pg('/contact/thank-you/')]
  const site = { pages, index: buildIndex(pages) }
  assert.deepEqual([...I6.check(pages[0], site), ...I7.check(pages[1], site)], [])
})

test('services and locations from facts replace menu and URL guessing in the profile', async () => {
  const { buildProfile } = await import('../src/lib/profile.js')
  const facts = normalizeFacts({ services: [{ name: 'Medical Detox', url: 'https://ex.com/detox-programs/' }, 'Family Program'], locations: ['Portland'] }, 'f.json')
  const pages = [{ url: 'https://ex.com/detox-programs/', headings: [{ level: 1, text: 'Detox' }], links: [] }]
  const p = buildProfile({ pages, facts })
  assert.deepEqual(p.services.items.map(i => i.name), ['Medical Detox', 'Family Program'])
  assert.deepEqual(p.services.paths, ['/detox-programs'])
  assert.equal(p.services.source, 'facts')
  assert.deepEqual(p.locations.items.map(i => i.name), ['Portland'])
})

test('page types from facts give the profile its services when no list is given', async () => {
  const { buildProfile } = await import('../src/lib/profile.js')
  const facts = normalizeFacts({ pages: { '/drug-rehab/': 'service', '/addiction-blog/x/': 'post' } }, 'f.json')
  const pages = [
    { url: 'https://ex.com/drug-rehab/', headings: [{ level: 1, text: 'Drug Rehab' }], links: [] },
    { url: 'https://ex.com/addiction-blog/x/', headings: [{ level: 1, text: 'X' }], links: [] },
  ]
  assert.deepEqual(buildProfile({ pages, facts }).services.items.map(i => i.name), ['Drug Rehab'])
  assert.throws(() => normalizeFacts({ pages: { '/a/': 'blogpost' } }, 'f.json'), /is not one of/)
})

test('a judgement candidate (H14) reaches the report only with Claude’s verdict', async () => {
  const { sortByReview, isJudged } = await import('../src/review.js')
  const { defectIdentity } = await import('../src/report/json.js')
  const { writeFileSync: write } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'qc-judged-'))
  try {
    const list = { rule: 'H14', title: 'List', severity: 'note', confidence: 'heuristic', selector: 'ul', found: 'list “Ingredients” has “kale”', page: 'https://ex.com/r/' }
    const og = { rule: 'H17', title: 'Brand', severity: 'minor', selector: 'meta', found: 'og:site_name = “Site”', page: 'https://ex.com/' }
    write(join(dir, 'distinct.json'), JSON.stringify([{ id: 'D1', identity: defectIdentity(list) }, { id: 'D2', identity: defectIdentity(og) }]))
    assert.equal(isJudged(og), false, 'og:site_name is a fact')
    const none = sortByReview(dir, [list, og], { items: [] })
    assert.deepEqual(none.kept.map(f => f.rule), ['H17'])
    assert.equal(none.unjudged, 1)
    const yes = sortByReview(dir, [list, og], { items: [{ id: 'D1', verdict: 'confirmed', note: 'the same insurers list' }] })
    assert.equal(yes.kept.find(f => f.rule === 'H14').confidence, 'high')
    const no = sortByReview(dir, [list, og], { items: [{ id: 'D1', verdict: 'false-positive', note: 'recipes differ' }] })
    assert.deepEqual(no.rejected.map(f => f.rule), ['H14'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('only measurements reach the report alone: clicks, console errors and heuristics wait for Claude', async () => {
  const { isCandidate } = await import('../src/review.js')
  assert.equal(isCandidate({ rule: 'X1', confidence: 'high' }), true)
  assert.equal(isCandidate({ rule: 'F12', confidence: 'high' }), true)
  assert.equal(isCandidate({ rule: 'E1', confidence: 'heuristic' }), true)
  assert.equal(isCandidate({ rule: 'E1', confidence: 'high' }), false, 'a 404 is measured')
  assert.equal(isCandidate({ rule: 'E4', confidence: 'high' }), false)
})

test('the browser pass takes every page but only the newest posts', async () => {
  const { browsePages } = await import('../src/lib/kinds.js')
  const post = (n, d) => ({ url: `https://ex.com/blog/${n}/`, isArticle: true, published: d })
  const pages = [{ url: 'https://ex.com/' }, post('old', '2024-01-01'), post('new', '2026-10-01'), post('mid', '2025-05-01'), { url: 'https://ex.com/services/a/' }]
  assert.deepEqual(browsePages(pages, 2), ['https://ex.com/', 'https://ex.com/blog/new/', 'https://ex.com/blog/mid/', 'https://ex.com/services/a/'])
  assert.equal(browsePages(pages, Infinity).length, 5)
})

test('the visual review says which screen pieces Claude looked at, and the report says how many were not', async () => {
  const { tileCoverage } = await import('../src/review.js')
  const { tileManifest } = await import('../src/cli.js')
  const { writeFileSync: write } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'qc-tiles-'))
  try {
    const f = (n) => { const p = join(dir, `t${n}.png`); write(p, 'png'); return { path: p, top: (n - 1) * 900, bottom: (n - 1) * 900 + 1000 } }
    const pages = [{ url: 'https://ex.com/' }, { url: 'https://ex.com/b/' }, { url: 'https://ex.com/old-post/' }]
    const rows = new Map([
      ['https://ex.com/', { shots: [{ width: 360, tiles: [f(1), f(2), f(3)] }, { width: 1440, tiles: [f(4)] }] }],
      ['https://ex.com/b/', { shots: [{ width: 360, tilesError: 'boom' }] }],
    ])
    const m = tileManifest(pages, new Set(['https://ex.com/', 'https://ex.com/b/']), rows, () => 'home')
    assert.deepEqual(m.tiles.map(t => t.id), ['T1', 'T2', 'T3', 'T4'])
    assert.deepEqual(m.missing.map(x => x.reason), ['boom'])
    write(join(dir, 'tiles.json'), JSON.stringify(m))
    const cov = tileCoverage(dir, { manual: [{ check: 'visual', tiles: ['T1-T3'] }] })
    assert.deepEqual([cov.total, cov.seen, cov.unseenPages, cov.missing], [4, 3, 1, 1])
    assert.match(cov.unseen[0], /^T4 https:\/\/ex\.com\/ 1440px/)
    assert.throws(() => tileCoverage(dir, { manual: [{ check: 'visual', tiles: ['page 1'] }] }), /not a tile id/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('custom post types count as posts per section, newest 10 of each; skipped sections are left out', async () => {
  const { browsePages } = await import('../src/lib/kinds.js')
  const e = (sec, n, d) => ({ url: `https://ex.com/${sec}/${n}/`, published: d })
  const pages = [{ url: 'https://ex.com/news/' }, e('news', 'a', '2026-01-01'), e('news', 'b', '2025-01-01'), e('letter', 'x', null), e('letter', 'y', null), e('jet-popup', 'form', null), e('meet-the-team', 'jo', '2026-02-01')]
  assert.deepEqual(browsePages(pages, 1, { postSections: ['news', 'letter'], skipSections: ['jet-popup'] }),
    ['https://ex.com/news/', 'https://ex.com/news/a/', 'https://ex.com/letter/x/', 'https://ex.com/meet-the-team/jo/'])
})

test('a piece shared by pages is one look; its defect lands on every page; the next run reuses the look', () => withCache(async () => {
  const { applyReview, reviewedRun, listTiles } = await import('../src/review.js')
  const { writeFileSync: write } = await import('node:fs')
  const out = await audit(base, { fresh: true })
  const png = (n) => { const p = join(out.runDir, `p${n}.png`); write(p, 'png'); return p }
  const tiles = [
    { id: 'T1', hash: 'aaa', page: 'https://ex.com/', type: 'home', width: 360, file: png(1), top: 900, bottom: 1500, kind: 'section', places: [{ page: 'https://ex.com/', top: 900, bottom: 1500 }, { page: 'https://ex.com/b/', top: 700, bottom: 1300 }] },
    { id: 'T2', hash: 'bbb', page: 'https://ex.com/', type: 'home', width: 360, file: png(2), top: 0, bottom: 900, kind: 'screen', places: [{ page: 'https://ex.com/', top: 0, bottom: 900 }] },
  ]
  write(join(out.runDir, 'tiles.json'), JSON.stringify({ tiles, missing: [] }))
  const listed = listTiles(host)
  assert.deepEqual(Object.keys(listed.byType).sort(), ['home', 'shared'])
  assert.equal(listed.byType.shared['on several pages'][0].pages, 2)
  const file = join(out.runDir, 'r.json')
  const defect = { tile: 'T1', rule: 'B9', title: 'No gap between an icon and its text', impact: 'cosmetic', verified: 'reproduced', found: 'the phone icon touches «Call»', expected: 'a gap' }
  write(file, JSON.stringify({ manual: [{ check: 'visual', page: 'https://ex.com/', width: 360, tiles: ['T1-T2'], status: 'defect', defects: [defect] }] }))
  const first = applyReview(host, file)
  assert.deepEqual([first.tiles.seen, first.tiles.total], [2, 2])
  const m = reviewedRun(host).kept.filter(f => f.rule === 'B9' && f.engine === 'claude')
  assert.deepEqual(m.map(f => f.page).sort(), ['https://ex.com/', 'https://ex.com/b/'])
  assert.match(m[0].shot, /visual\/tile-T1\.png$/)
  // the same pixels next time: nothing to look at, the defect carries over
  assert.equal(listTiles(host).toLook, 0)
  write(file, JSON.stringify({ manual: [] }))
  const again = applyReview(host, file)
  assert.deepEqual([again.tiles.seen, again.tiles.total], [2, 2])
  assert.equal(reviewedRun(host).kept.filter(f => f.rule === 'B9' && f.engine === 'claude').length, 2)
}))

test('qc quotes finds a content defect’s words on its page, Markdown and spacing aside', () => withCache(async () => {
  const { checkQuotes } = await import('../src/review.js')
  const { writeFileSync: write } = await import('node:fs')
  const out = await audit(base, { fresh: true })
  const file = join(out.runDir, 'q.json')
  write(file, JSON.stringify({ manual: [{ check: 'content', page: `${base}/a`, status: 'defect', defects: [{ rule: 'H3', found: 'the page says «# **Hello**…call» and «Goodbye»' }] }] }))
  const r = checkQuotes(host, file)
  assert.deepEqual(r.items.map(q => q.onAPage), [true, false])
  assert.equal(r.notFound, 1)
}))

test('a defect with a box gets its spot framed on its picture', () => withCache(async () => {
  const { applyReview, reviewedRun } = await import('../src/review.js')
  const { encodePng, decodePng } = await import('../src/browser/png.js')
  const { writeFileSync: write } = await import('node:fs')
  const out = await audit(base, { fresh: true })
  const shot = join(out.runDir, 'pic.png')
  write(shot, encodePng({ width: 40, height: 30, channels: 3, data: Buffer.alloc(40 * 30 * 3, 255) }))
  const file = join(out.runDir, 'r.json')
  write(file, JSON.stringify({ manual: [{ check: 'menu', page: 'https://ex.com/', width: 360, status: 'defect', shots: [shot],
    defects: [{ rule: 'C6', impact: 'broken', verified: 'reproduced', found: 'menu past the edge', expected: 'inside', box: { x: 10, y: 8, w: 12, h: 10 } }] }] }))
  applyReview(host, file)
  const m1 = reviewedRun(host).kept.find(f => f.id === 'M1')
  assert.match(m1.shot, /visual\/mark-0-M1\.png$/)
  const px = decodePng(readFileSync(m1.shot))
  const at = (x, y) => [...px.data.subarray((y * 40 + x) * 3, (y * 40 + x) * 3 + 3)]
  assert.deepEqual(at(6, 4), [224, 36, 94], 'the frame is drawn around the box')
  assert.deepEqual(at(16, 13), [255, 255, 255], 'inside the box is left as it was')
}))
