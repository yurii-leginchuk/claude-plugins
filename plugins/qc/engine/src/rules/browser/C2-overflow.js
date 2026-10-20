// Confidence (review, browser-pass fix wave): 'heuristic', not 'high'.
//
// Measured live (task 11, cleaningny.com): 19 of the 34 distinct Majors in
// the merged report came from this rule, all reading "2841-2843px at
// viewport 1440px", on six sibling `elementor-element` divs per page across
// three pages -- while C1 reported ZERO horizontal document scroll on those
// same pages at that same width. Two of the crops this pass captured
// (shots/840dfeb102c44b31.png and shots/e90ef974ef763a5e.png) show an
// ordinary, correctly rendered FAQ accordion: nothing is broken in either.
// Task 11's calibration wrote that off as "probably an unconstrained
// slider, left alone" -- a guess, on a major/high rule that moves the
// verdict, with the evidence sitting unopened in the same directory.
//
// The clipping-ancestor check below is the substantive fix, and it is what
// silences that class WHEN the clip is real. But the stored snapshot carries
// no ancestor-overflow data (the old rule never recorded any) and the browser
// cannot be re-run against a live site here, so it cannot be PROVEN that the
// check silences those 19. Shipping unproven Majors that visibly do not
// correspond to a defect is worse than shipping them as findings a human is
// asked to confirm: at 'heuristic' they still appear in the report, in full,
// under "needs a look", but they no longer move the verdict or inflate a
// severity tile. Raise this back to 'high' once a live re-run shows the
// remaining findings are real.
export const meta = {
  id: 'C2',
  title: 'Element wider than the viewport',
  severity: 'major',
  confidence: 'heuristic',
}

// Runs inside the page. Self-contained by contract.
export function check(ctx) {
  const vw = document.documentElement.clientWidth

  // True when some ancestor of `el` establishes a horizontal clip that
  // CONTAINS the element's visual overflow -- i.e. the element is wide, but
  // the extra width never reaches past the edge of the viewport, because an
  // ancestor box that itself fits inside the viewport hides it (overflow-x:
  // hidden/clip) or offers it as an internal scroller (auto/scroll, a
  // carousel/table-scroll pattern, where the content is reachable by design).
  // Neither is "an element escaping the viewport", which is what this rule
  // claims when it fires.
  //
  // documentElement and body are deliberately NOT treated as clipping
  // ancestors. Per CSS, `overflow` on <body> (and on <html>) propagates to
  // the VIEWPORT rather than clipping inside the element's own box, and
  // `body { overflow-x: hidden }` is exactly the WordPress-theme antipattern
  // this rule exists to catch: the content really is cut off and
  // unreachable, and C1 cannot see it because the clip suppresses document
  // scroll. Counting those as "clipped, therefore fine" would turn C2 into a
  // rule that fires only where C1 already fired. test/browser/fixtures/
  // overflow-element.html pins exactly that case (body{overflow-x:hidden}
  // with a 1200px child at 360px) and must stay reported.
  //
  // An ancestor whose own box already escapes the viewport does not stop the
  // walk: the clip that matters may be further up, so the loop continues
  // rather than concluding "not clipped" at the first non-containing
  // clipper.
  function clippedByAncestor(el) {
    let cur = el.parentElement
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const s = getComputedStyle(cur)
      const ox = s.overflowX
      if (ox && ox !== 'visible') {
        const cr = cur.getBoundingClientRect()
        if (cr.left >= -1 && cr.right <= vw + 1) return true
      }
      cur = cur.parentElement
    }
    return false
  }

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
    if (clippedByAncestor(el)) continue
    const sel = ctx.helpers.selector(el)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'C2', title: 'Element wider than the viewport', severity: 'major', confidence: 'heuristic',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sel,
      containerId: ctx.helpers.containerId(el),
      found: 'width ' + Math.round(r.width) + 'px at viewport ' + vw + 'px',
      expected: 'no wider than the viewport',
    })
  }
  return out
}
