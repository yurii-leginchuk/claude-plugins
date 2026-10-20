// plugins/qc/engine/test/rules/E3-E5-E6.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import E3 from '../../src/rules/static/E3-target-blank.js'
import E5 from '../../src/rules/static/E5-duplicate-plus-one.js'
import E6 from '../../src/rules/static/E6-mailto-and-bare-contacts.js'
import { readFileSync } from 'node:fs'
import { parsePage } from '../../src/parse/page.js'

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
  assert.match(f[0].found, /without rel=noopener/)
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

// ---------------------------------------------------------------------------
// Review follow-up (Critical 3): E6's bare-contact scan reads `page.text`. When
// that still carried <script> source, an email inside Yoast/RankMath's
// Organization JSON-LD or a Gravity Forms config produced an E6 major on every
// page of the site -- a defect that does not exist, because nothing in the
// visible copy shows an unlinked address. Drive it through parsePage: a
// hand-built `text` literal is exactly what let this through.
// ---------------------------------------------------------------------------

test('E6 does not flag an email that appears only inside JSON-LD or a form config script', () => {
  const doc = parsePage({
    url: 'https://ex.com/a',
    html: `<html><head>
      <script type="application/ld+json">{"@type":"Organization","email":"info@ex.com"}</script>
      </head><body>
      <p>Contact us by phone.</p>
      <script>var gf_global = {"notification_email":"admin@ex.com"};</script>
      </body></html>`,
  })
  assert.deepEqual(E6.check(doc, {}), [], 'machine payload is not visible page copy')
})

test('E6 still flags a bare email in real body copy', () => {
  const doc = parsePage({
    url: 'https://ex.com/a',
    html: '<html><body><p>Write to info@ex.com</p></body></html>',
  })
  const f = E6.check(doc, {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'info@ex.com')
})

test('E6 reports no bare contacts on the committed real fixture', () => {
  const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
  const doc = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })
  assert.deepEqual(E6.check(doc, {}), [])
})
