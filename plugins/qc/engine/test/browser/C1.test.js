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
    assert.match(r.title, /^[A-Z][\x20-\x7E]*$/, `${r.id} title must be English`)
    // A check that closes over module scope throws once serialised.
    assert.doesNotThrow(() => new Function(`return (${r.check.toString()})`)())
  }
})

// The parse check above only proves the source is syntactically valid on its
// own -- `new Function(...)` never calls the result, so a reference to
// something outside the function body (a module-scope const, an import) is
// invisible to it: it parses fine and only throws once the function
// actually RUNS with that binding missing. That gap let a real bug through
// (X2's first KNOWN_SWAP_ATTR_NAMES draft, declared as a module-scope const
// and referenced from inside check() -- valid, parseable, and completely
// broken the moment the bundle executed in a page). This test closes that
// gap by actually running every rule's bundled check() in a browser, not
// just parsing it.
//
// A truly empty page (plain about:blank, zero elements in <body>) was tried
// first and does NOT work: verified empirically that document.body.children
// is 0 there, which means every per-element loop (C2 over `body *`, X2 over
// `img`) and every per-entry loop (X1 over window.__qcConsole) executes zero
// iterations -- so a bug living *inside* one of those loop bodies, exactly
// where the real X2 bug lived, never runs and the test stays green for the
// wrong reason. Confirmed this concretely: reintroducing the exact
// module-scope bug against plain about:blank left this test passing.
//
// So instead of "blank", this uses a minimal inline page (still no fixture
// file, no server -- page.setContent()) that guarantees at least one element
// for every current rule's loop to iterate over, plus a manually seeded
// window.__qcConsole entry for X1's loop. Real findings from this content
// are expected and irrelevant -- the assertion only ever looks at the
// bundle's crash marker (see bundle.js's try/catch), which is unambiguous
// regardless of how many legitimate findings also come back alongside it.
//
// Task 4 (F4/F5) extended this content: without a <style> element,
// document.styleSheets is empty, so F5's sheet/cssRules/hover-match loops
// would all run zero iterations -- the exact "loop body never runs" gap this
// test was written to close (see above). The added <style> block declares a
// real :hover rule matching the existing <a> so F5's full path executes. The
// added <button> exercises F4's native-form-control exclusion branch.
//
// Task 5 (F1/J3/B6) extended this content again, for the same reason. B6
// only iterates candidates whose computed position is absolute/fixed -- with
// none present, its entire pairwise comparison loop (including the
// el.contains()/overlap-math/ctx.helpers.selector path where a bug would
// actually live) ran zero iterations despite the outer "collect candidates"
// loop technically executing. The two added <div>s are absolutely positioned
// and genuinely overlap, so B6's full path -- including pushing a finding --
// executes here. F1 and J3 needed no further additions: F1 already gets a
// covered <a> and an uncovered <button> from the existing markup/style, and
// J3 already gets text-bearing elements to walk (<div>, <a>, <button>) with
// no background anywhere in the chain, exercising its compositing walk.
test('every browser rule check executes without crashing (module-scope contract)', async () => {
  const { launchBrowser } = await import('../../src/browser/launch.js')
  const { buildBundle } = await import('../../src/browser/bundle.js')

  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await page.setContent(`<!doctype html><html lang="en"><head>
      <style>a:hover{color:red}
      body{position:relative}
      .ov-a{position:absolute;left:10px;top:10px;width:60px;height:60px;background:#fdd}
      .ov-b{position:absolute;left:30px;top:30px;width:60px;height:60px;background:#ddf}
      </style>
      </head><body>
      <div>content</div>
      <a href="/">link</a>
      <button>plain button</button>
      <img alt="x" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      <div class="ov-a">a</div>
      <div class="ov-b">b</div>
    </body></html>`)
    // X1 reads this array rather than iterating live DOM; seed one entry so
    // its loop body executes at least once too.
    await page.evaluate(() => { window.__qcConsole = ['same-origin: console: smoke test entry'] })

    const bundle = await buildBundle()
    await page.evaluate(bundle)
    const findings = await page.evaluate(
      (ctx) => window.__qc.run(ctx),
      { url: 'http://smoke-test.invalid/', breakpoint: 1440 }
    )
    // bundle.js's window.__qc.run() catches a throwing check and turns it
    // into a { title: 'Rule crashed', rule: <id>, found: 'rule crashed: ...' }
    // finding instead of losing the whole run -- see crash-isolation.test.js.
    // That's exactly the signal to assert on here.
    const crashed = findings.filter(f => f.title === 'Rule crashed')
    const names = crashed.map(f => `${f.rule} (${f.found})`).join('; ')
    assert.equal(crashed.length, 0,
      `rule(s) crashed, which should be impossible on this content -- ` +
      `most likely a check closing over module scope: ${names}`)
  } finally {
    await browser.close()
  }
})
