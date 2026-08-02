import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serialiseHelpers } from '../../src/browser/bundle.js'
import { helpers } from '../../src/rules/browser/_helpers.js'

// Fast (no browser) contract test for the helpers object specifically. The
// per-rule contract test in C1.test.js only iterates allBrowserRules() -- it
// never touches _helpers.js. Before this test existed, a broken helpers
// serialisation was only caught incidentally because a full browser fixture
// test evaluates the whole bundle and window.__qc must exist for it to run.
// That's real coverage, but it diagnoses nothing and depends on at least one
// full-browser test continuing to exist.

test('serialised helpers parse via new Function', () => {
  const src = serialiseHelpers(helpers)
  assert.doesNotThrow(() => new Function(`return (${src})`)())
})

test('a serialised helper still behaves correctly after serialisation, including `this` binding', () => {
  // contrast() calls this.luminance() -- the case that breaks on `this`
  // binding, not on syntax, so a plain parse check would miss it.
  const src = serialiseHelpers(helpers)
  const serialised = new Function(`return (${src})`)()

  const black = [0, 0, 0]
  const white = [255, 255, 255]

  const direct = helpers.contrast(black, white)
  const viaSerialised = serialised.contrast(black, white)

  assert.equal(typeof viaSerialised, 'number')
  assert.ok(!Number.isNaN(viaSerialised))
  assert.equal(viaSerialised, direct, 'serialised contrast() must match the unserialised result exactly')
  // Black on white is maximal contrast (WCAG ratio 21:1) -- a sane, checkable
  // value, not just "didn't throw".
  assert.ok(viaSerialised > 20, `expected near-maximal contrast, got ${viaSerialised}`)

  // Same-color contrast must be exactly 1 -- another concrete anchor beyond
  // "some number came back".
  const grey = [128, 128, 128]
  assert.equal(serialised.contrast(grey, grey), 1)
})
