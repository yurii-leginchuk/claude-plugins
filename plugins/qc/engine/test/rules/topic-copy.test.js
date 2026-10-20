import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import I21 from '../../src/rules/static/I21-page-topic.js'
import H12 from '../../src/rules/static/H12-foreign-location.js'
import H14 from '../../src/rules/static/H14-list-consistency.js'
import H17 from '../../src/rules/static/H17-brand-name.js'
import { parsePage } from '../../src/parse/page.js'

const O = 'https://ex.com'
const page = (path, o = {}) => ({
  url: `${O}${path}`, title: '', metaDescription: '', text: '', links: [], headings: [], images: [],
  lists: [], forms: [], headerText: '', footerText: '', siteName: null, ...o,
})
const h1 = (text) => [{ level: 1, text }]

test('I21 flags a page whose H1 and title are about something else than its URL', () => {
  const copied = page('/services/carpet-cleaning/', { headings: h1('Floor Polishing'), title: 'Floor Polishing NYC | Opura' })
  const f = I21.check(copied, { pages: [copied] })
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
  assert.match(f[0].found, /page \/services\/carpet-cleaning\/ has H1 “Floor Polishing”/)
  const ok = page('/services/carpet-cleaning/', { headings: h1('Carpet Cleaning in NYC'), title: 'x' })
  assert.deepEqual(I21.check(ok, { pages: [ok] }), [])
  const titleOnly = page('/services/carpet-cleaning/', { headings: h1('Fresh Floors'), title: 'Carpet Cleaning | Opura' })
  assert.deepEqual(I21.check(titleOnly, { pages: [titleOnly] }), [], 'the title carries the slug')
  const faq = page('/admissions/faq/', { headings: h1('Frequently Asked Questions') })
  assert.deepEqual(I21.check(faq, { pages: [faq] }), [], 'an acronym slug')
})

test('I21 flags the same H1 on two pages, not on paginated archives', () => {
  const a = page('/a/', { headings: h1('Our Services') })
  const b = page('/b/', { headings: h1('Our Services') })
  const p2 = page('/blog/page/2/', { headings: h1('Blog') })
  const p1 = page('/blog/', { headings: h1('Blog') })
  const site = { pages: [a, b, p1, p2] }
  assert.equal(I21.check(a, site).filter(f => /same H1/.test(f.found)).length, 1)
  assert.deepEqual(I21.check(p1, site).filter(f => /same H1/.test(f.found)), [])
})

test('H12 flags another location on a location page: copy, title, alt; not a link or a list', () => {
  const loc = (slug, o = {}) => page(`/locations/${slug}/`, { headings: h1(`Cleaning in ${slug}`), ...o })
  const bronx = loc('bronx', {
    title: 'Office Cleaning Brooklyn | Opura',
    text: 'We clean offices across the Bronx. Our Brooklyn crew arrives fast. Staten Island',
    links: [{ text: 'Staten Island', href: `${O}/locations/staten-island/` }],
    images: [{ alt: 'Brooklyn office', selector: 'img', src: `${O}/up/office-300x200.jpg` }, { alt: 'Manhattan skyline', selector: 'img', src: `${O}/up/sky.jpg` }],
  })
  const pages = [bronx, loc('brooklyn', { images: [{ alt: 'Brooklyn office', src: `${O}/up/office.jpg` }] }), loc('staten-island'), loc('manhattan')]
  const found = H12.check(bronx, { pages }).map(f => f.found)
  assert.ok(found.some(f => /^title of page .* mentions “Brooklyn”/.test(f)))
  assert.ok(found.includes('image from page “Brooklyn” together with its alt: “Brooklyn office”'))
  assert.ok(!found.some(f => /skyline/.test(f)), 'a photo used only here is description')
  assert.ok(found.includes('page “Cleaning in bronx” mentions “Brooklyn”'))
  assert.ok(!found.some(f => /Staten Island/.test(f)), 'a link to another location is navigation')

  const areas = loc('manhattan', { text: 'We also serve Brooklyn, Staten Island and the Bronx.' })
  assert.deepEqual(H12.check(areas, { pages: [areas, ...pages.slice(0, 3)] }), [], 'three other places is an areas list')
})

