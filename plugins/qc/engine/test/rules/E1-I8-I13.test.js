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
  assert.ok(E1.check(p, site).some(x => /double slash/.test(x.found)))
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

// Review follow-up (Important 4): I8 used to flag `canonical !== page.url` on
// paginated URLs -- a strict subset of what I5 flags unconditionally on every
// page. Every I8 finding was therefore a second report of an I5 defect under a
// different rule id, inflating both `counts` and `distinct` in two severity
// buckets. Canonical belongs to I5; I8 now covers only what is specific to
// pagination.
test('I8 says nothing about canonical on a paged URL -- that is I5 clause, not a second report', () => {
  const p = page({ url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/' })
  assert.deepEqual(I8.check(p, {}), [])
})

test('I8 accepts a self-canonical paged URL', () => {
  const p = page({ url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/page/2/' })
  assert.deepEqual(I8.check(p, {}), [])
})

test('I8 ignores non-paged URLs', () => {
  assert.deepEqual(I8.check(page(), {}), [])
})

test('I8 flags a noindex paginated page (pages 2+ must stay indexable)', () => {
  const p = page({
    url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/page/2/',
    robots: { index: false, follow: true, raw: 'noindex, follow' },
  })
  const f = I8.check(p, {})
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'I8')
  assert.equal(f[0].severity, 'major')
  assert.equal(f[0].selector, 'meta[name=robots]')
  assert.match(f[0].found, /closed to indexing/)
})

test('I8 flags a nofollow paginated page (the crawl path to the listed items is cut)', () => {
  const p = page({
    url: 'https://ex.com/blog/page/3/', canonical: 'https://ex.com/blog/page/3/',
    robots: { index: true, follow: false, raw: 'index, nofollow' },
  })
  const f = I8.check(p, {})
  assert.equal(f.length, 1)
  assert.match(f[0].found, /closed to link crawling/)
})

test('I8 reports both robots clauses when a paginated page is noindex,nofollow', () => {
  const p = page({
    url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/page/2/',
    robots: { index: false, follow: false, raw: 'none' },
  })
  assert.equal(I8.check(p, {}).length, 2)
})

test('I8 does not apply the robots clause to page 1 of a series', () => {
  const p = page({
    url: 'https://ex.com/blog/page/1/', canonical: 'https://ex.com/blog/page/1/',
    robots: { index: false, follow: true, raw: 'noindex' },
  })
  assert.deepEqual(I8.check(p, {}), [], 'page 1 is an ordinary page; I4 owns its noindex')
})

test('I8 emits nothing at all when it has nothing to say about a paginated page', () => {
  const p = page({
    url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/page/2/',
    robots: { index: true, follow: true, raw: null },
  })
  assert.deepEqual(I8.check(p, {}), [])
})

test('I8 flags a page number carried in a query parameter instead of the URL path', () => {
  const p = page({ url: 'https://ex.com/blog/?paged=2', canonical: 'https://ex.com/blog/?paged=2' })
  const f = I8.check(p, {})
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'minor')
  assert.equal(f[0].confidence, 'high')
  assert.match(f[0].found, /query parameter/)
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
  assert.equal(f[0].confidence, 'high')
  assert.match(f[0].found, /404/)
})

test('E1 flags a genuine external 410 at major/high -- Gone is as genuine as 404, not bot protection', () => {
  const p = page({ links: [{ raw: 'https://other.com/retired', href: 'https://other.com/retired', internal: false, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://other.com/retired', { status: 410, ok: false }]]) }
  const f = E1.check(p, site)
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'major')
  assert.equal(f[0].confidence, 'high')
  assert.match(f[0].found, /410/)
})

test('E1 stays silent on an external timeout/DNS failure (status 0) -- not our bug to report', () => {
  const p = page({ links: [{ raw: 'https://flaky-host.example/x', href: 'https://flaky-host.example/x', internal: false, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://flaky-host.example/x', { status: 0, ok: false, error: 'timeout' }]]) }
  assert.deepEqual(E1.check(p, site), [])
})

test('E1 flags an external 500 at major severity -- it survived fetchOne\'s retries, so it is durable breakage, not a transient blip', () => {
  const p = page({ links: [{ raw: 'https://other.com/down', href: 'https://other.com/down', internal: false, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://other.com/down', { status: 500, ok: false }]]) }
  const f = E1.check(p, site)
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'major')
  assert.equal(f[0].confidence, 'high')
  assert.match(f[0].found, /500/)
})

// --- Judgement call 5: bot-protection statuses (400/401/403/405/429) on an
// external host are reported as a heuristic needing manual confirmation,
// not as confirmed breakage. Facebook and similar third parties routinely
// reject a headless/non-browser fetch with one of these codes while the
// link works fine for a real visitor.

for (const status of [400, 401, 403, 405, 429]) {
  test(`E1 downgrades an external ${status} to note/heuristic -- likely bot protection, not a dead link`, () => {
    const p = page({ links: [{ raw: 'https://social.example/profile', href: 'https://social.example/profile', internal: false, selector: 'a.social' }] })
    const site = { linkStatus: new Map([['https://social.example/profile', { status, ok: false }]]) }
    const f = E1.check(p, site)
    assert.equal(f.length, 1)
    assert.equal(f[0].severity, 'note')
    assert.equal(f[0].confidence, 'heuristic')
    assert.match(f[0].found, new RegExp(String(status)))
    assert.match(f[0].found, /manual check|manually/, 'wording should signal this needs manual confirmation, not read as a confirmed defect')
  })
}

test('E1 still flags an internal 400/403/429 at critical -- bot-protection downgrade only applies to external hosts', () => {
  for (const status of [400, 403, 429]) {
    const p = page({ links: [{ raw: '/blocked', href: 'https://ex.com/blocked', internal: true, selector: 'a' }] })
    const site = { linkStatus: new Map([['https://ex.com/blocked', { status, ok: false }]]) }
    const f = E1.check(p, site)
    assert.equal(f.length, 1)
    assert.equal(f[0].severity, 'critical')
  }
})

test('E1 still stays silent on an external status 0 -- ambiguous between "their site is down" and "our checker got blocked"', () => {
  const p = page({ links: [{ raw: 'https://flaky-host.example/x', href: 'https://flaky-host.example/x', internal: false, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://flaky-host.example/x', { status: 0, ok: false, error: 'timeout' }]]) }
  assert.deepEqual(E1.check(p, site), [])
})

test('E1 flags an internal 500 at critical -- our own infrastructure returning a server error is unambiguously our bug', () => {
  const p = page({ links: [{ raw: '/down', href: 'https://ex.com/down', internal: true, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://ex.com/down', { status: 500, ok: false }]]) }
  const f = E1.check(p, site)
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('E1 still flags an internal status-0 failure at critical -- our own infrastructure is always our bug', () => {
  const p = page({ links: [{ raw: '/down', href: 'https://ex.com/down', internal: true, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://ex.com/down', { status: 0, ok: false, error: 'timeout' }]]) }
  const f = E1.check(p, site)
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('E1 handles a realistic mixed page: internal 404, external 404, external 500, external timeout, healthy link, all in one pass', () => {
  const p = page({
    links: [
      { raw: '/gone', href: 'https://ex.com/gone', internal: true, selector: 'a.nav' },
      { raw: 'https://other.com/gone', href: 'https://other.com/gone', internal: false, selector: 'a.partner' },
      { raw: 'https://other.com/down', href: 'https://other.com/down', internal: false, selector: 'a.widget' },
      { raw: 'https://flaky.example/x', href: 'https://flaky.example/x', internal: false, selector: 'a.badge' },
      { raw: '/ok', href: 'https://ex.com/ok', internal: true, selector: 'a.home' },
    ],
  })
  const site = {
    linkStatus: new Map([
      ['https://ex.com/gone', { status: 404, ok: false }],
      ['https://other.com/gone', { status: 404, ok: false }],
      ['https://other.com/down', { status: 500, ok: false }],
      ['https://flaky.example/x', { status: 0, ok: false, error: 'timeout' }],
      ['https://ex.com/ok', { status: 200, ok: true }],
    ]),
  }
  const f = E1.check(p, site)
  assert.equal(f.length, 3)
  const bySelector = Object.fromEntries(f.map(x => [x.selector, x]))
  assert.equal(bySelector['a.nav'].severity, 'critical')
  assert.equal(bySelector['a.partner'].severity, 'major')
  assert.equal(bySelector['a.widget'].severity, 'major', 'external 500 is durable breakage once it survives retries, so it is reported at major')
  assert.equal(bySelector['a.badge'], undefined, 'external timeout (status 0) must not produce a finding')
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
  const p = page({
    url: 'https://ex.com/blog/?paged=3', canonical: 'https://ex.com/blog/?paged=3',
    robots: { index: false, follow: true, raw: 'noindex' },
  })
  const f = I8.check(p, {})
  assert.equal(f.length, 2, 'the query-parameter clause plus the noindex clause')
  assert.ok(f.some(x => /query parameter/.test(x.found)))
  assert.ok(f.some(x => /closed to indexing/.test(x.found)))
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

test('I13 does not list the same broken URL twice when several rel values point at it', () => {
  const p = page({
    favicons: [
      { href: 'https://ex.com/favicon.ico', rel: 'icon' },
      { href: 'https://ex.com/favicon.ico', rel: 'shortcut icon' },
    ],
  })
  const site = { linkStatus: new Map([['https://ex.com/favicon.ico', { status: 404, ok: false }]]) }
  const f = I13.check(p, site)
  assert.equal(f.length, 1)
  const occurrences = f[0].found.split('https://ex.com/favicon.ico').length - 1
  assert.equal(occurrences, 1, `expected the broken URL to appear once, found: ${f[0].found}`)
})
