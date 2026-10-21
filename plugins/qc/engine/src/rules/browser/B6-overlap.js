export const meta = {
  id: 'B6',
  title: 'Overlapping elements',
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
  // finding per other candidate on the page.
  //
  // Review-round correction: the first version of this fix excluded ANY
  // candidate (absolute or fixed) whose own footprint covered more than
  // half the viewport. That over-corrected -- it also excludes ordinary,
  // legitimate `position:absolute` page content that happens to be large,
  // most commonly a full-bleed decorative hero background implemented as an
  // absolutely-positioned div rather than a background-image (routine
  // Elementor/page-builder output). Once that layer is dropped from the
  // candidate set, there is nothing left to compare a genuinely
  // mispositioned panel sitting on top of it against, so B6 goes silent on
  // a real bug -- a silent miss, which never surfaces and never gets
  // calibrated away the way visible noise does. Real modals, drawers and
  // full-screen overlays are virtually always `position:fixed` (frequently
  // `inset:0`); ordinary large page content is essentially never `fixed`.
  // The area-based exclusion is therefore scoped to `fixed` candidates only
  // -- it removes the same measured noise source without discarding
  // absolutely-positioned page content. See task-5-report.md for the exact
  // measured counts, including the case this correction fixes.
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
    // full-page overlay (modal/drawer/backdrop), not a layout bug -- only
    // applied to `fixed`, never `absolute`, see judgement-call comment above
    if (cs.position === 'fixed' && viewportArea > 0 && (r.width * r.height) > 0.5 * viewportArea) continue
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
        rule: 'B6', title: 'Overlapping elements', severity: 'major', confidence: 'heuristic',
        engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sa,
        containerId: ctx.helpers.containerId(a.el), y: Math.round(Math.max(a.r.top, b.r.top) + window.scrollY),
        found: 'overlaps ' + sb + ' by ' + Math.round(area) + 'px²',
        expected: 'elements should not overlap',
      })
    }
  }
  return out
}
