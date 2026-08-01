import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor, findingsForContent } from './harness.js'

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

// Known gap from the same exclusion, pinned explicitly rather than left only
// in prose: #broken-native-cursor is a <button> with an EXPLICIT, wrong
// cursor (cursor:not-allowed, e.g. from an overzealous reset), not just the
// native default. Because Direction B excludes native form-control tags by
// tag name -- not by "was cursor authored?" -- this genuinely broken button
// is invisible to F4 today, same as the unstyled #bare-button above.
//
// Reasoning for not narrowing further this round: distinguishing "no cursor
// declared" (native default, ~universal, not a bug -- judgement call 1) from
// "author declared a specific wrong cursor" (rare, but a real bug) would
// require the same declared-vs-computed styleSheets read F5 already does for
// transitions, applied to cursor instead. That's a reasonable follow-up, but
// doing it inline here -- under review pressure, without its own dedicated
// judgement pass on precision/recall -- risks the same kind of correctness
// gap this round's F5 fix exists to close. Scope stays as-is; this test
// exists so the gap is visible in the suite instead of only in this comment.
test('F4 does not catch a native <button> with an explicit wrong cursor (known gap)', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(!f.some(x => /broken-native-cursor/.test(x.selector)))
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

// --- Fix: transitions declared on a selector other than the hover rule's --
//
// The original implementation matched a hover rule's declared transition by
// comparing selectorText strings (base of "#x:hover" against some other
// rule's exact selectorText "#x"). That misses every real-world case where
// the transition lives on a DIFFERENT selector that also happens to match
// the same element -- a grouped selector, a shared utility class, or a `*`
// reset. All three are common in production themes, so string-equality
// under-detects transitions and over-reports findings on elements that
// plainly have one. The fix matches per ELEMENT via el.matches(), which
// makes the elements below correctly unflagged.
//
// Each case runs on its own isolated page (via findingsForContent) rather
// than being folded into interaction.html: a page-scoped "a, button" or "*"
// rule would otherwise also cover unrelated elements already used by other
// tests in that shared fixture (e.g. #no-transition is itself an <a>, so a
// page-wide "a, button { transition }" rule would silently make that test
// pass for the wrong reason).

test('F5 does not flag a hover change whose transition is declared on a grouped selector', async () => {
  const html = `<!doctype html><html><head><style>
    a, button { transition: color .2s }
    #grouped-transition:hover{color:red}
  </style></head><body>
    <a id="grouped-transition" href="/e">grouped</a>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F5'] })
  assert.ok(!f.some(x => /grouped-transition/.test(x.selector)))
})

test('F5 does not flag a hover change whose transition is declared on a shared utility class', async () => {
  const html = `<!doctype html><html><head><style>
    .btn{transition:color .2s}
    a.btn:hover{color:red}
  </style></head><body>
    <a id="btn-util" class="btn" href="/f">utility class</a>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F5'] })
  assert.ok(!f.some(x => /btn-util/.test(x.selector)))
})

test('F5 does not flag a hover change covered by a `*` reset', async () => {
  const html = `<!doctype html><html><head><style>
    * { transition: color .2s }
    #star-reset:hover{color:red}
  </style></head><body>
    <div id="star-reset">star reset</div>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F5'] })
  assert.ok(!f.some(x => /star-reset/.test(x.selector)))
})

// preparePage (Task 1) injects its own `*,*::before,*::after{transition:none
// !important}` reset for repeatable measurements. Regression guard: that
// universal rule must NOT be treated as a real declared transition (it's the
// opposite -- an explicit absence), or F5 would go silent on every page.
// #no-transition in interaction.html already exercises this on every run
// (preparePage always injects the reset), but this asserts it explicitly
// against a minimal isolated page so the guard doesn't depend on reading the
// shared fixture's full contents.
test('F5 still flags a plain hover change with no transition anywhere (preparePage\'s injected reset must not suppress it)', async () => {
  const html = `<!doctype html><html><head><style>
    #no-transition-here{color:#06c}
    #no-transition-here:hover{color:#039}
  </style></head><body>
    <a id="no-transition-here" href="/b">no transition</a>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F5'] })
  assert.ok(f.some(x => /no-transition-here/.test(x.selector)))
})
