import { test } from 'node:test'
import assert from 'node:assert/strict'
import E9 from '../../src/rules/static/E9-gbp-links.js'
import { normalizeFacts } from '../../src/lib/facts.js'
import { classifyGoogleLink, placeKey, embedKey, resolveGbpLinks, gbpTargets } from '../../src/lib/gbp.js'
import { parsePage } from '../../src/parse/page.js'

const BRIGHTON = 'https://www.google.com/maps/place/BAART+Programs+Brighton/@39.98,-104.82,17z/data=!3m1!4b1!4m6!3m5!1s0x876c6d71d3f5f03d:0xd9a4e2765e1dbc0b!8m2'
const BRIGHTON_CID = BigInt('0xd9a4e2765e1dbc0b').toString()
const OTHER = 'https://www.google.com/maps/place/Other/data=!4m2!3m1!1s0x876c6d71d3f5f03d:0x1111111111111111'
const SHORT = 'https://maps.app.goo.gl/kV6b8jGcAc5xs63E9'

const link = (raw, text = '') => ({ raw, href: raw.split('#')[0], text, protocol: 'https:', selector: 'a.map' })
const page = (o = {}) => ({ url: 'https://ex.com/a/', text: '', links: [], mapEmbeds: [], ...o })
const facts = (o) => normalizeFacts(o, 'facts.json')
const site = (o = {}) => ({ pages: [], gbp: new Map(), facts: null, ...o })

test('classifyGoogleLink tells profiles from searches and map pins', () => {
  assert.equal(classifyGoogleLink(SHORT), 'short')
  assert.equal(classifyGoogleLink('https://goo.gl/maps/abc'), 'short')
  assert.equal(classifyGoogleLink('https://g.page/baart-brighton'), 'legacy')
  assert.equal(classifyGoogleLink(BRIGHTON), 'profile')
  assert.equal(classifyGoogleLink('https://maps.google.com/?cid=123456'), 'profile')
  assert.equal(classifyGoogleLink('https://www.google.com/search?q=baart#lrd=0x876c6d71d3f5f03d:0xd9a4e2765e1dbc0b,1'), 'profile')
  assert.equal(classifyGoogleLink('https://www.google.com/maps/place/BAART+Brighton/'), 'place')
  assert.equal(classifyGoogleLink('https://www.google.com/maps/search/?api=1&query=5806+Culebra+Rd'), 'search')
  assert.equal(classifyGoogleLink('https://maps.google.com/?q=5806+Culebra+Road'), 'search')
  assert.equal(classifyGoogleLink('https://www.google.com/search?q=BAART+Sioux+Falls'), 'search')
  assert.equal(classifyGoogleLink('https://www.google.com/maps/dir//5806+Culebra'), 'dir')
  assert.equal(classifyGoogleLink('https://www.google.com/about/'), null)
  assert.equal(classifyGoogleLink('https://ex.com/maps/'), null)
})

test('placeKey reduces every profile form to the same CID', () => {
  assert.equal(placeKey(BRIGHTON), BRIGHTON_CID)
  assert.equal(placeKey(`https://maps.google.com/?cid=${BRIGHTON_CID}`), BRIGHTON_CID)
  assert.equal(placeKey('https://www.google.com/search?q=x#lrd=0x876c6d71d3f5f03d:0xd9a4e2765e1dbc0b,1,,,'), BRIGHTON_CID)
  assert.equal(embedKey('https://www.google.com/maps/embed?pb=!1m18!3m17!1s0x876c6d71d3f5f03d%3A0xd9a4e2765e1dbc0b!2sBAART'), BRIGHTON_CID)
})

test('E9 flags a link to a Google search or a map pin instead of the profile', () => {
  const p = page({ links: [link('https://www.google.com/maps/search/?api=1&query=5806+Culebra+Rd', 'Directions')] })
  const f = E9.check(p, site())
  assert.equal(f.length, 1)
  assert.match(f[0].found, /an address on the map, not to the GBP profile/)
  assert.equal(f[0].confidence, 'high')
})

test('E9 leaves directions links alone', () => {
  assert.deepEqual(E9.check(page({ links: [link('https://www.google.com/maps/dir//5806+Culebra')] }), site()), [])
})

test('E9 flags g.page as a redirect hop and a short link that opens nothing', () => {
  const gbp = new Map([[SHORT, { url: SHORT, status: 404, key: null }]])
  const f = E9.check(page({ links: [link('https://g.page/old'), link(SHORT)] }), site({ gbp }))
  assert.equal(f.length, 2)
  assert.equal(f[0].severity, 'minor')
  assert.equal(f[1].severity, 'critical')
})

test('E9 with facts: a short link resolving to another profile is a defect, the right one is not', () => {
  const f0 = facts({ gbp: [{ name: 'Brighton', url: BRIGHTON }] })
  const right = new Map([[SHORT, { url: SHORT, status: 302, key: BRIGHTON_CID }]])
  assert.deepEqual(E9.check(page({ links: [link(SHORT)] }), site({ facts: f0, gbp: right })), [])
  const wrong = new Map([[SHORT, { url: SHORT, status: 302, key: '42', name: 'BAART Duplicate' }]])
  const f = E9.check(page({ links: [link(SHORT)] }), site({ facts: f0, gbp: wrong }))
  assert.equal(f.length, 1)
  assert.match(f[0].found, /a profile not in the facts \(BAART Duplicate\)/)
})

