export const meta = {
  id: 'B6',
  title: 'Перекрытие элементов',
  severity: 'major',
  confidence: 'heuristic',
}

// Runs inside the page. Self-contained by contract -- see _helpers.js's
// top-of-file comment.
export function check(ctx) {
  // Only compare elements positioned out of normal flow -- normal flow does
  // not overlap, and comparing everything is O(n^2) noise.
  //
  // Judgement call (measured on test/browser/fixtures/overlap-realistic.html,
  // a fixture with a fixed header, a fixed cookie banner, a fixed
  // back-to-top button, an absolutely-positioned open dropdown menu, and a
  // fixed modal backdrop + dialog): comparing every absolute/fixed element
  // pairwise found that disjoint pieces of fixed UI chrome (header, banner,
  // button) essentially never collide with EACH OTHER in a normal layout --
  // they occupy different screen regions by construction, so restricting the
  // candidate set to "absolute" only (dropping "fixed" entirely) turned out
  // to be unnecessary AND harmful: it would also hide a genuine, common bug
  // (e.g. a later-added cookie banner covering an existing fixed
  // back-to-top button). The actual, measured, dominant noise source was
  // different: a single full-viewport overlay (a modal backdrop or a mobile
  // nav drawer baked "open" in the DOM, as a real page can be crawled
  // mid-interaction) structurally overlaps EVERY other absolute/fixed
  // candidate at once, turning one legitimate, by-design element into one
  // finding per other candidate on the page. Excluding any candidate whose
  // own footprint covers more than half the viewport removes that source
  // entirely while leaving small/medium chrome (headers, banners, buttons,
  // menus, badges) fully compared against each other, including real
  // fixed-vs-fixed collisions. See task-5-report.md for the exact measured
  // counts.
  const candidates = []
  const all = document.querySelectorAll('body *')
  const viewportArea = window.innerWidth * window.innerHeight
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    if (!ctx.helpers.visible(el)) continue
    const cs = getComputedStyle(el)
    if (cs.position !== 'absolute' && cs.position !== 'fixed') continue
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    if (viewportArea > 0 && (r.width * r.height) > 0.5 * viewportArea) continue   // full-page overlay, not a layout bug
    candidates.push({ el: el, r: r })
    if (candidates.length > 150) break        // guard against pathological pages
  }

  const out = []
  const seen = {}
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (ox <= 2 || oy <= 2) continue
      const area = ox * oy
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height)
      if (area / smaller < 0.25) continue      // a nudge is not an overlap
      const sa = ctx.helpers.selector(a.el)
      const sb = ctx.helpers.selector(b.el)
      const key = sa + '|' + sb
      if (seen[key]) continue
      seen[key] = 1
      out.push({
        rule: 'B6', title: 'Перекрытие элементов', severity: 'major', confidence: 'heuristic',
        engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sa,
        found: 'перекрывается с ' + sb + ' на ' + Math.round(area) + 'px²',
        expected: 'элементы не должны накладываться',
      })
    }
  }
  return out
}
