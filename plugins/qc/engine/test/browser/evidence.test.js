import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { serveFixtures } from './harness.js'
import { launchBrowser } from '../../src/browser/launch.js'
import { needles, cores, locateSpot } from '../../src/browser/evidence.js'

let srv, b, page
before(async () => { srv = await serveFixtures(); b = await launchBrowser(); page = await b.newPage(); await page.goto(`${srv.base}/evidence.html`) })
after(async () => { await b?.browser.close(); srv?.close() })

test('needles put the words around the spot first', () => {
  const f = { found: 'phone +1 718 969 0845 in text without a tel: link', where: 'content · under heading “FAQ” · …a quote? Call +1 718 969 0845 or request a quote online…' }
  const n = needles(f)
  assert.match(n[0], /Call \+1 718 969 0845 or request/)
  assert.ok(n.includes('+1 718 969 0845'))
})

test('the bare number is found, not the tel: button with the same number', async () => {
  const f = { found: 'phone +1 718 969 0845 in text without a tel: link', where: 'content · under heading “FAQ” · …a quote? Call +1 718 969 0845 or request a quote online…' }
  const box = await page.evaluate(locateSpot, { sel: null, href: null, needles: needles(f) })
  assert.ok(box, 'located')
  assert.equal(await page.evaluate(() => document.querySelector('[data-qc-ev]').id), 'faq')
  await page.evaluate(() => { const e = document.querySelector('[data-qc-ev]'); e.removeAttribute('style'); e.removeAttribute('data-qc-ev') })
})

test('a link is found by its href, an image by its alt', async () => {
  let box = await page.evaluate(locateSpot, { sel: null, href: '/services/office-cleaning/', needles: [] })
  assert.equal(box.how, 'href')
  await page.evaluate(() => document.querySelector('[data-qc-ev]').removeAttribute('data-qc-ev'))
  box = await page.evaluate(locateSpot, { sel: null, href: null, needles: needles({ found: 'alt describes a placeholder: “Generic gray placeholder”' }) })
  assert.match(box.how, /^image/)
})

test('a link is found by the URL in found when there is no href hint', async () => {
  await page.evaluate(() => { const e = document.querySelector('[data-qc-ev]'); if (e) e.removeAttribute('data-qc-ev') })
  const url = new URL('/services/office-cleaning/', page.url()).href
  const box = await page.evaluate(locateSpot, { sel: null, href: null, needles: needles({ found: `internal link with target=_blank: ${url}` }) })
  assert.equal(box.how, 'link url')
})

test('of two links with the same href the one with the finding’s link text is outlined', async () => {
  await page.evaluate(() => document.querySelectorAll('[data-qc-ev]').forEach(e => { e.removeAttribute('style'); e.removeAttribute('data-qc-ev') }))
  const box = await page.evaluate(locateSpot, { sel: 'a.elementor-button', href: '#', linkText: 'Get a Quote Now', needles: [] })
  assert.ok(box && !box.hidden)
  assert.equal(await page.evaluate(() => document.querySelector('[data-qc-ev]').textContent), 'Get a Quote Now')
})

test('a hidden image is reported hidden, not replaced by another one', async () => {
  await page.evaluate(() => document.querySelectorAll('[data-qc-ev]').forEach(e => { e.removeAttribute('style'); e.removeAttribute('data-qc-ev') }))
  const box = await page.evaluate(locateSpot, { sel: 'img', href: null, needles: needles({ found: 'alt describes a placeholder: “Generic gray circular placeholder icon”' }) })
  assert.match(box.hidden, /hidden/)
})

test('“should be a link” never picks a number inside a link, and outlines the number itself', async () => {
  await page.evaluate(() => document.querySelectorAll('[data-qc-ev]').forEach(e => { e.removeAttribute('style'); e.removeAttribute('data-qc-ev') }))
  const f = { found: 'phone +1 718 969 0845 in text without a tel: link' }
  const box = await page.evaluate(locateSpot, { sel: null, href: null, needles: needles(f), cores: cores(f), notInLinks: true })
  assert.ok(box && !box.hidden)
  assert.equal(await page.evaluate(() => document.querySelector('[data-qc-ev]').closest('a')), null)
  assert.equal(await page.evaluate(() => document.querySelector('[data-qc-ev]').closest('p').id), 'faq')
})
