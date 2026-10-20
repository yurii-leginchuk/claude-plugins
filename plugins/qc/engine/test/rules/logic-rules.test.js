import { test } from 'node:test'
import assert from 'node:assert/strict'
import I18 from '../../src/rules/static/I18-internal-redirects.js'
import E2 from '../../src/rules/static/E2-link-text-consistency.js'
import F12 from '../../src/rules/static/F12-dead-anchors.js'
import H5 from '../../src/rules/static/H5-outdated-year.js'
import H10 from '../../src/rules/static/H10-chrome-consistency.js'
import E13 from '../../src/rules/static/E13-should-be-link.js'
import K14 from '../../src/rules/static/K14-blog-listing.js'
import K13 from '../../src/rules/static/K13-dev-vs-live.js'
import E14 from '../../src/rules/static/E14-orphan-pages.js'
import E15 from '../../src/rules/static/E15-extra-links.js'
import I20 from '../../src/rules/static/I20-schema-vs-page.js'
import I10 from '../../src/rules/static/I10-breadcrumbs.js'
import H12 from '../../src/rules/static/H12-foreign-location.js'
import { normalizeFacts } from '../../src/lib/facts.js'
import { parsePage } from '../../src/parse/page.js'

const O = 'https://ex.com'
const link = (href, text = '', o = {}) => ({
  raw: href, href: /^(#|tel:|mailto:)/.test(href) ? null : new URL(href, O).toString().split('#')[0],
  text, protocol: href.startsWith('tel:') ? 'tel:' : 'https:', internal: !/^https?:\/\/(?!ex\.com)/.test(href),
  region: 'main', selector: 'a', ...o,
})
const page = (path, o = {}) => ({
  url: `${O}${path}`, title: '', metaDescription: '', text: '', links: [], headings: [], jsonLdRaw: [],
  ids: [], bodyClass: '', published: null, breadcrumbs: null, footerText: '', headerText: '', ...o,
})
const facts = (o) => normalizeFacts(o, 'facts.json')

// --- parser -------------------------------------------------------------------

test('parsePage records link regions, chrome text, breadcrumbs, ids and the publish date', () => {
  const p = parsePage({ url: `${O}/blog/x/`, html: `<html><head>
    <meta property="article:published_time" content="2026-05-01T10:00:00+00:00"></head>
    <body class="post-template single-post"><header><nav><a href="/a/">A</a></nav><img src="/logo.png"></header>
    <div class="rank-math-breadcrumb"><a href="/">Home</a> › <a href="/blog/">Blog</a> › X</div>
    <main><h2 id="faq">FAQ</h2><a href="/b/">B</a></main>
    <footer><nav><a href="/c/">C</a></nav>© 2026 Ex</footer></body></html>` })
  assert.deepEqual(p.links.map(l => l.region), ['header', 'breadcrumbs', 'breadcrumbs', 'main', 'footer'])
  assert.equal(p.footerText, 'C© 2026 Ex')
  assert.equal(p.logo, `${O}/logo.png`)
  assert.deepEqual(p.breadcrumbs.items.map(i => i.text), ['Home', 'Blog'])
  assert.ok(p.ids.includes('faq'))
  assert.match(p.bodyClass, /single-post/)
  assert.equal(p.published, '2026-05-01T10:00:00+00:00')
})

// --- I18 ----------------------------------------------------------------------

test('I18 flags an internal link that lands through a redirect', () => {
  const p = page('/', { links: [link('/about'), link('/contact/')] })
  const linkStatus = new Map([
    [`${O}/about`, { ok: true, status: 200, finalUrl: `${O}/about/` }],
    [`${O}/contact/`, { ok: true, status: 200 }],
  ])
  const f = I18.check(p, { linkStatus })
  assert.equal(f.length, 1)
  assert.equal(f[0].found, `${O}/about → ${O}/about/`)
})

// --- E2 -----------------------------------------------------------------------

test('E2 flags the one page whose "Verify Insurance" goes elsewhere', () => {
  const pages = ['/1/', '/2/', '/3/', '/4/', '/5/'].map(p => page(p, { links: [link('/verify-insurance/', 'Verify Insurance'), link(`/x${p}`, 'Learn more')] }))
  pages.push(page('/6/', { links: [link('/contact/', 'Verify Insurance')] }))
  const site = { pages }
  assert.deepEqual(E2.check(pages[0], site), [])
  const f = E2.check(pages[5], site)
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
  assert.match(f[0].found, /«Verify Insurance» ведёт на \/contact, а на 5 других стр\. — на \/verify-insurance/)
})

// --- F12 ----------------------------------------------------------------------

test('F12 flags a same-page anchor with no target and a cross-page one', () => {
  const home = page('/', { ids: ['contact'] })
  const p = page('/about/', { ids: ['team'], links: [link('#team'), link('#contact', 'Contact'), link('/#contact'), link('/#missing'), link('#top'), link('#elementor-action%3Aaction%3Dpopup')] })
  const f = F12.check(p, { pages: [home, p] })
  assert.deepEqual(f.map(x => x.found), [
    'якорь #contact: на странице нет элемента с таким id',
    'ссылка /#missing: на странице / нет элемента #missing',
  ])
})

test('F12 leaves "#" in menus alone and only notes it in the body', () => {
  const p = page('/', { links: [link('#', 'Services', { region: 'nav' }), link('#', 'Get a quote')] })
  const f = F12.check(p, { pages: [p] })
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
})

// --- H5 -----------------------------------------------------------------------

test('H5 flags a stale copyright and a past year in a non-post title', () => {
  const now = Date.parse('2026-10-20')
  const p = page('/', { text: 'Footer © 2019-2025 Ex Inc.', title: 'Best Rehab in Texas 2025' })
  const f = H5.check(p, { now })
  assert.equal(f.length, 2)
  assert.equal(f[0].found, '© 2025 в копирайте')
  assert.equal(f[1].confidence, 'heuristic')
  assert.deepEqual(H5.check(page('/', { text: '© 2026 Ex' }), { now }), [])
  assert.equal(H5.check(page('/p/', { title: 'Recap 2024', isArticle: true }), { now }).length, 0)
  // Yoast's datePublished on every WebPage does not make a page a post.
  assert.equal(H5.check(page('/s/', { title: 'Services 2024', published: '2024-01-01' }), { now }).length, 1)
})

// --- H10 ----------------------------------------------------------------------

test('H10 flags the page whose footer kept old copy', () => {
  const ok = 'Contact 343 Forest Ave Portland Admissions Insurance'
  const pages = ['/1/', '/2/', '/3/', '/4/', '/5/'].map(p => page(p, { footerText: ok }))
  pages.push(page('/old/', { footerText: 'Contact 12 Old Street Portland Insurance' }))
  const f = H10.check(pages[5], { pages })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /Футер отличается от 5 других страниц \(нет: 343, forest, ave, admissions; лишнее: 12, old, street\)/)
  assert.deepEqual(H10.check(pages[0], { pages }), [])
})

