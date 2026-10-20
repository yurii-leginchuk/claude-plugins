import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import G13 from '../../src/rules/static/G13-form-options.js'
import E16 from '../../src/rules/static/E16-inventory.js'
import K16 from '../../src/rules/static/K16-sibling-blocks.js'
import { parsePage } from '../../src/parse/page.js'

const O = 'https://ex.com'
const link = (path, text, region = 'header') => ({ raw: path, href: `${O}${path}`, text, internal: true, region, selector: 'a' })
const page = (path, o = {}) => ({ url: `${O}${path}`, title: '', headings: [], links: [], forms: [], mapEmbeds: [], bodyClass: '', ...o })
const menu = [link('/services/detox/', 'Detox'), link('/services/residential/', 'Residential Rehab'), link('/services/iop/', 'Outpatient Program')]
const form = (options, id = 'gform_1') => ({ id, fields: [{ label: 'What service do you need?', options, selector: 'div.gfield' }] })

test('G13 on the real fixture: the form says Residential where the menu says Apartment & Home Cleaning', () => {
  const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
  const p = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })
  const f = G13.check(p, { pages: [p] })
  assert.deepEqual(f.map(x => x.found), [
    'form #gform_5: option “Residential” does not match the name: the service is called “Apartment & Home Cleaning” (/services/residential-cleaning)',
  ])
  assert.equal(f[0].confidence, 'heuristic')
  assert.equal(f[0].expected, 'rename the option to “Apartment & Home Cleaning”')
})

test('G13 names a missing service and an option no page matches, once per form', () => {
  const a = page('/', { links: menu, forms: [form(['Select one', 'Detox', 'Outpatient', 'Equine therapy'])] })
  const b = page('/contact/', { links: menu, forms: [form(['Detox', 'Outpatient', 'Equine therapy'])] })
  const site = { pages: [a, b] }
  assert.deepEqual(G13.check(a, site).map(x => x.found), [
    'form #gform_1: option “Equine therapy” matches no page (service)',
    'form #gform_1: the field has no option “Residential Rehab” (/services/residential)',
  ])
  assert.deepEqual(G13.check(b, site), [], 'the same form on a second page is not a second defect')
})

test('G13 compares a location field with the location pages', () => {
  const locs = [link('/locations/austin/', 'Austin'), link('/locations/dallas/', 'Dallas'), link('/locations/houston/', 'Houston')]
  const p = page('/', { links: locs, forms: [{ id: 'f', fields: [{ label: 'Preferred location', options: ['Austin', 'Dallas'], selector: 's' }] }] })
  assert.deepEqual(G13.check(p, { pages: [p] }).map(x => x.found), ['form #f: the field has no option “Houston” (/locations/houston)'])
})

test('E16 reports a service the footer or hub lacks, once, on the hub', () => {
  const footer = menu.slice(0, 2).map(l => ({ ...l, region: 'footer' })).concat(link('/services/other/', 'Other', 'footer'))
  const hub = page('/services/', { links: [...menu, ...footer, ...menu.map(l => ({ ...l, region: 'main' }))] })
  const home = page('/', { links: [...menu, ...footer] })
  const site = { pages: [home, hub] }
  const f = E16.check(hub, site).map(x => x.found)
  assert.ok(f.includes('service “Outpatient Program” (/services/iop) is in the menu, on page /services, but not in the footer'))
  assert.ok(f.includes('service “Other” (/services/other) is in the footer, but not in the menu'))
  assert.deepEqual(E16.check(home, site), [], 'site-wide defects sit on the hub only')
})

test('E16 on a sitemap run flags menu links and post links to pages outside the sitemap', () => {
  const dev = link('/services/detox-dev/', 'Detox')
  const home = page('/', { links: [dev, ...menu.slice(1)] })
  const post = page('/blog/x/', { bodyClass: 'single-post', links: [link('/services/old-service/', 'old', 'main')] })
  const pages = [home, post, page('/services/residential/'), page('/services/iop/')]
  const site = { pages, source: 'sitemap', linkStatus: new Map() }
  assert.ok(E16.check(home, site).some(x => x.found === 'link “Detox” in the menu points to /services/detox-dev, which is not in the sitemap'))
  assert.deepEqual(E16.check(post, site).map(x => x.found), ['post links to a service outside the sitemap: /services/old-service'])
  assert.ok(!E16.check(home, { ...site, source: 'sheet:Pages' }).some(x => /sitemap/.test(x.found)))
})

test('K16 flags the location page missing the map and the form its siblings have', () => {
  const loc = (slug, o = {}) => page(`/locations/${slug}/`, { mapEmbeds: ['m'], forms: [{ id: 'gform_2', fields: [] }], ...o })
  const pages = [loc('a'), loc('b'), loc('c'), loc('d'), loc('e', { mapEmbeds: [], forms: [{ id: 'gform_9', fields: [] }] })]
  const f = K16.check(pages[4], { pages })
  assert.deepEqual(f.map(x => x.found), [
    '4 of 5 pages in the section have a map, this one does not',
    '4 of 5 pages in the section use form #gform_2, this one uses another (#gform_9)',
  ])
  assert.deepEqual(K16.check(pages[0], { pages }), [])
})
