import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollUp, verdict, diffRuns } from '../../src/report/json.js'

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
test('rollUp with mixed severity in same rule uses most severe but counts all', () => {
  const findings = [
    f({ rule: 'E1', severity: 'critical', page: 'https://ex.com/a' }),
    f({ rule: 'E1', severity: 'major', page: 'https://ex.com/b' }),
    f({ rule: 'E1', severity: 'critical', page: 'https://ex.com/c' }),
  ]
  const r = rollUp(findings)
  assert.equal(r.length, 1)
  const group = r[0]
  assert.equal(group.severity, 'critical', 'should use most severe')
  assert.equal(group.count, 3, 'should count all findings')
  assert.deepEqual(group.pages.sort(), ['https://ex.com/a', 'https://ex.com/b', 'https://ex.com/c'])
  assert.equal(group.example.severity, 'critical', 'example should be from most severe')
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

// Defensive: rollUp on non-iterable throws clear error
test('rollUp on non-iterable throws TypeError', () => {
  assert.throws(
    () => rollUp(null),
    TypeError,
    'rollUp(null) should throw with clear message'
  )
  assert.throws(
    () => rollUp(42),
    TypeError,
    'rollUp(42) should throw with clear message'
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
