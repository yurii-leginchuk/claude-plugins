// plugins/qc/engine/test/rules/E3-E5-E6.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import E3 from '../../src/rules/static/E3-target-blank.js'
import E5 from '../../src/rules/static/E5-duplicate-plus-one.js'
import E6 from '../../src/rules/static/E6-mailto-and-bare-contacts.js'

const link = (o) => ({
  raw: '', href: null, protocol: null, rel: null, target: null,
  text: '', internal: false, selector: 'a', ...o,
})
const page = (links, text = '') => ({ url: 'https://ex.com/a', links, text })

test('E3 flags an internal link opening in a new tab at major/high -- the agency house rule, a real defect', () => {
  const f = E3.check(page([link({ raw: '/about', href: 'https://ex.com/about', internal: true, target: '_blank' })]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'E3')
  assert.equal(f[0].severity, 'major')
  assert.equal(f[0].confidence, 'high')
})

test('E3 flags an external link without target=_blank at minor/heuristic -- new-tab-or-not is a style preference', () => {
  const f = E3.check(page([link({ raw: 'https://out.com/x', href: 'https://out.com/x', internal: false })]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'minor')
  assert.equal(f[0].confidence, 'heuristic')
})

test('E3 flags an external target=_blank link missing rel=noopener at minor/high -- hygiene, not a live vuln since browsers imply noopener', () => {
  const f = E3.check(page([link({ raw: 'https://out.com/x', href: 'https://out.com/x', internal: false, target: '_blank' })]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'minor')
  assert.equal(f[0].confidence, 'high')
  assert.match(f[0].found, /без rel=noopener/)
})

test('E3 accepts a correct external link', () => {
  const ok = link({ raw: 'https://out.com/x', href: 'https://out.com/x', internal: false, target: '_blank', rel: 'noopener noreferrer' })
  assert.deepEqual(E3.check(page([ok]), {}), [])
})

test('E3 accepts a plain internal link', () => {
  const ok = link({ raw: '/about', href: 'https://ex.com/about', internal: true })
  assert.deepEqual(E3.check(page([ok]), {}), [])
})

test('E5 flags a duplicated country code', () => {
  const f = E5.check(page([link({ raw: 'tel:+1+17189690845', protocol: 'tel:' })]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'E5')
})

test('E5 flags an 11-digit number that repeats the leading 1', () => {
  const f = E5.check(page([link({ raw: 'tel:+117189690845', protocol: 'tel:' })]), {})
  assert.equal(f.length, 1)
})

test('E5 accepts a normal number', () => {
  assert.deepEqual(E5.check(page([link({ raw: 'tel:+17189690845', protocol: 'tel:' })]), {}), [])
})

test('E6 flags mailto with target=_blank', () => {
  const f = E6.check(page([link({ raw: 'mailto:a@b.com', protocol: 'mailto:', target: '_blank' })]), {})
  assert.ok(f.some(x => x.found.includes('_blank')))
})

test('E6 flags an email present in text but never linked', () => {
  const f = E6.check(page([], 'Write to us at hello@opura.com any time'), {})
  assert.ok(f.some(x => x.found === 'hello@opura.com'))
})

test('E6 does not flag an email that is linked', () => {
  const p = page([link({ raw: 'mailto:hello@opura.com', protocol: 'mailto:' })], 'Write to hello@opura.com')
  assert.deepEqual(E6.check(p, {}).filter(x => x.found === 'hello@opura.com'), [])
})

test('E6 does not flag file extensions matching email pattern (png)', () => {
  const f = E6.check(page([], 'See logo@2x.png for details'), {})
  assert.equal(f.filter(x => x.found === 'logo@2x.png').length, 0)
})

test('E6 does not flag file extensions matching email pattern (jpg)', () => {
  const f = E6.check(page([], 'Check background@3x.jpg'), {})
  assert.equal(f.filter(x => x.found === 'background@3x.jpg').length, 0)
})

test('E6 flags genuine email even when filenames appear on same page', () => {
  const f = E6.check(page([], 'See logo@2x.png and email support@example.com'), {})
  assert.ok(f.some(x => x.found === 'support@example.com'))
})

test('E6 flags addresses with domain keywords (not just extension match)', () => {
  const f = E6.check(page([], 'Contact press@jsfoundation.org'), {})
  assert.ok(f.some(x => x.found === 'press@jsfoundation.org'))
})
