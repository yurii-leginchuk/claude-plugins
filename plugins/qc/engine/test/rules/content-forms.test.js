import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import H1 from '../../src/rules/static/H1-lorem.js'
import H7 from '../../src/rules/static/H7-image-alt.js'
import J1 from '../../src/rules/static/J1-landmarks.js'
import G1 from '../../src/rules/static/G1-privacy-checkbox.js'
import G3 from '../../src/rules/static/G3-required-marker.js'
import G5 from '../../src/rules/static/G5-phone-input-type.js'
import S1 from '../../src/rules/static/S1-jsonld.js'
import { parsePage } from '../../src/parse/page.js'

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
    { inputType: 'text', fieldType: 'phone', required: false, markedRequired: false, selector: '.gfield--type-phone' },
  ] }
  assert.equal(G5.check(p({ forms: [form] }), {}).length, 1)
})

test('G5 accepts type=tel', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'tel', fieldType: 'phone', required: false, markedRequired: false, selector: '.gfield--type-phone' },
  ] }
  assert.deepEqual(G5.check(p({ forms: [form] }), {}), [])
})

test('G5 findings use high confidence (fieldType is observed from a Gravity Forms class, not guessed)', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'text', fieldType: 'phone', required: false, markedRequired: false, selector: '.gfield--type-phone' },
  ] }
  const f = G5.check(p({ forms: [form] }), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'high')
})

// Regression test for the bug the reviewer found: the old implementation matched /phone/i
// against the field's *selector*, but selectorOf() prefers id over class, and real Gravity
// Forms fields always carry an id (e.g. `div#field_5_6`) that never contains the word
// "phone". Against the fixture's real selector shape, the old implementation silently
// returned zero findings for a genuinely broken phone field. This PageDoc mirrors that real
// shape (id-based selector, no "phone" substring) with `fieldType: 'phone'` set (as
// src/parse/page.js now parses it from the `gfield--type-phone` wrapper class) to prove
// detection is driven by the observed field type, not the selector string.
test('G5 flags a broken phone field even when the selector is id-based and contains no "phone" substring', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'text', fieldType: 'phone', required: true, markedRequired: true, selector: 'div#field_5_6' },
  ] }
  const f = G5.check(p({ forms: [form] }), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'type=text')
  assert.equal(f[0].expected, 'type="tel"')
  assert.equal(f[0].confidence, 'high')
})

test('G5 does not flag a non-phone field (fieldType: email) even with an id-based selector', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'text', fieldType: 'email', required: true, markedRequired: true, selector: 'div#field_5_5' },
  ] }
  assert.deepEqual(G5.check(p({ forms: [form] }), {}), [])
})

test('G5 against the real fixture: the phone field is type=tel and fieldType=phone, so G5 reports nothing', () => {
  const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
  const doc = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })
  const gf = doc.forms.find(f => f.gravity)
  assert.ok(gf, 'expected a gravity form in the fixture')
  const phoneField = gf.fields.find(f => f.fieldType === 'phone')
  assert.ok(phoneField, 'expected a field with fieldType "phone" in the fixture')
  assert.equal(phoneField.inputType, 'tel')
  assert.deepEqual(G5.check(p({ forms: [gf] }), {}), [])
})

test('S1 flags unparsable JSON-LD', () => {
  const f = S1.check(p({ jsonLd: [{ ok: false, error: 'Unexpected token', types: [] }] }), {})
  assert.equal(f.length, 1)
})

test('S1 accepts valid JSON-LD', () => {
  assert.deepEqual(S1.check(p({ jsonLd: [{ ok: true, error: null, types: ['LocalBusiness'] }] }), {}), [])
})

// ---------------------------------------------------------------------------
// Review follow-up (Critical 3): H1 scans `page.text` as if it were copy. When
// `page.text` still carried <script> source, a theme's demo payload -- a very
// common thing to ship inside an inline JS config -- produced a Critical on a
// page whose visible copy is clean. Drive this through parsePage, not a
// hand-built literal: the literal is exactly what hid the bug.
// ---------------------------------------------------------------------------

test('H1 does not fire on Lorem ipsum that lives only inside inline script/style/template source', () => {
  const page = parsePage({
    url: 'https://ex.com/a',
    html: `<html><body><h1>Office cleaning</h1><p>Professional office cleaning in New York.</p>
      <script>window.themeDemo = {"placeholder":"Lorem ipsum dolor sit amet, consectetur adipiscing elit"};</script>
      <style>.demo::after{content:"Lorem ipsum"}</style>
      <template><p>Lorem ipsum dolor sit amet</p></template>
      </body></html>`,
  })
  assert.deepEqual(H1.check(page, {}), [], 'Lorem ipsum in machine payload is not remaining placeholder copy')
})

test('H1 still fires on Lorem ipsum in real body copy', () => {
  const page = parsePage({
    url: 'https://ex.com/a',
    html: '<html><body><h1>Services</h1><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p></body></html>',
  })
  const f = H1.check(page, {})
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('H1 never emits script or style source in its `found` window', () => {
  const page = parsePage({
    url: 'https://ex.com/a',
    html: `<html><body><script>var admin = {"email":"admin@secret.example"};</script>
      <p>Lorem ipsum dolor sit amet.</p></body></html>`,
  })
  const f = H1.check(page, {})
  assert.equal(f.length, 1)
  assert.doesNotMatch(f[0].found, /admin@secret\.example/, 'findings must never carry page internals')
  assert.doesNotMatch(f[0].found, /var admin/)
})

test('H1 reports nothing on the committed real fixture (its copy is clean)', () => {
  const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
  const doc = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })
  assert.deepEqual(H1.check(doc, {}), [])
})
