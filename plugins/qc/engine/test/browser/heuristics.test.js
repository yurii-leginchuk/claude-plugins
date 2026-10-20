import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor, findingsForContent } from './harness.js'

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

// The realistic-chrome fixture must not just contain the one genuine
// collision -- it must produce ONLY that one finding. Any other pairing
// (header, dropdown menu, modal backdrop, modal dialog) would be noise.
test('B6 produces exactly the one genuine finding on the realistic-chrome page, nothing else', async () => {
  const f = await findingsFor('overlap-realistic.html', { only: ['B6'] })
  assert.equal(f.length, 1)
})

// Review-round regression: the original 50%-viewport-area cut applied to
// BOTH `absolute` and `fixed` candidates, which eliminates noise from real
// full-page overlays (modals, drawers) but also silently drops ordinary
// full-bleed decorative content -- e.g. a hero background implemented as a
// `position:absolute` div covering most of the viewport, ordinary Elementor
// output, not an overlay. Once that decorative layer is excluded from the
// candidate set, there is nothing left to compare a genuinely mispositioned
// panel against, and B6 goes silent on a real bug. The fix narrows the
// area-based cut to `position:fixed` only -- real modals/drawers/backdrops
// are virtually always `fixed` (frequently `inset:0`), while ordinary
// full-bleed page content laid out with `position:absolute` is not, so this
// keeps the noise cut without discarding legitimate candidates.
test('B6 flags a mispositioned panel over a full-bleed ABSOLUTE decorative layer (the layer must stay a candidate)', async () => {
  const f = await findingsFor('overlap-fullbleed.html', { only: ['B6'] })
  assert.ok(f.some(x =>
    (/hero-bg/.test(x.selector) && /stray-panel/.test(x.found)) ||
    (/stray-panel/.test(x.selector) && /hero-bg/.test(x.found))
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

// Review-round addition: the alpha-compositing fix is load-bearing (it
// changes whether a real finding fires, not just its exact ratio), but
// nothing before this pinned a case where the naive "ignore alpha, use the
// raw rgb" reading and the correct composited reading actually disagree on
// PASS vs FAIL. #translucent-fail is #333 text inside
// rgba(255,255,255,.3) on a #000 section: naively (alpha ignored, treated
// as opaque white) that reads ~12.63:1 -- comfortably passing, would NOT be
// flagged. Composited correctly (30% white over solid black, per source-over
// alpha blending) it resolves to a mid-gray (~rgb(77,77,77)) behind #333
// text, which reads ~1.48:1 -- well under the 4.5:1 minimum, and must be
// flagged. This is the case that would fail silently (revert to the naive
// reading) if the compositing path ever regresses.
test('J3 flags dark text over a translucent white panel on a black section (naive reading would wrongly pass)', async () => {
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  const finding = f.find(x => /translucent-fail/.test(x.selector))
  assert.ok(finding, 'expected #translucent-fail to be flagged')
  assert.equal(finding.confidence, 'heuristic')
  const ratio = parseFloat(/^contrast ([\d.]+):1/.exec(finding.found)[1])
  assert.ok(ratio < 4.5, `expected a low composited ratio, got ${ratio}`)
  assert.ok(ratio > 1, `expected a plausible contrast ratio, got ${ratio}`)
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

// --- Fix (task 11, live-run calibration): grouped selectors with a non-hover
// sibling compound ----------------------------------------------------------
//
// Same bug shape as F5's grouped-selector fix (see F4-F5.test.js), opposite
// symptom: F1's `targets` used to strip ':hover' from the WHOLE selectorText
// of a rule, so a sibling compound that never carries ':hover' at all (here,
// the plain ".menu a") got folded into the target and marked every matching
// candidate "covered by a hover rule" -- hiding a genuine "no hover
// reaction" finding. Measured live against cleaningny.com: F1 produced ZERO
// findings across 7 successfully-checked pages, and grouped selectors this
// shape (real ones, not contrived) are why.
test('F1 does not treat an unrelated sibling compound in a grouped selector as "covered"', async () => {
  const html = `<!doctype html><html><head><style>
    .menu a, .menu a:focus, .menu-toggle:hover { color: red }
  </style></head><body>
    <div class="menu"><a id="menu-link" href="/x">menu link</a></div>
    <button class="menu-toggle" id="toggle">menu</button>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F1'] })
  assert.ok(
    f.some(x => /menu-link/.test(x.selector)),
    'the plain ".menu a" link has no real hover rule of its own and must be flagged'
  )
  assert.ok(
    !f.some(x => /toggle/.test(x.selector)),
    'the button genuinely covered by ".menu-toggle:hover" must stay accepted'
  )
})
