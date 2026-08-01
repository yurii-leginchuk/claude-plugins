import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor } from './harness.js'

test('F1 flags a link with no declared hover state', async () => {
  const f = await findingsFor('hover.html', { only: ['F1'] })
  assert.ok(f.some(x => /dead-link/.test(x.selector)))
  assert.ok(f.every(x => x.confidence === 'heuristic'), 'F1 must be heuristic')
  assert.ok(f.every(x => x.severity === 'major'))
})

test('F1 accepts a link that declares a hover state', async () => {
  const f = await findingsFor('hover.html', { only: ['F1'] })
  assert.ok(!f.some(x => /live-link/.test(x.selector)))
})

test('J3 flags low-contrast text and is heuristic', async () => {
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  assert.ok(f.some(x => /faint/.test(x.selector)))
  assert.ok(f.every(x => x.confidence === 'heuristic'))
  assert.match(f[0].found, /\d\.\d+:1/)
})

test('J3 accepts high-contrast text', async () => {
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  assert.ok(!f.some(x => /strong/.test(x.selector)))
})

test('J3 skips text over a background image rather than guessing', async () => {
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  assert.ok(!f.some(x => /over-image/.test(x.selector)))
})

test('B6 flags two overlapping visible blocks and is heuristic', async () => {
  const f = await findingsFor('overlap.html', { only: ['B6'] })
  assert.ok(f.length >= 1)
  assert.ok(f.every(x => x.confidence === 'heuristic'))
})

test('B6 does not flag a normal stacked layout', async () => {
  assert.deepEqual(await findingsFor('clean.html', { only: ['B6'] }), [])
})

// --- Judgement call 1: B6 must not flood on a full-page overlay ------------
//
// Measured on overlap-realistic.html (fixed header, fixed cookie banner,
// fixed back-to-top button, an absolutely-positioned open dropdown menu, and
// a fixed modal backdrop + dialog baked "open"): comparing every
// `position:absolute`/`position:fixed` element pairwise (the brief's
// original candidate rule) produced 5 findings, ALL of them the modal
// backdrop paired against every other candidate on the page -- the disjoint
// chrome pieces (header, banner, button, menu) never collided with each
// other at all. A single full-viewport overlay is legitimate, by-design UI,
// not a layout bug, so B6 excludes any candidate whose own footprint covers
// more than half the viewport. That removes all 5 of the measured false
// positives. It deliberately does NOT exclude `position:fixed` wholesale
// (unlike an "absolute-only" alternative that was also measured and
// rejected -- see task-5-report.md): that would also hide the very real bug
// exercised below. See task-5-report.md for the exact measured counts.
test('B6 excludes a full-viewport modal backdrop from comparison', async () => {
  const f = await findingsFor('overlap-realistic.html', { only: ['B6'] })
  assert.ok(!f.some(x => /modal-backdrop/.test(x.selector) || /modal-backdrop/.test(x.found)))
})

test('B6 does not flag a fixed header against unrelated fixed chrome', async () => {
  const f = await findingsFor('overlap-realistic.html', { only: ['B6'] })
  assert.ok(!f.some(x => /header/.test(x.selector) || /header/.test(x.found)))
})

test('B6 still catches a genuine fixed-vs-fixed collision (back-to-top landing inside the cookie banner)', async () => {
  // The back-to-top button and the cookie banner are both position:fixed,
  // small/medium in size, and genuinely overlap -- exactly the kind of real
  // defect the noise-cutting fix above must not blind B6 to.
  const f = await findingsFor('overlap-realistic.html', { only: ['B6'] })
  assert.ok(f.some(x =>
    (/back-to-top/.test(x.selector) && /cookie-banner/.test(x.found)) ||
    (/cookie-banner/.test(x.selector) && /back-to-top/.test(x.found))
  ))
})

// --- Judgement call 2: J3 and inherited/composited backgrounds -------------

test('J3 walks up to a distant ancestor to find its background color', async () => {
  // #distant-dark has no background of its own; the nearest opaque
  // background lives three levels up on .dark-section (#111). White text on
  // #111 is ~15.3:1, comfortably above 4.5:1, so this must NOT be flagged --
  // if it were flagged (or silently skipped), the ancestor walk would be
  // broken rather than merely conservative.
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  assert.ok(!f.some(x => /distant-dark/.test(x.selector)))
})

test('J3 composites a semi-transparent background instead of treating it as opaque', async () => {
  // .overlay is rgba(0,0,0,.85) with the page's white canvas behind it (no
  // background-image anywhere in the chain), which composites to a near-black
  // ~ (38,38,38). White text on that is still high contrast, so this must not
  // be flagged -- it exists to prove the alpha is actually composited rather
  // than the naive "ignore alpha, use the raw rgb" reading, which would
  // silently treat rgba(0,0,0,.85) as pure black (immaterial here since both
  // readings pass) but corrupts the readings for JS-inspectable
  // page-level overlay a real audit hits far more often, see report.
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  assert.ok(!f.some(x => /over-overlay/.test(x.selector)))
})

// --- Judgement call 3: F1 and hover declared on a parent selector ----------

test('F1 accepts a link whose color changes via an ancestor .card:hover rule', async () => {
  // `.card:hover a { color: red }` never mentions `a:hover` directly -- the
  // link only changes because the browser also matches :hover on .card while
  // the link (its descendant) is being hovered. Naively looking only for a
  // selector where the CANDIDATE element itself carries :hover would flag
  // this as "no hover reaction", which is wrong: the link visibly changes.
  const f = await findingsFor('hover.html', { only: ['F1'] })
  assert.ok(!f.some(x => /card-link/.test(x.selector)))
})

test('F1 accepts a toggle button whose hover only changes a sibling/descendant element', async () => {
  // `.dropdown:hover .menu { display:block }` is the mirror case: hovering
  // the BUTTON itself is what triggers the change, but the changed element
  // (.menu) is not the button. The button must not be flagged as having no
  // hover reaction just because the change lands elsewhere.
  const f = await findingsFor('hover.html', { only: ['F1'] })
  assert.ok(!f.some(x => /dropdown-toggle/.test(x.selector)))
})
