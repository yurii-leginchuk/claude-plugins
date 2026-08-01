import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollUp, verdict, diffRuns, countDistinct } from '../../src/report/json.js'

const f = (o) => ({
  rule: 'E4', title: 'tel', severity: 'major', engine: 'static', confidence: 'high',
  page: 'https://ex.com/a', selector: 'a', found: 'x', expected: 'y', breakpoint: null, ...o,
})

test('rollUp groups by rule and counts affected pages', () => {
  const r = rollUp([f({ page: 'https://ex.com/a' }), f({ page: 'https://ex.com/b' }), f({ rule: 'I1', severity: 'critical' })])
  assert.equal(r.length, 2)
  assert.equal(r[0].rule, 'I1')          // critical first
  const e4 = r.find(x => x.rule === 'E4')
  assert.equal(e4.count, 2)
  assert.deepEqual(e4.pages, ['https://ex.com/a', 'https://ex.com/b'])
})

test('verdict is Fail when any critical exists', () => {
  assert.equal(verdict([f({ severity: 'critical' })]), 'Fail')
})

test('verdict is Needs fixes when only majors exist', () => {
  assert.equal(verdict([f({ severity: 'major' })]), 'Needs fixes')
})

test('verdict is Pass when only minors exist', () => {
  assert.equal(verdict([f({ severity: 'minor' })]), 'Pass')
})

test('heuristics never change the verdict', () => {
  assert.equal(verdict([f({ severity: 'critical', confidence: 'heuristic' })]), 'Pass')
})

test('diffRuns splits fixed, remaining and added', () => {
  const prev = [f({ found: 'old' }), f({ found: 'both' })]
  const cur = [f({ found: 'both' }), f({ found: 'new' })]
  const d = diffRuns(cur, prev)
  assert.equal(d.fixed.length, 1)
  assert.equal(d.remaining.length, 1)
  assert.equal(d.added.length, 1)
  assert.equal(d.added[0].found, 'new')
})

test('diffRuns treats a missing previous run as all-new', () => {
  const d = diffRuns([f({})], null)
  assert.equal(d.added.length, 1)
  assert.equal(d.fixed.length, 0)
})

// Judgement call 1: Heuristic findings must not change verdict but must still appear in rollUp
test('rollUp returns heuristic findings even though they do not affect verdict', () => {
  const findings = [f({ severity: 'critical', confidence: 'heuristic' })]
  const r = rollUp(findings)
  assert.equal(r.length, 1, 'rollUp should include heuristic findings')
  assert.equal(r[0].confidence, 'heuristic')
  const v = verdict(findings)
  assert.equal(v, 'Pass', 'heuristic critical should not affect verdict')
})

// Judgement call 2: Mixed severity in a rule group
//
// Review follow-up (Important 1): rollUp used to group by rule alone and
// collapse mixed severities into a single "most severe wins" row. Rendered
// against the real cached cleaningny.com run, that made E3's 44 major
// findings (internal target=_blank, a real house-rule defect) and 180 minor
// findings (external missing rel=noopener, hygiene) merge into one row
// chipped "Major · 224 находок" -- exactly the flood the E1/E3 calibration
// was meant to fix, just moved into the report. Grouping now includes
// severity and confidence, so same-rule/different-severity findings are
// separate rows/chips.
test('rollUp with same rule but different severities produces separate groups, not a merged "most severe" row', () => {
  const findings = [
    f({ rule: 'E1', severity: 'critical', page: 'https://ex.com/a' }),
    f({ rule: 'E1', severity: 'major', page: 'https://ex.com/b' }),
    f({ rule: 'E1', severity: 'critical', page: 'https://ex.com/c' }),
  ]
  const r = rollUp(findings)
  assert.equal(r.length, 2, 'critical and major E1 findings must not collapse into one group')
  const crit = r.find(g => g.rule === 'E1' && g.severity === 'critical')
  const maj = r.find(g => g.rule === 'E1' && g.severity === 'major')
  assert.equal(crit.count, 2)
  assert.deepEqual(crit.pages.sort(), ['https://ex.com/a', 'https://ex.com/c'])
  assert.equal(maj.count, 1)
  assert.deepEqual(maj.pages, ['https://ex.com/b'])
  // Ordering contract preserved: severity first, then descending count.
  assert.equal(r[0].severity, 'critical', 'critical group sorts before major')
})

