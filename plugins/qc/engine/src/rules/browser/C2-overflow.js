export const meta = {
  id: 'C2',
  title: 'Элемент шире вьюпорта',
  severity: 'major',
  confidence: 'high',
}

// Runs inside the page. Self-contained by contract.
export function check(ctx) {
  const vw = document.documentElement.clientWidth
  const out = []
  const seen = {}
  const all = document.querySelectorAll('body *')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    if (!ctx.helpers.visible(el)) continue
    const r = el.getBoundingClientRect()
    // Deliberately off-canvas elements (menus parked far left/right, e.g.
    // left:-9999px or left:100% slide-in panels) are normal, not defects --
    // skip anything entirely outside the viewport before measuring width.
    if (r.right <= 0 || r.left >= vw) continue
    if (r.width <= vw + 1) continue
    // Report the outermost offender only; children inherit their parent's width.
    const p = el.parentElement
    if (p && p !== document.body && p.getBoundingClientRect().width > vw + 1) continue
    const sel = ctx.helpers.selector(el)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'C2', title: 'Элемент шире вьюпорта', severity: 'major', confidence: 'high',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sel,
      found: 'ширина ' + Math.round(r.width) + 'px при вьюпорте ' + vw + 'px',
      expected: 'не шире вьюпорта',
    })
  }
  return out
}
