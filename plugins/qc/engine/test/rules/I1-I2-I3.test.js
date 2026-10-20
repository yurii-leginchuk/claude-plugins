import { test } from 'node:test'
import assert from 'node:assert/strict'
import I1 from '../../src/rules/static/I1-h1-count.js'
import I2 from '../../src/rules/static/I2-heading-hierarchy.js'
import I3 from '../../src/rules/static/I3-h1-image.js'

const h = (level, text = 'x', imageOnly = false) => ({ level, text, imageOnly, selector: `h${level}` })
const page = (headings) => ({ url: 'https://ex.com/a', headings })

test('I1 flags a missing h1', () => {
  const f = I1.check(page([h(2)]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'H1 not found')
})

test('I1 flags multiple h1', () => {
  const f = I1.check(page([h(1), h(1)]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'H1 on the page: 2')
})

test('I1 accepts exactly one h1', () => {
  assert.deepEqual(I1.check(page([h(1), h(2)]), {}), [])
})

test('I2 flags a skipped level', () => {
  const f = I2.check(page([h(1), h(2), h(4)]), {})
  assert.equal(f.length, 1)
  assert.match(f[0].found, /h2 → h4/)
})

test('I2 accepts a clean hierarchy and allows going back up', () => {
  assert.deepEqual(I2.check(page([h(1), h(2), h(3), h(2), h(3)]), {}), [])
})

test('I3 flags an h1 that only contains an image', () => {
  const f = I3.check(page([h(1, '', true)]), {})
  assert.equal(f.length, 1)
})

test('I3 accepts a text h1', () => {
  assert.deepEqual(I3.check(page([h(1, 'Office Cleaning')]), {}), [])
})

test('I1 reports missing H1 when page has no headings at all', () => {
  const f = I1.check(page([]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'H1 not found')
})

test('I2 handles page with no headings without crashing', () => {
  const f = I2.check(page([]), {})
  assert.deepEqual(f, [])
})
