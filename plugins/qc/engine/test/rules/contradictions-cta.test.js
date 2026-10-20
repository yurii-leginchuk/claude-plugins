import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import H16 from '../../src/rules/static/H16-contradictions.js'
import E17 from '../../src/rules/static/E17-cta-promise.js'
import { parsePage } from '../../src/parse/page.js'

const O = 'https://ex.com'
const page = (path, o = {}) => ({
  url: `${O}${path}`, title: '', text: '', links: [], headings: [], jsonLdRaw: [], forms: [], headerText: '', footerText: '', ...o,
})
const link = (raw, text, o = {}) => ({
  raw, text, href: /^(tel|mailto):/.test(raw) ? null : new URL(raw, O).toString(),
  protocol: raw.startsWith('tel:') ? 'tel:' : raw.startsWith('mailto:') ? 'mailto:' : 'https:',
  internal: !/^https?:\/\/(?!ex\.com)/.test(raw), region: 'main', selector: 'a', ...o,
})
const NOW = Date.parse('2026-10-20')

test('H16: years of experience disagree with "since"', () => {
  const pages = [
    page('/a/', { text: 'We have over 20 years of experience in rehab.' }),
    page('/b/', { text: 'Proudly serving Maine since 2006.' }),
    page('/c/', { text: 'We bring 15 years of experience. Matt has worked in rehab since 1990.' }),
  ]
  const site = { pages, now: NOW }
  assert.deepEqual(H16.check(pages[0], site), [])
  assert.deepEqual(H16.check(pages[1], site), [])
  const f = H16.check(pages[2], site)
  assert.equal(f.length, 1)
  assert.match(f[0].found, /«15 years of experience» \(≈15 лет\)/)
  assert.equal(f[0].confidence, 'heuristic')
})

test('H16: "N services" against the service pages', () => {
  const svc = ['a', 'b', 'c', 'd'].map(s => page(`/services/${s}/`, { headings: [{ level: 1, text: `Service ${s}` }] }))
  const home = page('/', { text: 'We offer 12 services across NYC.' })
  const f = H16.check(home, { pages: [home, ...svc], now: NOW })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /«12 services», а страниц в разделе services: 4/)
})

test('H16: 24/7 against office hours, reported on the rarer side', () => {
  const pages = [
    page('/a/', { text: 'Call us 24/7. Residential rehab with 24/7 support.' }),
    page('/b/', { text: 'Office hours Mon–Fri 8am–6pm.' }),
    page('/c/', { jsonLdRaw: ['{"openingHours":"Mo-Fr 08:00-18:00"}'] }),
  ]
  const site = { pages, now: NOW }
  assert.equal(H16.check(pages[0], site).length, 1)
  assert.deepEqual(H16.check(pages[1], site), [])
})

test('H16: one service, two prices; one person, two titles', () => {
  const svc = page('/services/deep-clean/', { headings: [{ level: 1, text: 'Deep Clean' }], text: 'Deep Clean from $199 per visit.' })
  const other = page('/pricing/', { text: 'Deep Clean starting at $149. Jane Roe, Clinical Director leads.' })
  const team = page('/team/', { text: 'Jane Roe, Program Manager' })
  const team2 = page('/about/', { text: 'Jane Roe – Program Manager' })
  const site = { pages: [svc, other, team, team2], now: NOW }
  const f = H16.check(other, site)
  assert.ok(f.some(x => /Jane Roe — «Clinical Director»/.test(x.found)))
  assert.ok(f.some(x => /цена «Deep Clean»/.test(x.found)) || H16.check(svc, site).some(x => /цена/.test(x.found)))
})

test('E17: CTA text that does not do what it says', () => {
  const contact = page('/contact/', { forms: [{ id: 'f' }] })
  const about = page('/about/')
  const p = page('/x/', {
    links: [
      link('/contact/', 'Call Now'),
      link('tel:+17185550000', 'Call Now'),
      link('/about/', 'Book an appointment'),
      link('/contact/', 'Schedule a visit'),
      link('https://calendly.com/x', 'Book online'),
      link('/locations/', 'Get Directions'),
      link('https://maps.app.goo.gl/x', 'Get Directions'),
      link('/menu/', 'Download menu'),
      link('/sitemap/', 'Site Map'),
      link('/cdn-cgi/l/email-protection#5d32', '[email\u00a0protected]'),
      link('/services/emergency/', 'On-call emergency cleanup'),
    ],
  })
  const found = E17.check(p, { pages: [contact, about, p] }).map(f => f.found)
  assert.deepEqual(found, [
    '«Call Now» не звонит, а ведёт на /contact/',
    '«Book an appointment» ведёт на /about, а там нет формы записи',
    '«Get Directions» не открывает карту, а ведёт на /locations/',
    '«Download menu» обещает файл, а ведёт на страницу /menu/',
  ])
})

test('E17: "see our X page" when there is no such page', () => {
  const pricing = page('/pricing/', { title: 'Pricing | Ex' })
  const p = page('/x/', { text: 'Please see our pricing page or visit our careers page for jobs.' })
  const f = E17.check(p, { pages: [pricing, p] })
  assert.deepEqual(f.map(x => x.found), ['текст отсылает к странице «careers», такой страницы нет'])
})

test('both rules stay silent on the real fixture page', () => {
  const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
  const p = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })
  const site = { pages: [p], now: NOW }
  assert.deepEqual(H16.check(p, site), [])
  assert.deepEqual(E17.check(p, site), [])
})
