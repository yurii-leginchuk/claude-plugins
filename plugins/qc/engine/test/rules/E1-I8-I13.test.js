// plugins/qc/engine/test/rules/E1-I8-I13.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import E1 from '../../src/rules/static/E1-broken-links.js'
import I8 from '../../src/rules/static/I8-pagination.js'
import I13 from '../../src/rules/static/I13-favicon.js'

const page = (o = {}) => ({
  url: 'https://ex.com/a', links: [], favicons: [],
  robots: { index: true, follow: true, raw: null }, canonical: 'https://ex.com/a', ...o,
})

test('E1 flags an internal link returning 404', () => {
  const p = page({ links: [{ raw: '/gone', href: 'https://ex.com/gone', internal: true, selector: 'a.x' }] })
  const site = { linkStatus: new Map([['https://ex.com/gone', { status: 404, ok: false }]]) }
  const f = E1.check(p, site)
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('E1 flags a double slash in the path', () => {
  const p = page({ links: [{ raw: '//about', href: 'https://ex.com//about', internal: true, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://ex.com//about', { status: 200, ok: true }]]) }
  assert.ok(E1.check(p, site).some(x => /двойной слэш/.test(x.found)))
})

test('E1 stays silent for healthy links', () => {
  const p = page({ links: [{ raw: '/ok', href: 'https://ex.com/ok', internal: true, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://ex.com/ok', { status: 200, ok: true }]]) }
  assert.deepEqual(E1.check(p, site), [])
})

test('E1 tolerates a missing link status map', () => {
  const p = page({ links: [{ raw: '/ok', href: 'https://ex.com/ok', internal: true, selector: 'a' }] })
  assert.deepEqual(E1.check(p, {}), [])
})

test('I8 flags a paged URL whose canonical points at page one', () => {
  const p = page({ url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/' })
  const f = I8.check(p, {})
  assert.equal(f.length, 1)
})

test('I8 accepts a self-canonical paged URL', () => {
  const p = page({ url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/page/2/' })
  assert.deepEqual(I8.check(p, {}), [])
})

test('I8 ignores non-paged URLs', () => {
  assert.deepEqual(I8.check(page(), {}), [])
})

test('I13 flags a missing favicon', () => {
  assert.equal(I13.check(page({ favicons: [] }), {}).length, 1)
})

test('I13 flags a favicon that does not return 200', () => {
  const p = page({ favicons: [{ href: 'https://ex.com/fav.ico', rel: 'icon' }] })
  const site = { linkStatus: new Map([['https://ex.com/fav.ico', { status: 404, ok: false }]]) }
  assert.equal(I13.check(p, site).length, 1)
})

test('I13 accepts a working favicon', () => {
  const p = page({ favicons: [{ href: 'https://ex.com/fav.ico', rel: 'icon' }] })
  const site = { linkStatus: new Map([['https://ex.com/fav.ico', { status: 200, ok: true }]]) }
  assert.deepEqual(I13.check(p, site), [])
})

// --- Judgement call 2: external link severity split ---

test('E1 flags a genuine external 404 at major severity, not critical', () => {
  const p = page({ links: [{ raw: 'https://other.com/gone', href: 'https://other.com/gone', internal: false, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://other.com/gone', { status: 404, ok: false }]]) }
  const f = E1.check(p, site)
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'major')
  assert.match(f[0].found, /404/)
})

test('E1 stays silent on an external timeout/DNS failure (status 0) -- not our bug to report', () => {
  const p = page({ links: [{ raw: 'https://flaky-host.example/x', href: 'https://flaky-host.example/x', internal: false, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://flaky-host.example/x', { status: 0, ok: false, error: 'timeout' }]]) }
  assert.deepEqual(E1.check(p, site), [])
})

test('E1 stays silent on an external 5xx -- a transient error on a server we do not control, not a confirmed dead link', () => {
  const p = page({ links: [{ raw: 'https://other.com/down', href: 'https://other.com/down', internal: false, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://other.com/down', { status: 503, ok: false }]]) }
  assert.deepEqual(E1.check(p, site), [])
})

test('E1 still flags an internal status-0 failure at critical -- our own infrastructure is always our bug', () => {
  const p = page({ links: [{ raw: '/down', href: 'https://ex.com/down', internal: true, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://ex.com/down', { status: 0, ok: false, error: 'timeout' }]]) }
  const f = E1.check(p, site)
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('E1 handles a realistic mixed page: internal 404, external 404, external timeout, healthy link, all in one pass', () => {
  const p = page({
    links: [
      { raw: '/gone', href: 'https://ex.com/gone', internal: true, selector: 'a.nav' },
      { raw: 'https://other.com/gone', href: 'https://other.com/gone', internal: false, selector: 'a.partner' },
      { raw: 'https://flaky.example/x', href: 'https://flaky.example/x', internal: false, selector: 'a.badge' },
      { raw: '/ok', href: 'https://ex.com/ok', internal: true, selector: 'a.home' },
    ],
  })
  const site = {
    linkStatus: new Map([
      ['https://ex.com/gone', { status: 404, ok: false }],
      ['https://other.com/gone', { status: 404, ok: false }],
      ['https://flaky.example/x', { status: 0, ok: false, error: 'timeout' }],
      ['https://ex.com/ok', { status: 200, ok: true }],
    ]),
  }
  const f = E1.check(p, site)
  assert.equal(f.length, 2)
  const bySelector = Object.fromEntries(f.map(x => [x.selector, x]))
  assert.equal(bySelector['a.nav'].severity, 'critical')
  assert.equal(bySelector['a.partner'].severity, 'major')
  assert.equal(bySelector['a.badge'], undefined, 'external timeout must not produce a finding')
})

test('E1 tolerates a page with no links array at all', () => {
  const p = page({ links: undefined })
  const site = { linkStatus: new Map() }
  assert.deepEqual(E1.check(p, site), [])
})

// --- I8 boundary: a missing canonical on a paged URL is I5's job, not I8's ---

test('I8 does not flag a paged URL that has no canonical at all', () => {
  const p = page({ url: 'https://ex.com/blog/page/2/', canonical: null })
  assert.deepEqual(I8.check(p, {}), [])
})

test('I8 recognizes query-string pagination (?paged=N), not just /page/N/', () => {
  const p = page({ url: 'https://ex.com/blog/?paged=3', canonical: 'https://ex.com/blog/' })
  const f = I8.check(p, {})
  assert.equal(f.length, 1)
})

// --- Judgement call 4: at most one favicon finding per page ---

test('I13 collapses several broken icon variants into a single finding, not one per icon', () => {
  const p = page({
    favicons: [
      { href: 'https://ex.com/favicon.ico', rel: 'icon' },
      { href: 'https://ex.com/apple-touch-icon.png', rel: 'apple-touch-icon' },
      { href: 'https://ex.com/favicon.ico', rel: 'shortcut icon' },
    ],
  })
  const site = {
    linkStatus: new Map([
      ['https://ex.com/favicon.ico', { status: 404, ok: false }],
      ['https://ex.com/apple-touch-icon.png', { status: 404, ok: false }],
    ]),
  }
  const f = I13.check(p, site)
  assert.equal(f.length, 1, 'must report at most one finding even though three icon links are broken')
})

test('I13 reports nothing when some icons are broken but link status is unknown for others, and none are confirmed broken', () => {
  const p = page({ favicons: [{ href: 'https://ex.com/favicon.ico', rel: 'icon' }] })
  const site = { linkStatus: new Map() } // href never resolved (e.g. not crawled)
  assert.deepEqual(I13.check(p, site), [])
})

test('I13 tolerates a page missing the favicons array entirely (not just empty)', () => {
  const p = page({ favicons: undefined })
  assert.equal(I13.check(p, {}).length, 1)
})

test('I13 marks a missing-favicon finding as heuristic (inferred from absent markup, not a confirmed dead icon)', () => {
  const f = I13.check(page({ favicons: [] }), {})
  assert.equal(f[0].confidence, 'heuristic')
})

test('I13 marks a confirmed-broken favicon finding as high confidence (directly observed HTTP status)', () => {
  const p = page({ favicons: [{ href: 'https://ex.com/fav.ico', rel: 'icon' }] })
  const site = { linkStatus: new Map([['https://ex.com/fav.ico', { status: 404, ok: false }]]) }
  const f = I13.check(p, site)
  assert.equal(f[0].confidence, 'high')
})