// --- E13 ----------------------------------------------------------------------

test('E13 flags a visible phone with no tel: link, but not a fax', () => {
  const p = page('/', {
    text: 'Call (718) 969-0845 now. Header (718) 969-0845. Fax: (718) 555-0101',
    links: [link('tel:+17189690845', '(718) 969-0845')],
  })
  const f = E13.check(p, { pages: [p] })
  assert.equal(f.length, 1)
  assert.equal(f[0].occurrences, '1 из 2')
})

test('E13 flags an unlinked reviewer byline only on a site with author pages', () => {
  const p = page('/blog/x/', { text: 'Medically reviewed by Dr. Jane Roe, MD on May 1' })
  assert.deepEqual(E13.check(p, { pages: [p] }), [])
  const team = page('/', { links: [link('/team/john/', 'John')] })
  const f = E13.check(p, { pages: [p, team] })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /Dr\. Jane Roe/)
})

// --- K14 ----------------------------------------------------------------------

test('K14 flags a fresh post missing from the listing and a wrong order', () => {
  const post = (slug, date) => page(`/blog/${slug}/`, { bodyClass: 'single-post', published: date, title: slug })
  const posts = [post('newest', '2026-10-01'), post('mid', '2026-09-01'), post('old', '2026-08-01'), post('oldest', '2026-07-01')]
  const listing = page('/blog/', { bodyClass: 'blog', links: [link('/blog/old/'), link('/blog/mid/'), link('/blog/oldest/')] })
  const f = K14.check(listing, { pages: [listing, ...posts] })
  assert.match(f[0].found, /свежий пост не попал в листинг: «newest»/)
  assert.match(f.at(-1).found, /порядок постов не по дате: «mid»/)
})