// Important 1, explicit ask: "add one asserting that a single rule emitting
// two severities produces two groups with the correct chips." `severity`
// and `confidence` on each group are exactly what src/report/html.js's
// CHIP/LABEL lookup renders as the chip, so asserting those fields here is
// asserting the chip is correct without duplicating html.js's rendering.
test('rollUp: a single rule emitting two severities produces two groups with the correct severity/confidence chips', () => {
  const findings = [
    f({ rule: 'E3', title: 'target=_blank', severity: 'major', confidence: 'high', selector: 'a.internal', found: 'internal blank' }),
    f({ rule: 'E3', title: 'target=_blank', severity: 'minor', confidence: 'high', selector: 'a.social', found: 'missing noopener' }),
  ]
  const r = rollUp(findings)
  assert.equal(r.length, 2)
  assert.deepEqual(r.map(g => g.severity), ['major', 'minor'], 'major group sorts before minor')
  for (const g of r) {
    assert.equal(g.rule, 'E3')
    assert.equal(g.title, 'target=_blank', 'rule title is preserved on every row, not just the first')
    assert.equal(g.confidence, 'high')
    assert.equal(g.count, 1)
  }
})

// Judgement call 3: Rule-specific normalization for volatile found values
// Only I1 and I6 have count normalization; other rules keep exact found value

test('diffRuns: HTTP status changes (404 vs 500) remain different for E1', () => {
  // E1 emits different HTTP codes for same URL - these should be treated as different findings
  // because the status code IS the defect, not metadata about it
  const prev = [f({ rule: 'E1', found: 'HTTP 404:', page: 'https://ex.com/a' })]
  const cur = [f({ rule: 'E1', found: 'HTTP 500:', page: 'https://ex.com/a' })]

  const d = diffRuns(cur, prev)
  assert.equal(d.fixed.length, 1, 'old HTTP status shows as fixed')
  assert.equal(d.added.length, 1, 'new HTTP status shows as added')
  assert.equal(d.remaining.length, 0, 'different status codes are different issues')
})

test('diffRuns: H1 count changes normalize for I1', () => {
  // I1 emits "H1 на странице: N" where N is discovered quantity
  // Change from 2 to 3 H1s is the same issue type (too many H1s)
  const prev = [f({ rule: 'I1', found: 'H1 на странице: 2', page: 'https://ex.com/a' })]
  const cur = [f({ rule: 'I1', found: 'H1 на странице: 3', page: 'https://ex.com/a' })]

  const d = diffRuns(cur, prev)
  assert.equal(d.fixed.length, 0, 'H1 count change not treated as fixed (rule I1 normalizes)')
  assert.equal(d.added.length, 0, 'H1 count change not treated as added')
  assert.equal(d.remaining.length, 1, 'H1 count identified as same issue')
})

test('diffRuns: Title duplication count changes normalize for I6', () => {
  // I6 emits "дубль title на N страницах" where N is discovered quantity
  const prev = [f({ rule: 'I6', found: 'дубль title на 47 страницах', page: 'https://ex.com/a' })]
  const cur = [f({ rule: 'I6', found: 'дубль title на 12 страницах', page: 'https://ex.com/a' })]

  const d = diffRuns(cur, prev)
  assert.equal(d.fixed.length, 0, 'title dup count change not treated as fixed (rule I6 normalizes)')
  assert.equal(d.added.length, 0, 'title dup count change not treated as added')
  assert.equal(d.remaining.length, 1, 'title dup count identified as same issue')
})

test('diffRuns: Phone number changes are different defects for E4', () => {
  // E4 emits tel: links with the actual phone number - the number IS the defect
  // Going from wrong number to different wrong number is two different bugs
  const prev = [f({ rule: 'E4', found: 'tel:855-607-8758', page: 'https://ex.com/a' })]
  const cur = [f({ rule: 'E4', found: 'tel:855-607-8759', page: 'https://ex.com/a' })]

  const d = diffRuns(cur, prev)
  assert.equal(d.fixed.length, 1, 'old phone number shows as fixed')
  assert.equal(d.added.length, 1, 'new phone number shows as added')
  assert.equal(d.remaining.length, 0, 'different phone numbers are different defects')
})

