import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { findingsFor, findingsForContent } from './harness.js'

test('C2 names the element that is wider than the viewport', async () => {
  const f = await findingsFor('overflow-element.html', { width: 360, only: ['C2'] })
  assert.ok(f.length >= 1)
  assert.match(f[0].selector, /culprit/)
  assert.match(f[0].found, /\d+px/)
  assert.equal(f[0].severity, 'major')
})

test('C2 stays silent when everything fits', async () => {
  assert.deepEqual(await findingsFor('clean.html', { width: 1440, only: ['C2'] }), [])
})

test('C2 does not flag an element hidden off-canvas by design', async () => {
  // The fixture has an off-canvas menu at left:-9999px; it must not be reported.
  const f = await findingsFor('overflow-element.html', { width: 1440, only: ['C2'] })
  assert.ok(!f.some(x => /offcanvas/.test(x.selector)))
})

// Judgement call 1: off-canvas elements are normal (mobile menus, slide-in
// panels), not defects. The brief's implementation skips elements entirely
// outside the viewport. Confirm that holds both for a panel parked far to
// the left (left:-9999px) AND one parked past the right edge (left:100%),
// and that a genuinely overflowing element sitting alongside those decoys
// is still caught -- the off-canvas skip must not become a blanket skip.
test('C2 does not flag a slide-in panel parked past the right edge', async () => {
  const f = await findingsFor('overflow-element.html', { width: 1440, only: ['C2'] })
  assert.ok(!f.some(x => /slidein/.test(x.selector)))
})

test('C2 ignores off-canvas decoys at a narrow width too, while still catching the real overflow', async () => {
  const f = await findingsFor('overflow-element.html', { width: 360, only: ['C2'] })
  assert.ok(f.some(x => /culprit/.test(x.selector)), 'genuine overflow must still be reported')
  assert.ok(!f.some(x => /offcanvas/.test(x.selector)), 'left:-9999px decoy must stay silent')
  assert.ok(!f.some(x => /slidein/.test(x.selector)), 'left:100% decoy must stay silent')
})

// --- Clipping ancestors (review, browser-pass fix wave) --------------------
//
// Live evidence (task 11, cleaningny.com): 19 of 34 distinct Majors were C2
// findings reading "2843px at viewport 1440px" on sibling elementor-element
// divs, while C1 saw zero horizontal document scroll on the same pages at the
// same width -- and the crops captured for two of them show a perfectly
// ordinary FAQ accordion. Something was containing the overflow; C2 only ever
// checked whether the PARENT was also over-wide, never whether any ancestor
// clips. Both directions are pinned here, because a check that silences the
// clipped case is only safe if it still reports the escaping one.
test('C2 stays silent for an element whose overflow a clipping ancestor contains', async () => {
  const f = await findingsFor('overflow-clipped.html', { width: 1440, only: ['C2'] })
  assert.ok(!f.some(x => /clipper-inner/.test(x.selector)),
    'overflow-x:hidden on an ancestor that itself fits the viewport hides nothing from view')
  assert.ok(!f.some(x => /scroller-inner/.test(x.selector)),
    'overflow-x:auto on an ancestor makes the overflow reachable by design, not a defect')
})

test('C2 still reports an element that genuinely escapes the viewport', async () => {
  const f = await findingsFor('overflow-clipped.html', { width: 1440, only: ['C2'] })
  const esc = f.find(x => /escaping/.test(x.selector))
  assert.ok(esc, 'an over-wide element with no clipping ancestor must still be reported')
  assert.match(esc.found, /3000px/)
})

// body/html are NOT clipping ancestors: per CSS, overflow on them propagates
// to the viewport instead of clipping inside their own box, and
// `body { overflow-x: hidden }` is precisely the antipattern C2 exists to
// catch -- the content really is cut off, and C1 cannot see it because the
// clip suppresses document scroll. overflow-element.html is that shape.
test('C2 treats body{overflow-x:hidden} as the viewport being clipped, not as a safe container', async () => {
  const f = await findingsFor('overflow-element.html', { width: 360, only: ['C2'] })
  assert.ok(f.some(x => /culprit/.test(x.selector)),
    'a wide element under body{overflow-x:hidden} is cut off, not contained')
})

// C2 is heuristic, not high-confidence: see the header comment in
// src/rules/browser/C2-overflow.js. It must not move the verdict or a
// severity tile while its live false-positive class is unproven either way.
test('C2 findings are heuristic so they cannot move the verdict unconfirmed', async () => {
  const f = await findingsFor('overflow-clipped.html', { width: 1440, only: ['C2'] })
  assert.ok(f.length >= 1)
  assert.ok(f.every(x => x.confidence === 'heuristic'), 'C2 must be heuristic')
  assert.ok(f.every(x => x.severity === 'major'), 'severity is unchanged; only confidence dropped')
})

test('X1 reports a console error and a failed request', async () => {
  const f = await findingsFor('console-errors.html', { width: 1440, only: ['X1'] })
  assert.ok(f.some(x => /boom/.test(x.found)), 'expected the thrown error')
  assert.ok(f.some(x => /404|failed/i.test(x.found)), 'expected the failed request')
  assert.ok(f.every(x => x.severity === 'major'))
})

test('X1 stays silent on a clean page', async () => {
  assert.deepEqual(await findingsFor('clean.html', { width: 1440, only: ['X1'] }), [])
})

