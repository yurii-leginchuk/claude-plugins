import { test } from 'node:test'
import assert from 'node:assert/strict'
import H1 from '../../src/rules/static/H1-lorem.js'
import H7 from '../../src/rules/static/H7-image-alt.js'
import J1 from '../../src/rules/static/J1-landmarks.js'
import G1 from '../../src/rules/static/G1-privacy-checkbox.js'
import G3 from '../../src/rules/static/G3-required-marker.js'
import G5 from '../../src/rules/static/G5-phone-input-type.js'
import S1 from '../../src/rules/static/S1-jsonld.js'

const base = {
  url: 'https://ex.com/a', text: '', images: [], forms: [], jsonLd: [],
  landmarks: { header: 1, main: 1, nav: 1 },
}
const p = (o) => ({ ...base, ...o })

test('H1 flags leftover lorem ipsum', () => {
  const f = H1.check(p({ text: 'Intro Lorem ipsum dolor sit amet more text' }), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('H1 ignores clean copy', () => {
  assert.deepEqual(H1.check(p({ text: 'Office cleaning in New York City' }), {}), [])
})

test('H7 flags an image with no alt attribute', () => {
  const f = H7.check(p({ images: [{ src: 'https://ex.com/i.jpg', alt: null, hasAlt: false, decorative: false, selector: 'img.hero' }] }), {})
  assert.equal(f.length, 1)
})

test('H7 accepts an explicitly decorative image', () => {
  const img = { src: 'https://ex.com/i.jpg', alt: '', hasAlt: true, decorative: true, selector: 'img' }
  assert.deepEqual(H7.check(p({ images: [img] }), {}), [])
})

test('J1 flags a missing header and main', () => {
  const f = J1.check(p({ landmarks: { header: 0, main: 0, nav: 1 } }), {})
  assert.equal(f.length, 2)
})

test('J1 accepts one header and one main', () => {
  assert.deepEqual(J1.check(p({}), {}), [])
})

test('J1 flags more than one main landmark', () => {
  const f = J1.check(p({ landmarks: { header: 1, main: 2, nav: 1 } }), {})
  assert.equal(f.length, 1)
  assert.match(f[0].found, /main/)
})

test('J1 does not flag multiple header landmarks (nested <header> in <article> is valid)', () => {
  assert.deepEqual(J1.check(p({ landmarks: { header: 2, main: 1, nav: 1 } }), {}), [])
})

test('G1 flags a gravity form without a privacy checkbox', () => {
  const f = G1.check(p({ forms: [{ id: 'gform_5', gravity: true, hasPrivacyCheckbox: false, fields: [] }] }), {})
  assert.equal(f.length, 1)
})

test('G1 ignores non-gravity forms', () => {
  assert.deepEqual(G1.check(p({ forms: [{ id: 'search', gravity: false, hasPrivacyCheckbox: false, fields: [] }] }), {}), [])
})

test('G3 flags a required field with no visible marker', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'text', required: true, markedRequired: false, selector: '.gfield-1' },
  ] }
  assert.equal(G3.check(p({ forms: [form] }), {}).length, 1)
})

test('G5 flags a phone field that is not type=tel', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'text', required: false, markedRequired: false, selector: '.gfield--type-phone' },
  ] }
  assert.equal(G5.check(p({ forms: [form] }), {}).length, 1)
})

test('G5 accepts type=tel', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'tel', required: false, markedRequired: false, selector: '.gfield--type-phone' },
  ] }
  assert.deepEqual(G5.check(p({ forms: [form] }), {}), [])
})

test('G5 findings are marked heuristic confidence (phone detection is inferred from a class name, not observed)', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'text', required: false, markedRequired: false, selector: '.gfield--type-phone' },
  ] }
  const f = G5.check(p({ forms: [form] }), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
})

test('S1 flags unparsable JSON-LD', () => {
  const f = S1.check(p({ jsonLd: [{ ok: false, error: 'Unexpected token', types: [] }] }), {})
  assert.equal(f.length, 1)
})

test('S1 accepts valid JSON-LD', () => {
  assert.deepEqual(S1.check(p({ jsonLd: [{ ok: true, error: null, types: ['LocalBusiness'] }] }), {}), [])
})