// Judgement call 4: diffRuns with empty current and non-empty previous
test('diffRuns with empty current and non-empty previous marks all as fixed', () => {
  const prev = [f({ found: 'a' }), f({ found: 'b' })]
  const d = diffRuns([], prev)
  assert.equal(d.fixed.length, 2, 'all previous should be fixed')
  assert.equal(d.remaining.length, 0)
  assert.equal(d.added.length, 0)
})

// Test that rollUp handles empty findings
test('rollUp with empty findings returns empty array', () => {
  const r = rollUp([])
  assert.deepEqual(r, [])
})

// Test that verdict with empty findings returns Pass
test('verdict with empty findings returns Pass', () => {
  assert.equal(verdict([]), 'Pass')
})

// Defensive: diffRuns accounts for multiplicity (duplicate findings)
test('diffRuns with identical duplicates in current and empty previous yields two added', () => {
  const cur = [f({ found: 'dup' }), f({ found: 'dup' })]
  const d = diffRuns(cur, null)
  assert.equal(d.added.length, 2, 'both duplicates should be counted as added')
  assert.equal(d.fixed.length, 0)
  assert.equal(d.remaining.length, 0)
})

test('diffRuns from one to two identical findings yields one added', () => {
  const prev = [f({ found: 'dup' })]
  const cur = [f({ found: 'dup' }), f({ found: 'dup' })]
  const d = diffRuns(cur, prev)
  assert.equal(d.remaining.length, 1, 'first occurrence remains')
  assert.equal(d.added.length, 1, 'second occurrence is new')
  assert.equal(d.fixed.length, 0)
})

test('diffRuns from two to one identical findings yields one fixed', () => {
  const prev = [f({ found: 'dup' }), f({ found: 'dup' })]
  const cur = [f({ found: 'dup' })]
  const d = diffRuns(cur, prev)
  assert.equal(d.remaining.length, 1, 'one occurrence remains')
  assert.equal(d.fixed.length, 1, 'one occurrence was fixed')
  assert.equal(d.added.length, 0)
})

// Defensive: rollUp requires actual array, not just iterable
test('rollUp requires an array and rejects non-arrays', () => {
  // null, undefined, numbers
  assert.throws(
    () => rollUp(null),
    TypeError,
    'rollUp(null) should throw'
  )
  assert.throws(
    () => rollUp(undefined),
    TypeError,
    'rollUp(undefined) should throw'
  )
  assert.throws(
    () => rollUp(42),
    TypeError,
    'rollUp(42) should throw'
  )
  // strings (iterable but not array)
  assert.throws(
    () => rollUp('nonsense'),
    TypeError,
    'rollUp("nonsense") should throw - strings are iterable but not arrays'
  )
  // objects (not iterable)
  assert.throws(
    () => rollUp({}),
    TypeError,
    'rollUp({}) should throw'
  )
})

// Defensive: unknown severity sorts last
test('rollUp with unknown severity sorts to end', () => {
  const findings = [
    f({ rule: 'E1', severity: 'critical' }),
    f({ rule: 'E2', severity: 'unknown' }),  // unknown severity
    f({ rule: 'E3', severity: 'minor' }),
  ]
  const r = rollUp(findings)
  // Should sort: critical (0), minor (2), unknown (999)
  assert.equal(r[0].severity, 'critical', 'critical should be first')
  assert.equal(r[1].severity, 'minor', 'minor should be second')
  assert.equal(r[2].severity, 'unknown', 'unknown should be last')
})

// Defensive: diffRuns requires current to be array, and previous to be null/undefined/array
test('diffRuns requires current to be an array', () => {
  // current must be array
  assert.throws(
    () => diffRuns('x', []),
    TypeError,
    'diffRuns("x", []) should throw - current must be array'
  )
  assert.throws(
    () => diffRuns({}, []),
    TypeError,
    'diffRuns({}, []) should throw - current must be array'
  )
  // previous can be null/undefined/array, but not string/object
  assert.throws(
    () => diffRuns([], 'x'),
    TypeError,
    'diffRuns([], "x") should throw - previous cannot be string'
  )
  assert.throws(
    () => diffRuns([], {}),
    TypeError,
    'diffRuns([], {}) should throw - previous cannot be object'
  )
  // But null and undefined are OK for previous
  const d1 = diffRuns([f({})], null)
  assert.equal(d1.added.length, 1, 'diffRuns with null previous should work')
  const d2 = diffRuns([f({})], undefined)
  assert.equal(d2.added.length, 1, 'diffRuns with undefined previous should work')
})

