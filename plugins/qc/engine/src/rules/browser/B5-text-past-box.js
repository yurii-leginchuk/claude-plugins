// Text painted past the box it sits in -- the nearest ancestor with a
// background, a border or overflow hidden/clip -- the same measurement as
// probes/overflow.js, on every page at every width. A heuristic: a box
// without a visible edge can hold text past it by design, so it is a hint
// for the visual review of the piece it is on (y), not a defect by itself.
export const meta = {
  id: 'B5',
  title: 'Text past the edge of its box',
  severity: 'minor',
  confidence: 'heuristic',
}

export function check(ctx) {
  const paints = (e) => {
    const cs = getComputedStyle(e)
    const bg = cs.backgroundColor
    const hasBg = cs.backgroundImage !== 'none' || (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg))
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none')
    const ov = cs.overflowX + cs.overflowY
    return { box: hasBg || hasBorder || /(hidden|clip|auto|scroll)/.test(ov), clips: /(hidden|clip)/.test(ov) }
  }
  const out = []
  const seen = {}
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n && out.length < 20; n = walker.nextNode()) {
    const text = n.nodeValue.replace(/\s+/g, ' ').trim()
    if (text.length < 2) continue
    const host = n.parentElement
    if (!host || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(host.tagName) || !ctx.helpers.visible(host)) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const tr = range.getBoundingClientRect()
    if (tr.width < 1 || tr.height < 1) continue
    let box = null
    let clips = false
    for (let p = host; p && p !== document.body; p = p.parentElement) {
      const k = paints(p)
      if (k.box) { box = p; clips = k.clips; break }
    }
    if (!box) continue
    const br = box.getBoundingClientRect()
    // screen-reader text lives in a 1px clipped box on purpose
    if (br.width <= 2 || /screen-reader|sr-only|visually-hidden/.test(String(host.className) + ' ' + String(box.className))) continue
    const by = []
    if (tr.right - br.right > 1) by.push(Math.round(tr.right - br.right) + 'px past the right edge')
    if (br.left - tr.left > 1) by.push(Math.round(br.left - tr.left) + 'px past the left edge')
    if (tr.bottom - br.bottom > 1) by.push(Math.round(tr.bottom - br.bottom) + 'px past the bottom')
    if (!by.length) continue
    const sel = ctx.helpers.selector(box)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'B5', title: 'Text past the edge of its box', severity: 'minor', confidence: 'heuristic',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sel,
      containerId: ctx.helpers.containerId(box), y: Math.round(tr.top + window.scrollY),
      found: '«' + text.slice(0, 60) + '» ' + (clips ? 'is cut off: ' : '') + by.join(', '),
      expected: 'the text inside its box',
    })
  }
  return out
}
