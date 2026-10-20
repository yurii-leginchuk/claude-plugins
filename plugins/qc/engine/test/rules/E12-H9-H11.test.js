import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import E12 from '../../src/rules/static/E12-phone-consistency.js'
import H9 from '../../src/rules/static/H9-banned-terms.js'
import H11 from '../../src/rules/static/H11-business-data.js'
import { normalizeFacts, loadFacts } from '../../src/lib/facts.js'
import { phoneKey, textPhones } from '../../src/lib/phone.js'
import { buildIndex } from '../../src/parse/index.js'
import { parsePage } from '../../src/parse/page.js'

const tel = (raw) => ({ raw, href: raw, protocol: 'tel:', selector: 'a.tel' })
const page = (o = {}) => ({
  url: 'https://ex.com/a', title: '', metaDescription: '', text: '', links: [], jsonLdRaw: [], ...o,
})
const facts = (o) => normalizeFacts(o, 'facts.json')

test('phoneKey collapses formatting and a missing leading 1', () => {
  assert.equal(phoneKey('tel:+1 (718) 969-0845'), '17189690845')
  assert.equal(phoneKey('718.969.0845'), '17189690845')
  assert.equal(phoneKey('tel:'), null)
  assert.equal(phoneKey('tel:(855)%20607-8758'), '18556078758')
  assert.equal(phoneKey('tel:%20(855)%20607-8758'), '18556078758')
})

test('textPhones needs separators and ignores bare digit runs', () => {
  assert.deepEqual(textPhones('Call (718) 969-0845 or 800-555-1234').map(p => p.key), ['17189690845', '18005551234'])
  assert.deepEqual(textPhones('Order 7189690845 shipped'), [])
})

// E12, facts mode
test('E12 flags a tel: link that is not one of the site numbers', () => {
  const f = E12.check(page({ links: [tel('tel:+18005550000')] }), { facts: facts({ phones: ['+1 718 969 0845'] }) })
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'high')
})

test('E12 accepts the site number in any format, in links, text and schema', () => {
  const p = page({
    links: [tel('tel:7189690845')],
    text: 'Call us at (718) 969-0845',
    jsonLdRaw: ['{"telephone":"+1-718-969-0845"}'],
  })
  assert.deepEqual(E12.check(p, { facts: facts({ phones: ['+17189690845'] }) }), [])
})

test('E12 finds an old number left only in schema', () => {
  const p = page({ jsonLdRaw: ['{"@type":"Organization","telephone":"(212) 555-0101"}'] })
  const f = E12.check(p, { facts: facts({ phones: ['+17189690845'] }) })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /schema/)
})

test('E12 skips pages under an ignored path', () => {
  const p = page({ url: 'https://ex.com/press/old/', links: [tel('tel:+18005550000')] })
  assert.deepEqual(E12.check(p, { facts: facts({ phones: ['+17189690845'], ignore: ['/press/'] }) }), [])
})

// E12, site-consistency mode
function siteWith(pagesPhones) {
  const pages = pagesPhones.map((raw, i) => page({ url: `https://ex.com/p${i}`, links: [tel(raw)] }))
  return { pages, site: { index: buildIndex(pages), facts: null } }
}

test('E12 without facts flags a number used on one page while the rest share another, as heuristic', () => {
  const { pages, site } = siteWith(['tel:+17189690845', 'tel:+17189690845', 'tel:+17189690845', 'tel:+17189690845', 'tel:+12125550101'])
  const f = E12.check(pages[4], site)
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
  assert.deepEqual(E12.check(pages[0], site), [])
})

test('E12 without facts stays silent when no number has a real majority', () => {
  const { pages, site } = siteWith(['tel:+17189690845', 'tel:+12125550101'])
  assert.deepEqual(E12.check(pages[1], site), [])
})

// H9
test('H9 is silent without banned terms', () => {
  assert.deepEqual(H9.check(page({ text: 'Equine therapy' }), { facts: null }), [])
})

