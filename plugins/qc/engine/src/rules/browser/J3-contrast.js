export const meta = {
  id: 'J3',
  title: 'Insufficient text contrast',
  severity: 'major',
  confidence: 'heuristic',
}

// Runs inside the page. Self-contained by contract -- see _helpers.js's
// top-of-file comment.
export function check(ctx) {
  const out = []
  const seen = {}

  // Local rgba parser (distinct from ctx.helpers.parseRgb) that keeps the
  // alpha channel instead of discarding it -- needed for the compositing
  // walk below. Returns null for anything unparsable or fully transparent.
  const parseRgba = function (str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '')
    if (!m) return null
    const parts = m[1].split(',').map(function (s) { return parseFloat(s.trim()) })
    const a = parts.length >= 4 ? parts[3] : 1
    if (!(a > 0)) return null
    return { r: parts[0], g: parts[1], b: parts[2], a: a }
  }

  // Composite `top` (closer to the viewer) over `bottom` (farther back),
  // standard "source-over" alpha blending.
  const over = function (top, bottom) {
    const a = top.a + bottom.a * (1 - top.a)
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
    return {
      r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
      g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
      b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
      a: a,
    }
  }

  const nodes = document.querySelectorAll('body *')
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]
    if (!ctx.helpers.visible(el)) continue
    // Only elements with their own direct text.
    let hasText = false
    for (let c = 0; c < el.childNodes.length; c++) {
      const n = el.childNodes[c]
      if (n.nodeType === 3 && n.textContent.trim().length > 1) { hasText = true; break }
    }
    if (!hasText) continue

    const cs = getComputedStyle(el)
    const fg = ctx.helpers.parseRgb(cs.color)
    if (!fg) continue

    // Walk up compositing every background color found along the way, from
    // nearest to farthest, until either a fully opaque result is reached or
    // document.documentElement is passed. This is what makes both of the
    // following common cases work correctly instead of guessing:
    //
    //  - white text whose own ancestor chain has no background at all until
    //    a distant ancestor several levels up sets one (e.g. a themed
    //    "section" background) -- the walk simply keeps going past every
    //    transparent/unset level until it finds that ancestor, however far
    //    up it is.
    //  - white text inside a semi-transparent overlay (e.g.
    //    rgba(0,0,0,.85)) sitting on the page's plain white canvas -- the
    //    overlay's color alone is NOT opaque (alpha .85), so the naive
    //    "take the first parseable background-color and ignore alpha"
    //    reading would treat rgba(0,0,0,.85) as if it were solid black,
    //    which is wrong: the true rendered color is a slightly lighter,
    //    composited near-black. This walk keeps going past the overlay,
    //    composites it over whatever is behind it (here, the white body
    //    background, or the implicit white canvas if nothing further up
    //    declares a color), and only stops once the accumulated alpha
    //    reaches 1.
    //
    // A background-image or gradient encountered before full opacity is
    // reached makes the true rendered color unknowable from CSS alone (this
    // rule does not rasterise pixels), so the element is skipped rather than
    // guessed at -- consistent with never emitting a finding that can't be
    // substantiated. Note this only walks the ANCESTOR chain: a separate
    // sibling element painted behind `el` via absolute positioning/z-index
    // (e.g. a photo laid under a text box) is invisible to a CSS-only
    // reasoner and stays a known limitation, same as it would be for any
    // ancestor-based approach.
    let composited = null
    let node = el
    let unknown = false
    while (node && node !== document.documentElement) {
      const s = getComputedStyle(node)
      if (s.backgroundImage && s.backgroundImage !== 'none') { unknown = true; break }
      const c = parseRgba(s.backgroundColor)
      if (c) {
        composited = composited ? over(composited, c) : c
        if (composited.a >= 0.999) break
      }
      node = node.parentElement
    }
    if (unknown) continue
    // Nothing opaque was found in the chain -- composite what we have (or
    // nothing at all) over the browser's own default white canvas, which is
    // what actually renders behind an unstyled page.
    const white = { r: 255, g: 255, b: 255, a: 1 }
    const bg = composited && composited.a >= 0.999 ? composited : over(composited || { r: 0, g: 0, b: 0, a: 0 }, white)

    const ratio = ctx.helpers.contrast(fg, [bg.r, bg.g, bg.b])
    const px = parseFloat(cs.fontSize) || 16
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700
    const large = px >= 24 || (px >= 18.66 && bold)
    const need = large ? 3 : 4.5
    if (ratio >= need) continue

    const sel = ctx.helpers.selector(el)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'J3', title: 'Insufficient text contrast', severity: 'major',
      confidence: 'heuristic', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
      selector: sel,
      containerId: ctx.helpers.containerId(el),
      found: 'contrast ' + ratio.toFixed(2) + ':1 at ' + Math.round(px) + 'px',
      expected: 'at least ' + need + ':1',
    })
  }
  return out
}
