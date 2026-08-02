import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor } from './harness.js'

// Pins the try/catch in bundle.js's window.__qc.run() loop. Eight more rules
// will run through that loop; if an edit ever breaks the isolation, findings
// would just go quietly missing on a live crawl instead of failing a test.
// The throwing rule is injected via findingsFor's extraRules -- NOT as a file
// in src/rules/browser/, since that directory is the production registry and
// a stub there would become a live rule.
test('a crashing rule does not swallow the other rules\' findings', async () => {
  const throwing = {
    id: 'ZZ_TEST_THROW',
    check: function () { throw new Error('boom from ZZ_TEST_THROW') },
  }

  const findings = await findingsFor('horizontal-scroll.html', {
    width: 1440,
    extraRules: [throwing],
  })

  const c1 = findings.filter(f => f.rule === 'C1')
  assert.equal(c1.length, 1, 'the healthy rule (C1) still reports despite a sibling crashing')
  assert.match(c1[0].found, /3000/)

  const crashed = findings.filter(f => f.rule === 'ZZ_TEST_THROW')
  assert.equal(crashed.length, 1, 'the crashing rule yields exactly one finding naming itself')
  assert.equal(crashed[0].severity, 'note')
  assert.equal(crashed[0].engine, 'browser')
  assert.match(crashed[0].found, /boom from ZZ_TEST_THROW/)
})
