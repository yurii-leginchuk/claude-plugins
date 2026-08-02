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

// --- Fix (task 11, live-run calibration): cursor-inheritance nesting -------
//
// `cursor` is an inherited CSS property. A decorative icon chain (a real
// dropdown arrow's <span> > <i> > <svg> > <path>, common with Font-Awesome
// rendered as inline SVG) computes the SAME cursor:pointer at every nested
// level once the outermost wrapper is mis-styled, purely through
// inheritance -- not because each level declares its own cursor. Measured
// live against cleaningny.com: this pattern alone produced 39 raw findings
// (3 nesting levels x 13 occurrences) for what is really ONE visual element
// repeated across pages/widths.
test('F4 does not report the same inherited cursor at every nesting level of a decorative icon', async () => {
  const html = `<!doctype html><html><head><style>
    .arrow{cursor:pointer}
  </style></head><body>
    <span class="arrow" id="arrow"><i id="icon"><svg id="svg-el"><path id="path-el" d="M0 0"></path></svg></i></span>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  const pointerOnNonInteractive = f.filter(x => x.found.includes('неинтерактивном'))
  assert.equal(pointerOnNonInteractive.length, 1, 'only the outermost element that actually declares cursor:pointer should be reported')
  assert.ok(pointerOnNonInteractive[0].selector.includes('arrow') || /span/.test(pointerOnNonInteractive[0].selector))
})

test('F4 still flags a wrapper that itself has its own explicit cursor:pointer, independent of inheritance', async () => {
  // Sanity check the fix above only collapses INHERITED duplicates, not
  // every non-interactive pointer element: two SIBLING wrappers each
  // declaring their own cursor:pointer must both still be reported.
  const html = `<!doctype html><html><head><style>
    #a{cursor:pointer} #b{cursor:pointer}
  </style></head><body>
    <div id="a">one</div><div id="b">two</div>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(f.some(x => /#a\b/.test(x.selector) || x.selector === 'div#a'))
  assert.ok(f.some(x => /#b\b/.test(x.selector) || x.selector === 'div#b'))
})

// --- Fix (task 11, live-run calibration): <label> is genuinely interactive -
//
// A <label for=...> (or one wrapping its control) is clickable by native
// browser behaviour -- clicking it focuses/toggles the control it labels --
// even though it has no BUILT-IN pointer cursor of its own the way a link
// does. Measured live: every Gravity Forms radio-option label on a real
// form was flagged "cursor:pointer on a non-interactive element" purely
// because helpers.interactive() didn't know about <label> at all -- 70
// occurrences, the single largest F4 false-positive bucket on the run.
test('F4 accepts a <label for> with cursor:pointer -- it is genuinely interactive, not a mismatch', async () => {
  const html = `<!doctype html><html><head><style>label{cursor:pointer}</style></head><body>
    <input type="checkbox" id="opt">
    <label for="opt" id="opt-label">choose me</label>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(!f.some(x => /opt-label/.test(x.selector)))
})

test('F4 accepts a <label> wrapping its control directly (no `for`) with cursor:pointer', async () => {
  const html = `<!doctype html><html><head><style>label{cursor:pointer}</style></head><body>
    <label id="wrap-label"><input type="checkbox"> choose me</label>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(!f.some(x => /wrap-label/.test(x.selector)))
})

test('F4 does not newly flag an unstyled <label> as "interactive but missing pointer"', async () => {
  // The symmetric risk of the fix above: now that <label> is interactive,
  // Direction B (interactive, cursor != pointer) could newly flood on every
  // plain label that never bothered authoring cursor:pointer -- extremely
  // common, since the checkbox itself is what's actually clickable. label
  // is excluded from Direction B for the same reason native form controls
  // already are.
  const html = `<!doctype html><html><body>
    <input type="checkbox" id="opt2">
    <label for="opt2" id="plain-label">no explicit cursor styling at all</label>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(!f.some(x => /plain-label/.test(x.selector)))
})

// --- Fix (task 11, live-run calibration): machine-generated ids destabilise
// defectIdentity ------------------------------------------------------------
//
// helpers.selector() used to trust ANY non-empty `id` unconditionally.
// Measured live: a SmartMenus-style nav plugin assigns `id="sm-<17 digit
// number>-3"` fresh on every page render -- the SAME dropdown-arrow toggle
// link, structurally identical every time, produced a DIFFERENT selector
// string (and therefore a different defectIdentity, report/json.js) on
// every single page/width combination: 13 raw occurrences became 13
// "distinct" findings for one real defect, the dominant contributor to F4's
// inflated distinct count on the live run.
test('F4 does not let a long machine-generated numeric id defeat identity collapsing', async () => {
  const pageWithId = (id) => `<!doctype html><html><head><style>#wrap{cursor:pointer}</style></head><body>
    <div id="wrap"><a id="${id}" href="#">toggle</a></div>
  </body></html>`
  const a = await findingsForContent(pageWithId('sm-17856341663330366-3'), { only: ['F4'] })
  const b = await findingsForContent(pageWithId('sm-99912340000000001-3'), { only: ['F4'] })
  const findWrap = (f) => f.find(x => x.found.includes('неинтерактивном'))
  const fa = findWrap(a)
  const fb = findWrap(b)
  assert.ok(fa && fb, 'both runs must still produce the #wrap finding')
  assert.ok(!/\d{10,}/.test(fa.selector), 'the long-digit id must not appear in the selector at all')
  assert.equal(fa.selector, fb.selector, 'two structurally-identical elements with different generated ids must resolve to the SAME selector')
})

test('F4 still uses a normal short numeric id (unaffected by the machine-generated-id heuristic)', async () => {
  const html = `<!doctype html><html><head><style>#menu-item-42{cursor:pointer}</style></head><body>
    <div id="menu-item-42">not associated with anything</div>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(f.some(x => x.selector === 'div#menu-item-42'))
})

// --- Fix (task 11, live-run calibration): aria-haspopup submenu toggles ----
//
// A nav item that is purely a submenu TOGGLE -- authored as `<a
// aria-haspopup="true" aria-expanded="false">` with no `href` at all, since
// it has no single destination page of its own -- is genuinely interactive
// (clicking it opens the submenu), but helpers.interactive()'s `<a>` branch
// only ever checked `hasAttribute('href')`. Measured live: this was the ONE
// false positive that survived the label/nesting/id fixes above, on a real
// SmartMenus-driven Elementor nav ("Locations" toggle with no direct page).
test('F4 accepts an aria-haspopup submenu toggle with no href', async () => {
  const html = `<!doctype html><html><head><style>.toggle{cursor:pointer}</style></head><body>
    <a class="toggle" id="toggle" aria-haspopup="true" aria-expanded="false">Locations</a>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(!f.some(x => /toggle/.test(x.selector)))
})

test('F4 accepts a span inheriting pointer from an aria-haspopup ancestor (not just a[href]/button/role=button)', async () => {
  // The "inherits from a real interactive ancestor" exclusion used to be a
  // separately hardcoded selector list that did not know about
  // aria-haspopup (or label) -- so even after the toggle itself stopped
  // being flagged, its inner decorative span still was. This pins the
  // ancestor walk staying in sync with interactive()'s own definition.
  const html = `<!doctype html><html><head><style>.toggle{cursor:pointer}</style></head><body>
    <a class="toggle" id="toggle" aria-haspopup="true"><span id="arrow-span">v</span></a>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(!f.some(x => /toggle|arrow-span/.test(x.selector)))
})

test('F4 does not treat aria-haspopup="false" as interactive', async () => {
  const html = `<!doctype html><html><head><style>#lonely2{cursor:pointer}</style></head><body>
    <div id="lonely2" aria-haspopup="false">not actually a toggle</div>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(f.some(x => /lonely2/.test(x.selector)))
})

test('F4 does not treat a plain, unassociated <label> as interactive', async () => {
  // A label with neither `for` nor a wrapped control is not made
  // interactive by the fix -- it genuinely has no clickable effect, so a
  // cursor:pointer on it (if wrongly authored) is still a real mismatch.
  const html = `<!doctype html><html><head><style>#lonely{cursor:pointer}</style></head><body>
    <label id="lonely">not associated with anything</label>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F4'] })
  assert.ok(f.some(x => /lonely/.test(x.selector)))
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

// --- Fix (task 11, live-run calibration): grouped selectors with a non-hover
// sibling compound ----------------------------------------------------------
//
// F5's base/target derivation used to strip ':hover' from the WHOLE
// selectorText of a rule, even when that text grouped several comma-separated
// compounds together and only ONE of them actually carried ':hover'. Measured
// live against cleaningny.com: a real rule grouped a genuine
// "...menu-toggle:focus:hover" compound alongside five unrelated sibling
// compounds (a dropdown menu's plain `a`, `a:focus`, `a.elementor-item-active`,
// `a.highlighted`, and the bare `.elementor-menu-toggle`, none of which
// mention ':hover' at all) -- the old whole-string strip folded all six into
// one querySelectorAll() target, flagging nav links and a toggle button that
// have nothing to do with the actual hover rule. 657 raw findings, the single
// largest noise source of the whole browser pass.

test('F5 does not flag an unrelated sibling compound sharing a rule with a real :hover compound', async () => {
  const html = `<!doctype html><html><head><style>
    .menu a, .menu a:focus, .menu-toggle, .menu-toggle:hover { color: red }
  </style></head><body>
    <div class="menu"><a id="menu-link" href="/x">menu link</a></div>
    <button class="menu-toggle" id="toggle">menu</button>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F5'] })
  assert.ok(
    !f.some(x => /menu-link/.test(x.selector)),
    'the plain ".menu a"/".menu a:focus" compounds never mention :hover and must not become a target'
  )
})

test('F5 still flags the ACTUAL :hover compound within a grouped selector', async () => {
  const html = `<!doctype html><html><head><style>
    .menu a, .menu-toggle, .menu-toggle:hover { color: red }
  </style></head><body>
    <button class="menu-toggle" id="toggle">menu</button>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F5'] })
  assert.ok(
    f.some(x => x.selector.includes('toggle') && x.found === 'правило .menu-toggle:hover меняет стиль без transition'),
    'the compound that DOES carry :hover (.menu-toggle:hover) is still caught, with a clean base'
  )
})

test('F5 does not fold "a:active" into the base of a grouped "a:active, a:hover" rule', async () => {
  const html = `<!doctype html><html><head><style>
    a:active, a:hover { color: red }
  </style></head><body>
    <a id="link" href="/x">link</a>
  </body></html>`
  const f = await findingsForContent(html, { only: ['F5'] })
  const finding = f.find(x => /link/.test(x.selector))
  assert.ok(finding, 'the a:hover compound (bare "a") still legitimately matches this link')
  assert.equal(finding.found, 'правило a:hover меняет стиль без transition', 'the base must not still carry the unrelated ":active" compound')
})