test('E9 with facts: a location page must link its own location', () => {
  const f0 = facts({ gbp: [
    { name: 'Brighton', url: BRIGHTON, paths: ['/locations/brighton/'] },
    { name: 'Other', url: OTHER, paths: ['/locations/other/'] },
  ] })
  const p = page({ url: 'https://ex.com/locations/brighton/', links: [link(OTHER)] })
  const f = E9.check(p, site({ facts: f0 }))
  assert.equal(f.length, 1)
  assert.match(f[0].found, /location page “Brighton” points to the profile of another location “Other”/)
  assert.equal(f[0].expected, BRIGHTON)
  // Off any location page, both profiles are fine.
  assert.deepEqual(E9.check(page({ links: [link(OTHER), link(BRIGHTON)] }), site({ facts: f0 })), [])
})

test('E9 with facts: a map embed showing another place', () => {
  const f0 = facts({ gbp: [{ url: BRIGHTON }] })
  const p = page({ mapEmbeds: ['https://www.google.com/maps/embed?pb=!1s0x876c6d71d3f5f03d%3A0x2222!2sX'] })
  assert.equal(E9.check(p, site({ facts: f0 })).length, 1)
})

test('E9 with facts: the listed address must be a link wherever it appears', () => {
  const f0 = facts({ gbp: [{ url: BRIGHTON, address: '5806 Culebra Road, San Antonio, TX 78228' }] })
  const p = page({
    text: 'Visit us at 5806 Culebra Rd. San Antonio. Footer: 5806 Culebra Road, San Antonio',
    links: [link(BRIGHTON, '5806 Culebra Road, San Antonio')],
  })
  const f = E9.check(p, site({ facts: f0 }))
  assert.equal(f.length, 1, 'Rd and Road are the same street')
  assert.equal(f[0].found, 'address “5806 Culebra Road” is not clickable')
  assert.equal(f[0].confidence, 'high')
  assert.equal(f[0].occurrences, '1 of 2 mentions without a link')
})

test('E9 flags an address linked somewhere other than GBP', () => {
  const f0 = facts({ gbp: [{ url: BRIGHTON, address: '5806 Culebra Road, San Antonio' }] })
  const p = page({ text: '5806 Culebra Road', links: [{ ...link('https://ex.com/contact/', '5806 Culebra Road'), protocol: 'https:' }] })
  const f = E9.check(p, site({ facts: f0 }))
  assert.equal(f.length, 1)
  assert.match(f[0].found, /does not point to GBP: https:\/\/ex\.com\/contact\//)
})

test('E9 without facts: an unlinked address is only heuristic', () => {
  const f = E9.check(page({ text: 'Our clinic at 120 Main Street is open daily' }), site())
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
})

test('E9 without facts: the same address opening different profiles across pages', () => {
  const a = (url, raw) => page({ url, links: [link(raw, '5806 Culebra Road')] })
  const pages = [a('https://ex.com/1/', BRIGHTON), a('https://ex.com/2/', BRIGHTON), a('https://ex.com/3/', OTHER)]
  const s = site({ pages })
  assert.deepEqual(E9.check(pages[0], s), [])
  const f = E9.check(pages[2], s)
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
})

test('E9 skips pages the facts file ignores', () => {
  const f0 = facts({ gbp: [{ url: BRIGHTON }], ignore: ['/old/'] })
  const p = page({ url: 'https://ex.com/old/x/', links: [link('https://www.google.com/search?q=x')] })
  assert.deepEqual(E9.check(p, site({ facts: f0 })), [])
})

test('facts.gbp rejects a link that is not Google Maps', () => {
  assert.throws(() => facts({ gbp: ['https://ex.com/contact/'] }), /не похоже на ссылку Google Maps/)
  assert.deepEqual(facts({ gbp: [SHORT] }).gbp, [{ name: null, url: SHORT, address: null, paths: [] }])
})

test('resolveGbpLinks follows the 302 to the place URL and reuses known results', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return { status: 302, headers: new Map([['location', BRIGHTON]]), body: null }
  }
  const known = new Map([['https://maps.app.goo.gl/known', { key: '1' }]])
  const r = await resolveGbpLinks([SHORT, 'https://maps.app.goo.gl/known'], { known, fetchImpl })
  assert.deepEqual(calls, [SHORT])
  assert.equal(r.get(SHORT).key, BRIGHTON_CID)
  assert.equal(r.get(SHORT).name, 'BAART Programs Brighton')
})

test('parsePage records Google map iframes and gbpTargets collects short links', () => {
  const p = parsePage({
    url: 'https://ex.com/',
    html: `<body><a href="${SHORT}">map</a><a href="https://g.page/x">old</a>
      <iframe src="https://www.google.com/maps/embed?pb=!1s0x1:0x2"></iframe><iframe src="https://youtube.com/x"></iframe></body>`,
  })
  assert.equal(p.mapEmbeds.length, 1)
  assert.deepEqual(gbpTargets([p], null).sort(), ['https://g.page/x', SHORT].sort())
})

test('placeKey takes the place, not the building a place URL names first (!5s before !1s)', () => {
  const url = 'https://www.google.com/maps/place/Liberty+Bay/@43.66,-70.27,654m/data=!3m2!1e3!5s0x4cb29c7452800921:0xd8d4f3bc44e61a24!4m6!3m5!1s0x4cb29b9bc2827059:0x802d5c9d2bc93eff!8m2'
  assert.equal(placeKey(url), BigInt('0x802d5c9d2bc93eff').toString())
})

test('g.page/r/…/review is the current review link, not a retired g.page', () => {
  assert.equal(classifyGoogleLink('https://g.page/r/Cf8-ySudXC2AEBM/review'), 'short')
})

test('resolveGbpLinks re-derives a cached CID from finalUrl instead of trusting it', async () => {
  const known = new Map([[SHORT, { url: SHORT, status: 302, finalUrl: BRIGHTON, key: 'stale' }]])
  const r = await resolveGbpLinks([SHORT], { known, fetchImpl: async () => { throw new Error('no network') } })
  assert.equal(r.get(SHORT).key, BRIGHTON_CID)
})
