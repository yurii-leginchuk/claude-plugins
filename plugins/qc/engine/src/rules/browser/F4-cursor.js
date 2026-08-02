export const meta = {
  id: 'F4',
  title: 'Курсор не соответствует интерактивности',
  severity: 'minor',
  confidence: 'high',
}

// Runs inside the page. Self-contained by contract -- see _helpers.js's
// top-of-file comment for why every constant this needs must live inside
// check() rather than at module scope.
export function check(ctx) {
  // Judgement call (measured empirically with Playwright/Chromium, see
  // task-4-report.md): a bare <button> with zero authored CSS computes
  // cursor:default, not pointer -- confirmed by inspecting getComputedStyle()
  // on an unstyled <button> in this exact Chromium build. Native <select> and
  // <input> behave the same way (default/text, per their own convention).
  // Virtually no production site sets cursor:pointer on its native form
  // controls explicitly, because the native default already reads as
  // "clickable" -- so checking these tags in the "interactive but missing
  // pointer" direction would flag nearly every themed button on the web.
  // That is a false-positive flood, not a real defect, so native form-control
  // tags are excluded from that direction entirely. The exclusion does not
  // touch the other direction (non-interactive element wrongly showing
  // pointer) or ARIA-role elements below, which is where the real bug lives:
  // browsers do NOT supply a pointer cursor for role="button" automatically,
  // so a themed div/span with that role and no explicit cursor CSS genuinely
  // looks non-interactive on hover.
  // 'label' added alongside the native controls (task 11 calibration,
  // helpers.interactive() now recognises a <label for=...>/wrapping-a-control
  // as interactive -- see that comment for the false-positive it fixes on
  // Direction A). It stays out of the "missing pointer" direction below for
  // the SAME class of reason as the native controls: a <label> has no
  // built-in "looks clickable" affordance the way a themed button does, but
  // NOT authoring cursor:pointer on it is nonetheless extremely common --
  // the input/checkbox it labels is what's actually interactive, and
  // clicking the label activates it via the native `for`/wrapping
  // relationship regardless of the label's own cursor style. Enforcing
  // Direction B on every plain <label> risks trading the false positives
  // this task measured (Direction A) for a new, unmeasured flood in the
  // opposite direction on a site with many unstyled labels.
  const NATIVE_FORM_TAGS = ['button', 'input', 'select', 'textarea', 'summary', 'label']

  const out = []
  const all = document.querySelectorAll('body *')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    if (!ctx.helpers.visible(el)) continue
    const cursor = getComputedStyle(el).cursor
    const isInteractive = ctx.helpers.interactive(el)
    const sel = ctx.helpers.selector(el)
    const tag = el.tagName.toLowerCase()

    if (!isInteractive && cursor === 'pointer') {
      // An inner span of a link inherits pointer legitimately -- skip
      // anything nested inside a real interactive ancestor. This does NOT
      // cover the reverse case (a non-interactive wrapper that itself
      // declares cursor:pointer around an interactive child): hovering that
      // wrapper's own padding, outside the child, still shows a hand cursor
      // over an area that does nothing, which is the exact affordance
      // mismatch this rule exists to catch.
      //
      // Walks up via ctx.helpers.interactive() itself -- the SAME definition
      // used for `el` above -- rather than a separately hardcoded selector
      // list. A hardcoded `closest('a[href], button, [role="button"]')` used
      // to live here and silently drifted out of sync the moment
      // interactive() grew new cases (label, aria-haspopup): measured live
      // (task 11, cleaningny.com), a submenu toggle's inner `.sub-arrow`
      // span was still flagged even after the toggle `<a>` itself (an
      // aria-haspopup element with no href) was correctly recognised as
      // interactive, because THIS check never learned about that case.
      let ancestor = el.parentElement
      let hasInteractiveAncestor = false
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        if (ctx.helpers.interactive(ancestor)) { hasInteractiveAncestor = true; break }
        ancestor = ancestor.parentElement
      }
      if (hasInteractiveAncestor) continue
      // `cursor` is an inherited CSS property: a decorative icon nested
      // several levels deep (a dropdown arrow's <span> > <i> > <svg> >
      // <path>, a common Font-Awesome-as-SVG rendering) computes the SAME
      // cursor:pointer as its ancestor purely through inheritance, not
      // because each level declares its own. Flagging every level reports
      // the SAME defect 3-4 times. Measured live (task 11, cleaningny.com):
      // exactly this chain produced 3 separate findings for one visual
      // element. Skip a candidate whose DIRECT parent already computes the
      // identical cursor and is not itself genuinely interactive (an
      // interactive parent is already excluded above via closest()) --
      // this only collapses pure inheritance chains; a descendant that
      // declares its OWN different cursor value never matches this check.
      const parent = el.parentElement
      if (parent && parent !== document.body && parent !== document.documentElement &&
          getComputedStyle(parent).cursor === cursor && !ctx.helpers.interactive(parent)) continue
      out.push({
        rule: 'F4', title: 'Курсор не соответствует интерактивности', severity: 'minor',
        confidence: 'high', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
        selector: sel, containerId: ctx.helpers.containerId(el),
        found: 'cursor:pointer на неинтерактивном элементе',
        expected: 'cursor:default',
      })
      continue
    }

    if (isInteractive && cursor !== 'pointer' && !el.disabled && !NATIVE_FORM_TAGS.includes(tag)) {
      out.push({
        rule: 'F4', title: 'Курсор не соответствует интерактивности', severity: 'minor',
        confidence: 'high', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
        selector: sel, containerId: ctx.helpers.containerId(el),
        found: 'cursor:' + cursor + ' на интерактивном элементе',
        expected: 'cursor:pointer',
      })
    }
  }
  return out
}
