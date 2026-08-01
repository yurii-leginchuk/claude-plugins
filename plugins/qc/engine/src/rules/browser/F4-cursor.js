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
  const NATIVE_FORM_TAGS = ['button', 'input', 'select', 'textarea', 'summary']

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
      if (el.closest('a[href], button, [role="button"]')) continue
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
