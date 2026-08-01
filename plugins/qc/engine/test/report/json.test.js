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

// Judgement call 3: Handle volatile values in found field
test('diffRuns normalizes volatile patterns in found field', () => {
  // Simulate messages with counts that change between runs
  const prev = [f({ found: 'Missing 5 images', selector: '.img' })]
  const cur = [f({ found: 'Missing 6 images', selector: '.img' })]

  // With normalization, numbers are replaced with 'N', so these are treated as same
  const d = diffRuns(cur, prev)

  // These should be treated as the same issue (remaining), not fixed+added
  assert.equal(d.fixed.length, 0, 'volatile finding not treated as fixed')
  assert.equal(d.added.length, 0, 'volatile finding not treated as added')
  assert.equal(d.remaining.length, 1, 'volatile finding identified as same issue')
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