test('H9 finds a retired term in copy and schema, whole word, any case', () => {
  const p = page({ text: 'We offer EQUINE therapy and yoga.', jsonLdRaw: ['{"name":"Equine Therapy"}'] })
  const f = H9.check(p, { facts: facts({ banned: [{ term: 'equine', note: 'услуга убрана' }] }) })
  assert.equal(f.length, 2)
  assert.equal(f[0].expected, 'убрать: услуга убрана')
})

test('H9 keeps the hit count out of found, so a shared menu stays one distinct defect', () => {
  const site = { facts: facts({ banned: ['Boston'] }) }
  const a = H9.check(page({ url: 'https://ex.com/a', text: 'Menu Boston Clinics.' + 'x'.repeat(80) + ' Boston once.' }), site)
  const b = H9.check(page({ url: 'https://ex.com/b', text: 'Menu Boston Clinics.' + 'x'.repeat(80) + ' Boston, Boston, Boston.' }), site)
  assert.equal(a[0].found, b[0].found)
  assert.equal(b[0].occurrences, 4)
})

test('H9 does not match a term inside another word', () => {
  const p = page({ text: 'Bostonian architecture' })
  assert.deepEqual(H9.check(p, { facts: facts({ banned: ['Boston'] }) }), [])
})

// H11
test('H11 flags an email that is not in facts, in mailto and in text', () => {
  const p = page({
    links: [{ raw: 'mailto:old@ex.com', protocol: 'mailto:', selector: 'a' }],
    text: 'Write to info@ex.com or old@ex.com, logo@2x.png',
  })
  const f = H11.check(p, { facts: facts({ emails: ['info@ex.com'] }) })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /old@ex\.com/)
})

test('H11 compares the aggregate rating in schema, not individual reviews', () => {
  const p = page({ jsonLdRaw: ['{"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.6"},"review":[{"reviewRating":{"ratingValue":"5"}}]}'] })
  const f = H11.check(p, { facts: facts({ rating: 4.7 }) })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /4\.6/)
  assert.equal(f[0].confidence, 'high')
})

test('H11 reads a rating from copy only next to rating words, as heuristic', () => {
  const p = page({ text: 'Rated 4.6 on Google. Prices from 4.6 dollars.' })
  const f = H11.check(p, { facts: facts({ rating: 4.7 }) })
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
  assert.deepEqual(H11.check(p, { facts: facts({ rating: 4.6 }) }), [])
})

// facts loading
test('normalizeFacts rejects a malformed file with the field named', () => {
  assert.throws(() => facts({ phones: 'x' }), /phones/)
  assert.throws(() => facts({ emails: ['not-an-email'] }), /email/)
  assert.throws(() => facts({ rating: 7 }), /rating/)
})

test('loadFacts: missing default file is null, missing explicit file throws, bad JSON throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qc-facts-'))
  process.env.QC_FACTS_DIR = dir
  assert.equal(loadFacts('ex.com'), null)
  assert.throws(() => loadFacts('ex.com', join(dir, 'nope.json')), /не найден/)
  writeFileSync(join(dir, 'ex.com.json'), '{ broken')
  assert.throws(() => loadFacts('ex.com'), /JSON/)
  writeFileSync(join(dir, 'ex.com.json'), JSON.stringify({ phones: ['+17189690845'], banned: ['Boston'] }))
  assert.equal(loadFacts('ex.com').banned[0].term, 'Boston')
  delete process.env.QC_FACTS_DIR
})

test('parsePage keeps raw JSON-LD for the business-data rules', () => {
  const p = parsePage({ url: 'https://ex.com/', html: '<html><body><script type="application/ld+json">{"telephone":"+17189690845"}</script></body></html>' })
  assert.equal(p.jsonLdRaw.length, 1)
  assert.match(p.jsonLdRaw[0], /telephone/)
})