// --- K13 ----------------------------------------------------------------------

test('K13 compares a dev page with its live page: menu, footer, schema, headings, missing pages', () => {
  const dev = page('/', {
    links: [link('/about/', 'About', { region: 'nav' }), link('/our-programs/', 'Programs', { region: 'nav' })],
    headings: [{ level: 1, text: 'Welcome' }], jsonLdRaw: ['{"@type":"WebPage"}'], title: 'Home',
  })
  const live = page('/', {
    url: 'https://live.com/',
    links: [
      link('https://live.com/about/', 'About', { region: 'nav', internal: true }),
      link('https://live.com/programs/', 'Programs', { region: 'nav', internal: true }),
      link('https://live.com/admissions/', 'Admissions', { region: 'nav', internal: true }),
      link('https://live.com/careers/', 'Careers', { region: 'footer', internal: true }),
    ],
    headings: [{ level: 1, text: 'Welcome' }, { level: 2, text: 'Our Team' }],
    jsonLdRaw: ['{"@graph":[{"@type":"WebPage"},{"@type":["MedicalClinic","LocalBusiness"]}]}'], title: 'Home',
  })
  const prod = {
    host: 'live.com', pairs: [{ dev: dev.url, prod: live.url, status: 200 }], pages: [live],
    missing: [{ prod: 'https://live.com/old-page/', dev: `${O}/old-page/`, status: 404 }],
  }
  const f = K13.check(dev, { env: 'dev', pages: [dev], prod })
  const found = f.map(x => x.found)
  assert.ok(found.includes('страница есть на лайве, на деве 404: /old-page'))
  assert.ok(found.includes('меню: пункт «Admissions» (/admissions) есть на лайве, нет на деве'))
  assert.ok(found.includes('футер: пункт «Careers» (/careers) есть на лайве, нет на деве'))
  assert.ok(found.includes('меню: «Programs» ведёт на /our-programs, на лайве — на /programs'))
  assert.ok(found.includes('schema MedicalClinic есть на лайве, нет на деве'))
  assert.ok(found.includes('schema LocalBusiness есть на лайве, нет на деве'))
  assert.ok(found.includes('заголовок H2 «Our Team» есть на лайве, нет на деве'))
  assert.equal(f.find(x => /Admissions/.test(x.found)).confidence, 'high')
  assert.deepEqual(K13.check(dev, { env: 'prod', pages: [dev], prod }), [])
})

// --- E14 ----------------------------------------------------------------------

test('E14 flags a sitemap page nothing links to, but not posts or the homepage', () => {
  const pages = ['/', '/a/', '/b/', '/c/', '/orphan/'].map(p => page(p))
  pages[0].links = [link('/a/'), link('/b/'), link('/c/')]
  pages.push(page('/blog/post/', { bodyClass: 'single-post', published: '2026-01-01' }))
  const site = { pages, source: 'sitemap' }
  assert.equal(E14.check(pages[4], site).length, 1)
  assert.deepEqual(E14.check(pages[0], site), [])
  assert.deepEqual(E14.check(pages[5], site), [])
  assert.deepEqual(E14.check(pages[4], { ...site, source: 'sheet:Pages' }), [])
})

// --- E15 ----------------------------------------------------------------------