// Judgement call 2: real sites load third-party scripts (analytics, chat
// widgets) whose console errors are not the client's defect. Decision: do
// NOT drop them -- a swallowed finding is exactly the "silent failure mode"
// the standing lessons warn about. Instead, tag each console/network event
// with same-origin vs third-party in launch.js's collector, and X1
// downgrades third-party noise to 'minor' while keeping it fully visible
// (selector-free findings still carry the offending URL in `found`). Both
// servers below are loopback-only, so this never touches the public
// internet.
test('X1 downgrades but does not drop an error from a third-party host', async () => {
  const thirdParty = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end("throw new Error('third party boom')")
  })
  await new Promise(r => thirdParty.listen(0, r))
  const thirdPartyBase = `http://127.0.0.1:${thirdParty.address().port}`
  try {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>3p</title></head>
<body><main><h1>3p</h1></main><script src="${thirdPartyBase}/thirdparty.js"></script></body></html>`
    const f = await findingsForContent(html, { width: 1440, only: ['X1'] })
    const tp = f.find(x => /third party boom/.test(x.found))
    assert.ok(tp, 'third-party error must still be reported, not silently dropped')
    assert.equal(tp.severity, 'minor', 'third-party noise is downgraded, not treated as a same-origin defect')
  } finally {
    thirdParty.close()
  }
})

test('X2 reports an image that failed to load', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(f.some(x => /missing\.png/.test(x.found)))
})

// #lazy-ok is a REAL network image (not a data: URI) specifically so this
// test exercises what it claims to: a data: URI never actually defers on
// `loading=lazy` (there's no network fetch to defer), so the original
// data:-URI version of this fixture passed regardless of whether the scroll
// walk ran at all -- and the original assertion checked `.found`, which
// never contains the element's id, so it would have stayed green even if
// the element WERE flagged. Both gaps are closed here: a real asset that
// only loads once preparePage's scroll walk brings it near the viewport,
// and an assertion against `.selector`, which is what the finding actually
// names.
test('X2 does not report a lazy image that loaded after the scroll walk', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(!f.some(x => x.selector && /lazy-ok/.test(x.selector)),
    'a real lazy image must be loaded by the scroll walk before measuring')
})

test('X2 stays silent on a clean page', async () => {
  assert.deepEqual(await findingsFor('clean.html', { width: 1440, only: ['X2'] }), [])
})

// Judgement call 3: a data: image with a `loading` attribute is not
// automatically an unresolved placeholder. Some themes legitimately inline a
// tiny transparent GIF as a permanent spacer -- that image will forever be a
// data: URI with no swap ever intended. Decision: only flag when the markup
// also shows a sign of being lazy-managed -- a data-*src/data-*srcset style
// attribute, a class naming it lazy, or a loading attribute -- i.e. there is
// evidence a real image was supposed to replace the placeholder and never
// did. #lazy-spacer below carries NONE of those three signals (no loading
// attribute either), which is the true "no lazy-loading involved" case the
// legitimate-spacer scenario describes.
test('X2 does not flag a permanent data: spacer with no swap target', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(!f.some(x => /lazy-spacer/.test(x.selector)),
    'a data: pixel with no lazy-management signal at all is a deliberate spacer, not a defect')
})

test('X2 flags a lazy placeholder that never resolved to its data-src target', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  const found = f.find(x => /lazy-unresolved/.test(x.selector))
  assert.ok(found, 'a loading=lazy data: image with an unswapped data-src is a genuine defect')
  assert.match(found.found, /data:/, 'the finding should show the placeholder is still a data: URI')
})

// Follow-up fix (post-review): the enumerated swap-attribute list
// (data-src/data-lazy-src/data-original/data-srcset) missed any other
// same-shaped convention. #lazy-data-attr uses data-lazy (not in the old
// list) as its swap attribute; it is also loading=lazy, which is what
// actually catches it -- the old code required loading=lazy AND an
// enumerated swap attribute (AND), so an unlisted attribute name defeated
// it even with loading=lazy present. The new code treats any one of
// {swap-attribute pattern, lazy class, loading attribute} as sufficient
// (OR), so this now gets caught via the loading signal alone.
test('X2 flags a data: placeholder using an unlisted swap-attribute convention (data-lazy)', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(f.some(x => /lazy-data-attr/.test(x.selector)),
    'data-lazy is not one of the four enumerated names, but loading=lazy is still present -- ' +
    'the OR-based check must not require the attribute name to be on a fixed list')
})

// #lazy-class carries a lazy-load class and NO data attribute and NO
// loading attribute at all -- the old AND-based check could never catch
// this shape (it hard-required loading=lazy). The class signal alone must
// be sufficient under the new OR-based check.
test('X2 flags a data: placeholder identified only by a lazy-load class', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(f.some(x => /lazy-class/.test(x.selector)),
    'a class="lazyload" data: image with no other signal must still be recognised as suspect')
})

// Second follow-up fix (post-re-review): moving the swap-attribute check
// from an enumerated list to a src/srcset-suffix pattern silently dropped
// data-original -- the jQuery Lazy Load plugin's convention, common on
// older WordPress sites, whose name doesn't end in "src" or "srcset". That
// was a real regression, not a trade-off: the old enumerated list caught
// it, the new pattern alone does not. #lazy-original below carries ONLY
// data-original -- no lazy class, no loading attribute -- so it can only be
// caught by the explicit KNOWN_SWAP_ATTR_NAMES allow-list kept beside the
// pattern, not by widening the pattern itself (which would start matching
// unrelated data-* attributes like data-testid).
test('X2 flags a data: placeholder using the data-original convention alone', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(f.some(x => /lazy-original/.test(x.selector)),
    'data-original is the jQuery Lazy Load convention and must be recognised even with no other signal')
})
