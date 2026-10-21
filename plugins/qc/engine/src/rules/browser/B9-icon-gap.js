// An icon touching or overlapping the text next to it (a pill, a button, a
// list item): the box of the icon and the box of the text on the same line
// less than 2px apart. A heuristic: an SVG can carry its own white space
// inside its box, so this points the visual review at the spot (y).
export const meta = {
  id: 'B9',
  title: 'No gap between an icon and its text',
  severity: 'minor',
  confidence: 'heuristic',
}

export function check(ctx) {
  const out = []
  const seen = {}
  const icons = document.querySelectorAll('svg, img, i')
  for (let i = 0; i < icons.length && out.length < 20; i++) {
    const icon = icons[i]
    const ir = icon.getBoundingClientRect()
    if (ir.width < 8 || ir.width > 48 || ir.height < 8 || ir.height > 48 || !ctx.helpers.visible(icon)) continue
    // the text that sits with the icon: in its parent, or one level up
    let box = icon.parentElement
    for (let k = 0; k < 2 && box && !box.textContent.replace(icon.textContent, '').trim(); k++) box = box.parentElement
    if (!box || box === document.body) continue
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    let gap = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (icon.contains(n) || n.nodeValue.trim().length < 2) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const tr of range.getClientRects()) {
        const oy = Math.min(tr.bottom, ir.bottom) - Math.max(tr.top, ir.top)
        if (oy < Math.min(tr.height, ir.height) / 2) continue
        const g = tr.left >= ir.left ? tr.left - ir.right : ir.left - tr.right
        if (gap === null || Math.abs(g) < Math.abs(gap)) gap = g
      }
    }
    if (gap === null || gap >= 2 || gap < -ir.width) continue
    const sel = ctx.helpers.selector(box)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'B9', title: 'No gap between an icon and its text', severity: 'minor', confidence: 'heuristic',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sel,
      containerId: ctx.helpers.containerId(box), y: Math.round(ir.top + window.scrollY),
      found: (gap < 0 ? 'the icon overlaps the text by ' + Math.round(-gap) + 'px' : 'the icon is ' + Math.round(gap) + 'px from the text') + ': «' + box.textContent.replace(/\s+/g, ' ').trim().slice(0, 50) + '»',
      expected: 'a gap between the icon and the text',
    })
  }
  return out
}
