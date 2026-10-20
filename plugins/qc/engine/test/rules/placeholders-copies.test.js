import { test } from 'node:test'
import assert from 'node:assert/strict'
import H6 from '../../src/rules/static/H6-placeholders.js'
import K17 from '../../src/rules/static/K17-service-author.js'
import I22 from '../../src/rules/static/I22-working-copies.js'
import E13 from '../../src/rules/static/E13-should-be-link.js'
import { listWpContent } from '../../src/crawl/wp.js'
import { parsePage } from '../../src/parse/page.js'

const O = 'https://ex.com'
const page = (path, html) => parsePage({ url: `${O}${path}`, html: `<html><head><title>T</title></head><body>${html}</body></html>` })

test('H6: placeholder images, copy-doc markers and schema placeholders, once each', () => {
  const p = page('/a/', `<main><img src="/up/gray-placeholder.png" alt="Opura logo"><img src="/x.png" alt="Generic gray circular placeholder icon">
    <img src="/x.png" alt="Generic gray circular placeholder icon"><p>Read the [LINK PLACEHOLDER] guide.</p><img src="/team.jpg" alt="Our team"></main>
    <script type="application/ld+json">{"@type":"LocalBusiness","address":{"streetAddress":"Insert Street Address Here"}}</script>`)
  const f = H6.check(p)
  assert.deepEqual(f.map(x => x.found), [
    'картинка-заглушка: файл gray-placeholder.png',
    'alt описывает заглушку: «Generic gray circular placeholder icon»',
    'заглушка в тексте: «[LINK PLACEHOLDER]»',
    'заглушка в schema: «Insert Street Address Here»',
  ])
  assert.equal(f[1].confidence, 'heuristic', 'the alt alone is not proof')
  assert.equal(f[2].severity, 'critical')
  assert.deepEqual(H6.check(page('/b/', '<main><p>Insert your card here? No, we bill monthly.</p><img src="/a.jpg" alt="Office"></main>')).map(x => x.found),
    ['заглушка в тексте: «Insert your card here»'], 'the marker shape is what counts')
})

test('K17: a post signed by PA Dev or admin, in the byline or the schema; a real author is fine', () => {
  const p = page('/blog/x/', `<main><a href="/author/pa-dev/">Author PA Dev</a></main>
    <script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"admin"}}</script>`)
  assert.deepEqual(K17.check(p).map(x => x.found), [
    'автор «PA Dev» — служебный аккаунт, а не человек',
    'автор «admin» в schema — служебный аккаунт, а не человек',
  ])
  assert.deepEqual(K17.check(page('/blog/y/', '<main><a href="/author/jane-roe/">Jane Roe</a></main>')), [])
})

test('I22: working copies WordPress publishes outside the sitemap, and links to copies', () => {
  const home = page('/', '<main><a href="/about/">About</a><a href="/services/office-dev/">Office</a><a href="/author/pa-dev/">PA Dev</a></main>')
  const site = {
    env: 'prod', pages: [home, page('/about/', '')],
    wpContent: [{ url: `${O}/about/`, title: 'About' }, { url: `${O}/locations/bronx-dev/`, title: 'Bronx - Site' },
      { url: `${O}/developers/`, title: 'Developers' }, { url: `${O}/old-town/`, title: 'Old Town' }],
  }
  const f = I22.check(home, site)
  assert.deepEqual(f.map(x => x.found), [
    'ссылка на рабочую копию /services/office-dev',
    'опубликована рабочая копия /locations/bronx-dev («Bronx - Site»), её нет в sitemap, но она открыта и индексируется',
  ])
  assert.deepEqual(I22.check(page('/about/', ''), site), [], 'site-level copies are reported once, on the home page')
  assert.equal(I22.check(home, { ...site, env: 'dev' })[0].severity, 'minor')
})

test('E13: a path typed into the copy, to an existing page and to none; slashes in prose are not paths', () => {
  const p = page('/locations/newark/', `<main><p>See our /services/car-dealership-cleaning/ page.</p>
    <p>See our /services/hospital-medical-cleaning/ page. Open 24/7, and/or on weekends.</p>
    <p><a href="/about/">/about/</a></p></main>`)
  const site = { pages: [p, page('/services/car-dealership-cleaning/', ''), page('/about/', '')] }
  assert.deepEqual(E13.check(p, site).map(x => x.found), [
    'путь /services/car-dealership-cleaning/ напечатан текстом, а не ссылкой',
    'путь /services/hospital-medical-cleaning/ напечатан текстом, и такой страницы на сайте нет',
  ])
})

test('listWpContent pages through the REST API and returns null when it is closed', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/wp/v2/types')) return { ok: true, headers: {}, body: JSON.stringify({ page: { rest_base: 'pages', rest_namespace: 'wp/v2' }, attachment: { rest_base: 'media', rest_namespace: 'wp/v2' }, locations: { rest_base: 'locations', rest_namespace: 'wp/v2' } }) }
    if (url.includes('/wp/v2/locations&')) return { ok: true, headers: {}, body: JSON.stringify([{ link: `${O}/locations/x-dev/`, slug: 'x-dev', title: { rendered: 'X' } }]) }
    if (url.includes('/wp/v2/pages&') && url.includes('&page=1&')) return { ok: true, headers: { 'x-wp-totalpages': '1' }, body: JSON.stringify([{ link: `${O}/a-dev/`, slug: 'a-dev', title: { rendered: 'A' } }]) }
    return { ok: true, headers: {}, body: '[]' }
  }
  assert.deepEqual(await listWpContent(O, { fetchImpl }), [
    { url: `${O}/a-dev/`, slug: 'a-dev', title: 'A', type: 'pages' },
    { url: `${O}/locations/x-dev/`, slug: 'x-dev', title: 'X', type: 'locations' },
  ])
  assert.ok(!calls.some(u => u.includes('/media&')), 'attachments are not pages')
  assert.equal(await listWpContent(O, { fetchImpl: async () => ({ ok: false, status: 401 }) }), null)
})
