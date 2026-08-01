import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor } from './harness.js'

test('C1 flags a document that scrolls horizontally', async () => {
  const f = await findingsFor('horizontal-scroll.html', { width: 1440, only: ['C1'] })
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
  assert.equal(f[0].confidence, 'high')
  assert.equal(f[0].engine, 'browser')
  assert.equal(f[0].breakpoint, 1440)
  assert.match(f[0].found, /3000/)
})

test('C1 stays silent on a clean page', async () => {
  const f = await findingsFor('clean.html', { width: 1440, only: ['C1'] })
  assert.deepEqual(f, [])
})

test('C1 flags the same page at a mobile width', async () => {
  const f = await findingsFor('horizontal-scroll.html', { width: 360, only: ['C1'] })
  assert.equal(f.length, 1)
  assert.equal(f[0].breakpoint, 360)
})

test('every browser rule check is self-contained and survives serialisation', async () => {
  const { allBrowserRules } = await import('../../src/rules/browser-index.js')
  const rules = await allBrowserRules()
  assert.ok(rules.length >= 1)
  for (const r of rules) {
    assert.equal(typeof r.id, 'string')
    assert.ok(['critical', 'major', 'minor', 'note'].includes(r.severity))
    assert.ok(['high', 'heuristic'].includes(r.confidence))
    assert.match(r.title, /[Ѐ-ӿ]/, `${r.id} title must be Russian`)
    // A check that closes over module scope throws once serialised.
    assert.doesNotThrow(() => new Function(`return (${r.check.toString()})`)())
  }
})
