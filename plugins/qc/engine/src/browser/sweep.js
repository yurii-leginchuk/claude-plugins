// Resize sweep: the page, loaded once, is narrowed from 1920px to 320px in
// small steps, and at every width a cheap in-page check looks for elements
// reaching past the right edge (the cause of a horizontal scroll). Breakpoint
// passes only see their few widths; QA keeps finding layouts that break at
// 1189 or 1230px, between them. One load and ~160 resizes cost seconds,
// where re-running every rule at every width costs minutes.
//
// Taxonomy C8 («from 1347px till 1189px…»). Each offending element becomes one C8 finding with the width ranges it
// breaks at, and a screenshot taken at its worst width.
import { captureDefect } from './screenshot.js'

export const SWEEP = { from: 1920, to: 320, step: 10 }

// Runs in the page; self-contained (serialised by page.evaluate).
function offenders() {
  const cw = document.documentElement.clientWidth
  if (document.documentElement.scrollWidth - cw <= 1) return []
  const sel = (el) => {
    if (el.id) return el.tagName.toLowerCase() + '#' + el.id
    const el2 = Array.prototype.find.call(el.classList, c => /^elementor-element-[0-9a-f]+$/.test(c))
    if (el2) return '.' + el2
    const cls = Array.prototype.slice.call(el.classList, 0, 2)
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '')
  }
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX
      if (o === 'hidden' || o === 'clip' || o === 'auto' || o === 'scroll') return true
    }
    return false
  }
  const containerId = (el) => {
    for (let c = el; c && c.nodeType === 1; c = c.parentElement) {
      for (const k of c.classList || []) { const m = /^elementor-(\d+)$/.exec(k); if (m) return m[1] }
    }
    return null
  }
  const heading = (el) => {
    const hs = document.querySelectorAll('h1,h2,h3,h4')
    let last = null
    for (const h of hs) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = h
      else break
    }
    return last ? last.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) : null
  }
  const out = []
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || r.right <= cw + 1) continue
    const parent = el.parentElement
    // The origin of the overflow: its parent still fits.
    if (parent && parent !== document.body && parent.getBoundingClientRect().right > cw + 1) continue
    if (getComputedStyle(el).position === 'fixed' || clipped(el)) continue
    out.push({ selector: sel(el), by: Math.round(r.right - cw), containerId: containerId(el), heading: heading(el) })
    if (out.length >= 10) break
  }
  return out
}

const ranges = (widths, step) => {
  const sorted = [...widths].sort((a, b) => a - b)
  const out = []
  for (const w of sorted) {
    const last = out.at(-1)
    if (last && w - last[1] <= step) last[1] = w
    else out.push([w, w])
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')
}

export async function sweepPage(page, { url, host, sweep = SWEEP, capturedIdentities = new Map(), region = () => null }) {
  const seen = new Map()
  for (let w = sweep.from; w >= sweep.to; w -= sweep.step) {
    await page.setViewportSize({ width: w, height: 900 })
    // Two frames: resize listeners (Elementor, sliders) run, layout settles.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    for (const o of await page.evaluate(offenders)) {
      if (!seen.has(o.selector)) seen.set(o.selector, { ...o, widths: [], worst: { w, by: o.by } })
      const s = seen.get(o.selector)
      s.widths.push(w)
      if (o.by > s.worst.by) s.worst = { w, by: o.by }
    }
  }
  const findings = []
  for (const s of seen.values()) {
    const f = {
      rule: 'C8', title: 'Element goes past the screen edge at some widths', severity: 'critical', confidence: 'high',
      engine: 'browser', page: url, breakpoint: s.worst.w, selector: s.selector, containerId: s.containerId,
      // The widths go to `where`, not `found`: a header element breaking at
      // slightly different ranges on two pages is still one defect.
      found: `element ${s.selector} goes past the right edge of the screen (horizontal scroll)`,
      expected: 'element no wider than the screen: remove the fixed width/margin, max-width: 100%, wrap lines',
      where: [`widths ${ranges(s.widths, sweep.step)} px, worst at ${s.worst.w} px (by ${s.worst.by} px)`,
        s.containerId ? `Elementor container ${s.containerId}` : null, s.heading ? `under heading “${s.heading}”` : null].filter(Boolean).join(' · '),
    }
    f.region = region(f)
    const identity = `C8|${f.selector}`
    if (!capturedIdentities.has(identity)) {
      let shot = null
      try {
        await page.setViewportSize({ width: s.worst.w, height: 900 })
        shot = await captureDefect(page, f, host)
      } catch { /* a capture never fails the pass */ }
      capturedIdentities.set(identity, { shot, width: s.worst.w })
    }
    const c = capturedIdentities.get(identity)
    if (c.shot) { f.shot = c.shot; f.shotWidth = c.width }
    findings.push(f)
  }
  return findings
}
