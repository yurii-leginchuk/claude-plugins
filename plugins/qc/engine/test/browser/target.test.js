import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser } from '../../src/browser/launch.js'
import { locateSpot } from '../../src/browser/evidence.js'
import { targetOf } from '../../src/review.js'

test('a defect with a target is outlined at its target, not at the right text it quotes', async () => {
  const b = await launchBrowser()
  try {
    const page = await b.newPage()
    await page.setContent('<div class="card" id="good">To report to your company directly, see this list</div><div class="card" id="bad">To report to youReport all Worker’s Compensation Claims directly</div>')
    const t = targetOf('To report to youReport all Worker’s')
    const box = await page.evaluate(locateSpot, { sel: null, href: null, linkText: null, needles: [t.text], cores: [t.text] })
    assert.ok(box && !box.hidden)
    assert.equal(await page.evaluate(() => document.querySelector('[data-qc-ev]')?.id), 'bad')
  } finally { await b.browser.close() }
})

test('a target is text, a selector, or both; an empty one is none', () => {
  assert.deepEqual(targetOf(' x '), { text: 'x' })
  assert.deepEqual(targetOf({ selector: '#a', text: '' }), { selector: '#a' })
  assert.equal(targetOf({}), null)
})

test('several mistakes in one block: the block is the spot, each mistake is marked', async () => {
  const b = await launchBrowser()
  try {
    const page = await b.newPage()
    await page.setContent('<p id="t">Before we started doing buiness, our instance package was not up to par and needed help Mike jumped in and needed help.</p>')
    const box = await page.evaluate(locateSpot, { sel: null, href: null, linkText: null, needles: ['Before we started doing buiness'], cores: [], marks: ['buiness', 'instance', 'needed help Mike'] })
    assert.ok(box && !box.hidden)
    assert.equal(await page.evaluate(() => document.querySelector('[data-qc-ev]')?.id), 't')
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-qc-mark]')].map(m => m.textContent)), ['buiness', 'instance', 'needed help Mike'])
  } finally { await b.browser.close() }
})