test('H14 flags an item most pages list and this one misses, and an item only this page has', () => {
  const list = (items) => [{ heading: 'Insurances We Accept', region: 'main', items }]
  const full = ['Aetna', 'Cigna', 'Humana', 'MaineCare']
  const pages = ['/a/', '/b/', '/c/'].map(p => page(p, { lists: list(full) }))
  pages.push(page('/d/', { lists: list(['Aetna', 'Cigna', 'Humana', 'Tricare']) }))
  const f = H14.check(pages[3], { pages })
  assert.deepEqual(f.map(x => x.found), [
    'list “Insurances We Accept” is missing “MaineCare”, though it is on 3 of 4 pages',
    'list “Insurances We Accept” has “Tricare”, which the other 3 pages do not have',
  ])
  assert.equal(f[1].severity, 'note')
  assert.deepEqual(H14.check(pages[0], { pages }), [])
})

test('H14 leaves alone lists that only share a heading (recipes)', () => {
  const list = (items) => [{ heading: 'Ingredients', region: 'main', items }]
  const pages = [['1 scoop', 'banana', 'mango'], ['1 scoop', 'kale', 'ginger'], ['1 scoop', 'cherries', 'milk']].map((it, i) => page(`/r${i}/`, { lists: list(it) }))
  for (const p of pages) assert.deepEqual(H14.check(p, { pages }), [])
})

test('H17 flags a placeholder og:site_name on the homepage and an ALL-CAPS brand once', () => {
  const home = page('/', { siteName: 'Site', title: 'Home | Opura', text: 'Why Choose Opura For Office Cleaning. OPURA is here.' })
  const a = page('/a/', { title: 'A | Opura', text: 'Opura Professional Cleaning Services. OPURA again. liberty. Opura’s team. Opura Opura' })
  const site = { pages: [home, a] }
  assert.deepEqual(H17.check(home, site).map(f => f.found), [
    'og:site_name = “Site”',
    'brand is written as “OPURA”, the main spelling is “Opura”',
  ])
  // The brand plus what the business does is the same name.
  assert.deepEqual(H17.check(a, site).map(f => f.found), [])
})

test('on the real fixture page (a single service page) the four rules stay silent', () => {
  const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
  const p = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })
  const site = { pages: [p] }
  for (const r of [I21, H12, H14, H17]) assert.deepEqual(r.check(p, site), [], r.id)
})

test('H12: a featured image captioned for another location is reported from schema; src-less images never match', async () => {
  const { default: H12x } = await import('../../src/rules/static/H12-foreign-location.js')
  const mk = (slug, o = {}) => ({ url: `https://ex.com/locations/${slug}/`, title: '', metaDescription: '', text: '', links: [], headings: [{ level: 1, text: slug }], images: [], jsonLdRaw: [], ...o })
  const brooklyn = mk('brooklyn', { images: [{ alt: 'Brooklyn Bridge', src: '', selector: 'img' }] })
  const bronx = mk('bronx', {
    images: [{ alt: 'Brooklyn Bridge at dusk', src: '', selector: 'img' }],
    jsonLdRaw: ['{"@type":"ImageObject","caption":"Brooklyn Bridge at dusk with Manhattan skyline"}'],
  })
  const f = H12x.check(bronx, { pages: [brooklyn, bronx, mk('manhattan'), mk('queens')] })
  assert.ok(f.every(x => !/together with its alt/.test(x.found)), 'an image without src is not "the same picture"')
  assert.ok(f.some(x => /featured image/.test(x.found) && /Brooklyn/.test(x.found)))
})