test('E15 flags a self-link in the body, a linked date and exit links on a PPC landing page', () => {
  const p = page('/services/detox/', { links: [link('/services/detox/', 'Detox'), link('/services/detox/#faq', 'FAQ'), link('/2026/05/01/', 'May 1, 2026'), link('/services/detox/', 'Home', { region: 'nav' })] })
  assert.deepEqual(E15.check(p).map(f => f.found), [
    'ссылка на эту же страницу: «Detox»',
    `дата кликабельна: «May 1, 2026» → ${O}/2026/05/01/`,
  ])
  const lp = page('/lp/detox/', { links: [link('/about/', 'About', { region: 'header' }), link('tel:+17185550000', 'Call'), link('/privacy-policy/', 'Privacy'), link('/lp/thanks/', 'Thanks'), link('https://facebook.com/ex', 'FB')] })
  assert.deepEqual(E15.check(lp).map(f => f.found), [
    `ссылка уводит с PPC-лендинга: ${O}/about/`,
    'ссылка уводит с PPC-лендинга: https://facebook.com/ex',
  ])
})

// --- I20 ----------------------------------------------------------------------

test('I20 with facts: the schema address of a location page must be that location', () => {
  const f0 = facts({ gbp: [
    { url: 'https://maps.app.goo.gl/a', address: '343 Forest Ave, Portland, ME 04101', paths: ['/portland/'] },
    { url: 'https://maps.app.goo.gl/b', address: '12 Main Street, Bangor, ME 04401', paths: ['/bangor/'] },
  ] })
  const ld = '{"@type":"MedicalClinic","address":{"@type":"PostalAddress","streetAddress":"343 Forest Avenue"}}'
  assert.deepEqual(I20.check(page('/portland/', { jsonLdRaw: [ld] }), { facts: f0 }), [])
  const f = I20.check(page('/bangor/', { jsonLdRaw: [ld] }), { facts: f0 })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /не адрес этой локации/)
})

test('I20 without facts: schema data absent from the page, and a URL of another site', () => {
  const ld = '{"@type":"Organization","url":"https://floridahelps.com/","telephone":"(305) 555-0100","address":{"streetAddress":"1 Ocean Drive"},"sameAs":["https://facebook.com/x"]}'
  const p = page('/', { text: 'Visit 343 Forest Ave. Call (718) 969-0845', jsonLdRaw: [ld] })
  const f = I20.check(p, {})
  assert.deepEqual(f.map(x => x.found).sort(), [
    'schema ссылается на чужой сайт: floridahelps.com',
    'адрес из schema «1 Ocean Drive» не встречается на странице',
    'телефон из schema (305) 555-0100 не встречается на странице',
  ].sort())
  assert.ok(f.every(x => x.confidence === 'heuristic'))
})

// --- I10 ----------------------------------------------------------------------

test('I10 flags missing crumbs on a site that has them and a crumb outside the URL', () => {
  const crumbs = (items) => ({ text: '', items: items.map(([text, href]) => ({ text, href: `${O}${href}` })) })
  const pages = ['/a/', '/b/', '/c/', '/d/', '/e/'].map(p => page(p, { breadcrumbs: crumbs([['Home', '/']]) }))
  const bare = page('/f/')
  assert.equal(I10.check(bare, { pages: [...pages, bare] }).length, 1)
  const wrong = page('/programs/detox/', { breadcrumbs: crumbs([['Home', '/'], ['Services', '/services/']]) })
  const f = I10.check(wrong, { pages: [...pages, wrong] })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /«Services» ведёт на \/services, а страница лежит в \/programs\//)
  const right = page('/programs/detox/', { breadcrumbs: crumbs([['Home', '/'], ['Programs', '/programs/']]) })
  assert.deepEqual(I10.check(right, { pages: [...pages, right] }), [])
})

// --- H12 ----------------------------------------------------------------------

test('H12 flags another state on a page about one state', () => {
  const p = page('/', { title: 'Texas Helps', text: 'Rehab across Texas. Call Connecticut admissions. West Virginia too.' })
  const f = H12.check(p, {})
  assert.deepEqual(f.map(x => x.found).sort(), [
    'на странице про Texas упоминается Connecticut', 'на странице про Texas упоминается West Virginia',
  ])
  assert.deepEqual(H12.check(page('/', { text: 'Connecticut' }), {}), [], 'no own state, nothing to compare')
  const withFacts = H12.check(page('/', { text: 'Maine and Texas' }), { facts: facts({ states: ['Maine'], gbp: [{ url: 'https://maps.app.goo.gl/a', address: '1 Main St, Austin, TX 78701' }] }) })
  assert.deepEqual(withFacts, [])
})
