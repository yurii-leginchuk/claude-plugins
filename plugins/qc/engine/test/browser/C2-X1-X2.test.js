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

test('X2 does not report a lazy image that loaded after the scroll walk', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(!f.some(x => /lazy-ok/.test(x.found)), 'lazy image must be loaded before measuring')
})

test('X2 stays silent on a clean page', async () => {
  assert.deepEqual(await findingsFor('clean.html', { width: 1440, only: ['X2'] }), [])
})

// Judgement call 3: a data: image with a `loading` attribute is not
// automatically an unresolved placeholder. Some themes legitimately inline a
// tiny transparent GIF as a permanent spacer -- that image will forever be a
// data: URI with no swap ever intended. Decision: only flag when the markup
// also carries a lazy-load swap-target attribute (data-src/data-lazy-src/
// data-original), i.e. there is evidence a real image was supposed to
// replace the placeholder and never did.
test('X2 does not flag a permanent data: spacer with no swap target', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(!f.some(x => /lazy-spacer/.test(x.selector)),
    'a data: pixel with no data-src is a deliberate spacer, not a defect')
})

test('X2 flags a lazy placeholder that never resolved to its data-src target', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  const found = f.find(x => /lazy-unresolved/.test(x.selector))
  assert.ok(found, 'a loading=lazy data: image with an unswapped data-src is a genuine defect')
  assert.match(found.found, /data:/, 'the finding should show the placeholder is still a data: URI')
})
