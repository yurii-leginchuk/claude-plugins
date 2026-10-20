// Overflow probe for Claude's manual checks: run it in Playwright right after
// opening something (a desktop submenu, the burger, a popup, an accordion):
//
//   mcp__playwright__browser_run_code_unsafe { filename: "<plugin-root>/engine/probes/overflow.js" }
//
// It measures every visible run of text against the box it is painted in --
// the nearest ancestor with a background, a border or overflow hidden/clip --
// and against the viewport, and returns what sticks out ("overflows") or is
// cut off ("clipped"), by how many px, with a selector and the words. The
// engine's own overflow rules look only at the viewport edge and never open
// menus, so a dropdown narrower than its items passes them.
async (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth
  const vis = (e) => {
    const r = e.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    return !e.checkVisibility || e.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  }
  const paints = (e) => {
    const cs = getComputedStyle(e)
    const bg = cs.backgroundColor
    const hasBg = cs.backgroundImage !== 'none' || (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg))
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none')
    const clips = /(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY)
    return { box: hasBg || hasBorder || clips, clips: /(hidden|clip)/.test(cs.overflowX + cs.overflowY) }
  }
  const sel = (el) => {
    if (el.id && !/\d{5,}/.test(el.id)) return `${el.tagName.toLowerCase()}#${el.id}`
    const e = [...el.classList].find(c => /^elementor-element-[0-9a-f]+$/.test(c))
    if (e) return `.${e}`
    const cls = [...el.classList].filter(c => !/^(e-con|elementor-(active|item-active))$/.test(c)).slice(0, 2)
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '')
  }
  const out = []
  const seen = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.replace(/\s+/g, ' ').trim()
    if (text.length < 2) continue
    const host = n.parentElement
    if (!host || !vis(host) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(host.tagName)) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const tr = range.getBoundingClientRect()
    if (tr.width < 1 || tr.height < 1) continue
    let boxEl = null
    let clipped = false
    for (let p = host; p && p !== document.body; p = p.parentElement) {
      const k = paints(p)
      if (k.box) { boxEl = p; clipped = k.clips; break }
    }
    const issues = []
    // Screen-reader-only text lives in a 1px clipped box on purpose.
    if (boxEl && boxEl.getBoundingClientRect().width <= 2) continue
    if (/screen-reader|screen-only|sr-only|visually-hidden/.test(String(host.className) + ' ' + String(boxEl?.className || ''))) continue
    if (boxEl) {
      const br = boxEl.getBoundingClientRect()
      const right = Math.round(tr.right - br.right)
      const left = Math.round(br.left - tr.left)
      const bottom = Math.round(tr.bottom - br.bottom)
      if (right > 1) issues.push(`${right}px past the right edge`)
      if (left > 1) issues.push(`${left}px past the left edge`)
      if (bottom > 1) issues.push(`${bottom}px past the bottom`)
      if (issues.length) {
        const key = `${sel(boxEl)}|${text.slice(0, 40)}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ kind: clipped ? 'clipped' : 'overflows', text: text.slice(0, 80), box: sel(boxEl), boxWidth: Math.round(br.width), by: issues.join(', ') })
        }
      }
    }
    if (tr.right > vw + 1) {
      const key = `viewport|${text.slice(0, 40)}`
      if (!seen.has(key)) { seen.add(key); out.push({ kind: 'past the screen', text: text.slice(0, 80), box: 'viewport', by: `${Math.round(tr.right - vw)}px past the right edge of the screen` }) }
    }
  }
  return { width: vw, count: out.length, items: out.slice(0, 40) }
})