// --- Review follow-up (Important 2): `distinct` counts defects, not raw
// occurrences -----------------------------------------------------------
//
// The reviewer measured the real cached run: 44 E3-major findings are 8
// distinct link positions (one -- the /privacy-policy/ footer link -- is
// 32 of the 44 on its own). `counts.major: 56` overstates the fix list by
// an order of magnitude; `distinct` is meant to say "8 things to fix," not
// "56 findings."

// Task 6 (region proof): collapsing the same rule+selector+found across
// pages is no longer automatic just because the text happens to match --
// it requires the finding to carry a `region` proved shared by
// proveRegions() (see src/browser/regions.js). This fixture's icon is a
// real footer social link, so it is tagged `region: 'footer'` here exactly
// as the browser run loop would tag it via regionOf() -- that is what makes
// it one defect across 5 pages, not the coincidence of matching text.
test('countDistinct collapses a defect repeated verbatim across many pages into one, while raw counts stay at the full occurrence total', () => {
  const template = Array.from({ length: 5 }, (_, i) => f({
    rule: 'E3', severity: 'major', selector: 'a.elementor-icon.elementor-social-icon',
    found: 'внешняя ссылка без rel=noopener: https://www.facebook.com/people/Opura',
    page: `https://cleaningny.com/p${i}/`, region: 'footer',
  }))
  assert.equal(template.length, 5, 'sanity: 5 raw occurrences, one per page')
  assert.equal(countDistinct(template).major, 1, 'same rule+region+selector+found across 5 pages is one distinct defect')
})

test('countDistinct keeps two genuinely different defects behind the same selector distinct, because found differs', () => {
  const findings = [
    f({ rule: 'E4', severity: 'major', selector: 'a.phone', found: 'tel:+1234567890' }),
    f({ rule: 'E4', severity: 'major', selector: 'a.phone', found: 'tel:+1987654321' }),
  ]
  assert.equal(countDistinct(findings).major, 2, 'different phone numbers behind the same selector are different defects')
})

test('countDistinct vs counts on a fixture with one repeated template defect and one genuinely-repeated-but-distinct defect', () => {
  // One template-level defect (same footer link) repeated across 4 pages.
  // Tagged `region: 'footer'` -- per Task 6, this is what makes it collapse
  // to one defect, not the mere coincidence of matching selector/found text.
  const templateRepeated = Array.from({ length: 4 }, (_, i) => f({
    rule: 'E3', severity: 'major', selector: 'a.social', found: 'facebook link missing noopener',
    page: `https://ex.com/p${i}`, region: 'footer',
  }))
  // Two genuinely different defects that happen to share a selector (two
  // different wrong phone numbers behind the same "call us" link markup).
  const genuinelyDistinct = [
    f({ rule: 'E4', severity: 'major', selector: 'a.phone', found: 'tel:+1111111111', page: 'https://ex.com/contact' }),
    f({ rule: 'E4', severity: 'major', selector: 'a.phone', found: 'tel:+1222222222', page: 'https://ex.com/about' }),
  ]
  const all = [...templateRepeated, ...genuinelyDistinct]

  const rawMajor = all.filter(x => x.severity === 'major' && x.confidence !== 'heuristic').length
  assert.equal(rawMajor, 6, 'raw occurrence total: 4 template repeats + 2 distinct phone numbers')

  const distinct = countDistinct(all)
  assert.equal(distinct.major, 3, 'distinct total: 1 template defect (collapsed) + 2 genuinely different phone numbers')
})

test('countDistinct excludes heuristic-confidence findings, matching the population counts.* covers', () => {
  const findings = [
    f({ rule: 'E3', severity: 'minor', confidence: 'heuristic', selector: 'a.x', found: 'no target' }),
    f({ rule: 'E3', severity: 'minor', confidence: 'heuristic', selector: 'a.y', found: 'no target 2' }),
  ]
  assert.deepEqual(countDistinct(findings), { critical: 0, major: 0, minor: 0, note: 0 })
})

test('countDistinct always returns all four severity keys, even for an empty findings list', () => {
  assert.deepEqual(countDistinct([]), { critical: 0, major: 0, minor: 0, note: 0 })
})

