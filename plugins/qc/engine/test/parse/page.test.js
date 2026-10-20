import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePage } from '../../src/parse/page.js'

const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
const doc = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })

test('extracts canonical', () => {
  assert.equal(doc.canonical, 'https://cleaningny.com/services/office-cleaning/')
})

test('resolves index,follow from an explicit robots meta directive', () => {
  // The fixture actually carries an explicit `<meta name="robots" content="index, follow, ...">`
  // (see test/fixtures/opura-office-cleaning.html), so this only proves that explicit
  // "index, follow" resolves to true/true — it does NOT exercise the no-meta default path.
  // The true default (no robots meta at all) is covered separately below.
  assert.equal(doc.robots.raw, 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1')
  assert.equal(doc.robots.index, true)
  assert.equal(doc.robots.follow, true)
})

test('defaults to index,follow when no robots meta is present at all', () => {
  const noMeta = parsePage({ url: 'https://example.com/', html: '<html><head><title>t</title></head><body></body></html>' })
  assert.equal(noMeta.robots.raw, null)
  assert.equal(noMeta.robots.index, true)
  assert.equal(noMeta.robots.follow, true)
})

test('treats content="none" as both noindex and nofollow', () => {
  const doc2 = parsePage({ url: 'https://example.com/', html: '<html><head><meta name="robots" content="none"></head><body></body></html>' })
  assert.equal(doc2.robots.index, false)
  assert.equal(doc2.robots.follow, false)
})

test('treats content="noindex" as noindex only', () => {
  const doc2 = parsePage({ url: 'https://example.com/', html: '<html><head><meta name="robots" content="noindex"></head><body></body></html>' })
  assert.equal(doc2.robots.index, false)
  assert.equal(doc2.robots.follow, true)
})

test('treats content="nofollow" as nofollow only', () => {
  const doc2 = parsePage({ url: 'https://example.com/', html: '<html><head><meta name="robots" content="nofollow"></head><body></body></html>' })
  assert.equal(doc2.robots.index, true)
  assert.equal(doc2.robots.follow, false)
})

test('treats content="index, follow" as index and follow', () => {
  const doc2 = parsePage({ url: 'https://example.com/', html: '<html><head><meta name="robots" content="index, follow"></head><body></body></html>' })
  assert.equal(doc2.robots.index, true)
  assert.equal(doc2.robots.follow, true)
})

test('finds exactly one h1', () => {
  assert.equal(doc.headings.filter(h => h.level === 1).length, 1)
})

test('classifies internal and external links', () => {
  assert.ok(doc.links.length > 10)
  assert.ok(doc.links.some(l => l.internal === true))
  assert.ok(doc.links.some(l => l.internal === false))
  assert.ok(doc.links.every(l => typeof l.selector === 'string'))
  const fb = doc.links.find(l => l.href === 'https://www.facebook.com/people/Opura/61587544013134/')
  assert.ok(fb, 'expected the Facebook profile link from the fixture')
  assert.equal(fb.internal, false)
})

test('captures tel links with their raw href', () => {
  const tel = doc.links.filter(l => l.protocol === 'tel:')
  assert.ok(tel.length >= 1)
  assert.equal(tel[0].raw, 'tel:+17189690845')
})

test('detects the Gravity form and its fields', () => {
  assert.ok(doc.forms.length >= 1)
  const gf = doc.forms.find(f => f.gravity)
  assert.ok(gf, 'expected a gravity form')
  assert.ok(gf.fields.length > 0)
})

test('parses fieldType from the gfield--type-<x> wrapper class, observed rather than inferred from the selector', () => {
  const gf = doc.forms.find(f => f.gravity)
  const phone = gf.fields.find(f => f.fieldType === 'phone')
  assert.ok(phone, 'expected a field with fieldType "phone"')
  assert.equal(phone.inputType, 'tel')
  // The real selector never contains the word "phone" — it's id-based, per selectorOf()'s
  // preference for id over class. This is exactly why G5 cannot key off the selector string.
  assert.doesNotMatch(phone.selector, /phone/i)

  const email = gf.fields.find(f => f.fieldType === 'email')
  assert.ok(email, 'expected a field with fieldType "email"')

  const noType = doc2FieldWithoutTypeClass()
  assert.equal(noType.fieldType, null)
})

function doc2FieldWithoutTypeClass() {
  const html = '<html><body><form id="gform_9" class="gform_wrapper"><div class="gfield"><input type="text"></div></form></body></html>'
  const d = parsePage({ url: 'https://example.com/', html })
  return d.forms[0].fields[0]
}

test('records elementor container ids and locations', () => {
  assert.ok(doc.elementor.containerIds.includes('3374'))
  assert.ok(doc.elementor.locations.includes('header'))
  assert.ok(doc.elementor.locations.includes('footer'))
})

// The fixture page carries both elementor-location-header and
// elementor-location-footer, so containerIds/locations alone can't say which
// id is the header and which is the footer. locationsById pairs them from
// the same element's class list, which is what proveRegions (Task 6) needs
// to name shared regions correctly instead of falling back to bare ids.
test('pairs each container id with its own location class', () => {
  assert.equal(doc.elementor.locationsById['3374'], 'header')
  assert.equal(doc.elementor.locationsById['3381'], 'footer')
})

test('builds a widget skeleton that ignores text', () => {
  assert.match(doc.elementor.skeleton, /heading\.default/)
  assert.doesNotMatch(doc.elementor.skeleton, /Office Cleaning Services/)
})

test('parses images and alt presence', () => {
  assert.ok(doc.images.length > 0)
  assert.ok(doc.images.every(i => typeof i.hasAlt === 'boolean'))
})

test('distinguishes decorative alt="" from a missing alt attribute', () => {
  const doc2 = parsePage({
    url: 'https://example.com/',
    html: '<html><body><img id="deco" src="a.png" alt=""><img id="missing" src="b.png"></body></html>',
  })
  const deco = doc2.images.find(i => i.selector === 'img#deco')
  const missing = doc2.images.find(i => i.selector === 'img#missing')

  assert.equal(deco.hasAlt, true)
  assert.equal(deco.alt, '')
  assert.equal(deco.decorative, true)

  assert.equal(missing.hasAlt, false)
  assert.equal(missing.alt, null)
  assert.equal(missing.decorative, false)
})

test('treats role="none" as decorative, same as role="presentation"', () => {
  const doc2 = parsePage({
    url: 'https://example.com/',
    html: '<html><body><img id="a" src="a.png" alt="x" role="presentation"><img id="b" src="b.png" alt="x" role="none"></body></html>',
  })
  const a = doc2.images.find(i => i.selector === 'img#a')
  const b = doc2.images.find(i => i.selector === 'img#b')
  assert.equal(a.decorative, true)
  assert.equal(b.decorative, true)
})

// ---------------------------------------------------------------------------
// Review follow-up (Critical 3): `page.text` used to be `body.text` off a
// parse that deliberately keeps <script>/<style> bodies as raw text (so S1 can
// read JSON-LD). That put inline JS and CSS source into what content rules
// read as page copy. On the committed real fixture it made `page.text` 39,576
// chars of mostly JavaScript, matching /jQuery|function\s*\(/.
// ---------------------------------------------------------------------------

test('page.text excludes script, style, noscript and template source', () => {
  const doc = parsePage({
    url: 'https://example.com/',
    html: `<html><body>
      <p>The real page text.</p>
      <script>var config = {"email":"admin@secret.example","copy":"Lorem ipsum dolor sit amet"};
        jQuery(function ($) { if (a < b) {} });</script>
      <style>.x{content:"Lorem ipsum"}</style>
      <noscript>Enable JavaScript, lorem ipsum</noscript>
      <template><p>Lorem ipsum dolor sit amet</p></template>
    </body></html>`,
  })
  assert.match(doc.text, /The real page text/)
  assert.doesNotMatch(doc.text, /jQuery/)
  assert.doesNotMatch(doc.text, /admin@secret\.example/)
  assert.doesNotMatch(doc.text, /lorem ipsum/i)
  assert.doesNotMatch(doc.text, /content:/)
})

test('excluding script from page.text leaves jsonLd intact', () => {
  const doc = parsePage({
    url: 'https://example.com/',
    html: `<html><head>
      <script type="application/ld+json">{"@type":"Organization","email":"info@example.com"}</script>
      </head><body><p>copy</p></body></html>`,
  })
  assert.equal(doc.jsonLd.length, 1)
  assert.equal(doc.jsonLd[0].ok, true)
  assert.deepEqual(doc.jsonLd[0].types, ['Organization'])
  assert.doesNotMatch(doc.text, /info@example\.com/)
})

test('the committed real fixture yields copy-only text, not script source', () => {
  const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
  const doc = parsePage({ url: 'https://opura.example/office-cleaning/', html })
  assert.doesNotMatch(doc.text, /jQuery|function\s*\(/)
  assert.ok(doc.text.length < html.length / 4, 'copy text should be a small fraction of the raw HTML')
})
