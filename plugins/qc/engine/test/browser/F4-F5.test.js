import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor } from './harness.js'

test('F4 flags cursor:pointer on a non-interactive element', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(f.some(x => /fake-button/.test(x.selector)), 'expected the fake button')
  assert.ok(f.every(x => x.severity === 'minor'))
})

test('F4 flags an interactive element without cursor:pointer', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  // #role-no-pointer is a role="button" div: real interactivity (via ARIA
  // role) with no native browser styling to fall back on, so it never gets a
  // pointer cursor unless an author sets one explicitly. This is the case
  // Direction B exists to catch -- see judgement call 1 below for why a
  // plain <button> is deliberately NOT used here.
  assert.ok(f.some(x => /no-pointer/.test(x.selector)))
})

test('F4 accepts a normal link and a normal paragraph', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(!f.some(x => /good-link|plain-text/.test(x.selector)))
})

// --- Judgement call 1: a bare <button> must NOT be flagged -----------------
//
// Measured empirically with Playwright/Chromium (see task-4-report.md): a
// <button> with zero authored CSS computes cursor:default, not pointer. Every
// themed production button (virtually all of them -- sites almost never set
// cursor:pointer on native buttons because the native default already reads
// as "clickable" to users) would trip Direction B if it applied to native
// form controls. That is a false-positive flood, not a real defect, so F4
// excludes native form-control tags (button/input/select/textarea/summary)
// from the "interactive but not pointer" direction entirely. The exclusion
// does not weaken the ARIA case above, which is where the real bugs live.
test('F4 does not flag a bare native <button> lacking cursor:pointer', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(!f.some(x => /bare-button/.test(x.selector)))
})

// --- Judgement call 2: inherited pointer vs. a misleading wrapper ----------
test('F4 does not flag a span that inherits pointer from its link ancestor', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(!f.some(x => /inner-span/.test(x.selector)))
})

test('F4 flags a non-interactive div that wraps a link and sets its own cursor:pointer', async () => {
  // The reverse case: #div-wraps-link is not itself interactive (no href,
  // role, or native control) but declares cursor:pointer, so hovering its
  // padding -- outside the inner <a> -- shows a hand cursor over an area that
  // does nothing. That is a real affordance mismatch, not an inheritance
  // artifact, so it stays flagged; the closest() exclusion only covers
  // elements NESTED INSIDE an interactive ancestor, not elements that merely
  // contain one.
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(f.some(x => /div-wraps-link/.test(x.selector)))
})

test('F5 flags a hover change declared without a transition', async () => {
  const f = await findingsFor('interaction.html', { only: ['F5'] })
  assert.ok(f.some(x => /no-transition/.test(x.selector)))
  assert.ok(f.every(x => x.severity === 'minor'))
})

test('F5 accepts an element whose hover change is transitioned', async () => {
  const f = await findingsFor('interaction.html', { only: ['F5'] })
  assert.ok(!f.some(x => /good-link/.test(x.selector)))
})

// --- Judgement call 3: a :hover rule that changes nothing visible ----------
test('F5 does not flag an empty :hover rule', async () => {
  const f = await findingsFor('interaction.html', { only: ['F5'] })
  assert.ok(!f.some(x => /empty-hover/.test(x.selector)))
})

test('F5 does not flag a :hover rule that only sets a custom property', async () => {
  // A custom-property-only :hover rule (`--x: red`) declares a hover state
  // but changes nothing on its own -- it only matters if something else
  // consumes the variable via var(), which this rule can't see. Treating it
  // as "no hover" avoids a finding we can't substantiate; treating it as
  // "has a hover" would flag every hover-triggered CSS custom-property toggle
  // (a common pattern for theming) regardless of whether it does anything.
  const f = await findingsFor('interaction.html', { only: ['F5'] })
  assert.ok(!f.some(x => /custom-prop-hover/.test(x.selector)))
})