// ---------------------------------------------------------------------------
// Review follow-up (Critical 1): rollUp grouped by rule|severity|confidence
// and html.js rendered a single found/expected/selector from g.example, so
// every other distinct defect in the group was silently dropped from the
// report -- on the real cleaningny.com run, 25 distinct solid defects with
// only 10 described. defectIdentity() is the shared definition of "one
// defect" that countDistinct and diffRuns already use; rollUp must use it too.
// ---------------------------------------------------------------------------

test('rollUp splits a group into one entry per defectIdentity, keeping each found/expected/selector', () => {
  const findings = [
    // 'a.one' is region-tagged (Task 6): a proved-shared region is what
    // collapses it across pages 1 and 2 into a single identity below.
    f({ rule: 'E3', selector: 'a.one', found: 'ссылка A', expected: 'без target', page: 'https://ex.com/1', region: 'header' }),
    f({ rule: 'E3', selector: 'a.one', found: 'ссылка A', expected: 'без target', page: 'https://ex.com/2', region: 'header' }),
    f({ rule: 'E3', selector: 'a.two', found: 'ссылка B', expected: 'без target', page: 'https://ex.com/1' }),
  ]
  const [g] = rollUp(findings)
  assert.equal(g.count, 3, 'raw occurrences unchanged')
  assert.equal(g.identities.length, 2, 'two distinct defects under one rule+severity')
  const [first, second] = g.identities
  assert.equal(first.found, 'ссылка A')
  assert.equal(first.count, 2)
  assert.deepEqual(first.pages, ['https://ex.com/1', 'https://ex.com/2'])
  assert.equal(second.found, 'ссылка B')
  assert.deepEqual(second.pages, ['https://ex.com/1'])
})

test('rollUp identity count matches countDistinct for the same findings', () => {
  const findings = [
    f({ rule: 'E1', severity: 'critical', selector: 'a.a', found: 'HTTP 404: /x', page: 'https://ex.com/1' }),
    f({ rule: 'E1', severity: 'critical', selector: 'a.b', found: 'HTTP 404: /y', page: 'https://ex.com/1' }),
    f({ rule: 'E1', severity: 'critical', selector: 'a.a', found: 'HTTP 404: /x', page: 'https://ex.com/2' }),
  ]
  const groups = rollUp(findings)
  const identityTotal = groups.reduce((n, g) => n + g.identities.length, 0)
  assert.equal(identityTotal, countDistinct(findings).critical)
})

// Task 6 changed this expectation from 1 to 2. Before region proof existed,
// defectIdentity ignored `page` entirely, so I1's digit normalization
// ("H1 на странице: N") alone made this collapse across any two pages that
// both had the wrong H1 count -- including two pages that are not part of
// the same template region and coincidentally both have a bad H1 count for
// unrelated reasons. I1 fires on `body`, not on an Elementor container, so
// it can never carry a proved region (regionOf has nothing to look up) --
// per Task 6's model, a defect that cannot be tied to a shared region stays
// page-scoped. Two different pages are now correctly two distinct defects;
// the digit normalization still collapses fluctuating counts *within* the
// same page (see the I1 diffRuns test above, which is unaffected: it uses a
// single page throughout).
test('rollUp does not normalize away distinct pages: fluctuating H1 counts on different pages remain two identities', () => {
  const findings = [
    f({ rule: 'I1', severity: 'critical', selector: 'body', found: 'H1 на странице: 2', page: 'https://ex.com/1' }),
    f({ rule: 'I1', severity: 'critical', selector: 'body', found: 'H1 на странице: 3', page: 'https://ex.com/2' }),
  ]
  const [g] = rollUp(findings)
  assert.equal(g.identities.length, 2, 'no proved region ties these two pages together; they stay distinct')
})

test('rollUp still normalizes fluctuating counts for the same page (region-independent)', () => {
  // Same page, count reported twice (e.g. two different crawl passes) --
  // normalization collapses these regardless of region, because `page` is
  // identical either way.
  const findings = [
    f({ rule: 'I1', severity: 'critical', selector: 'body', found: 'H1 на странице: 2', page: 'https://ex.com/1' }),
    f({ rule: 'I1', severity: 'critical', selector: 'body', found: 'H1 на странице: 3', page: 'https://ex.com/1' }),
  ]
  const [g] = rollUp(findings)
  assert.equal(g.identities.length, 1, 'same page: normalized counts still collapse to one identity')
})
