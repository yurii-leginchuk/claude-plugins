import { finding } from '../index.js'
import { isPost } from '../../lib/kinds.js'

// Taxonomy H5: "03.20.2026", "not sure about this 2025" -- a year that went
// stale. Two cases:
//
//   copyright: "© 2024" in the footer once 2025 has started. Certain, and
//     the same on every page, so one distinct defect site-wide.
//   a past year in the title, H1 or description of a page that is not a
//     post ("Best rehab in Texas 2025"). A post dated 2024 rightly says 2024,
//     so dated pages are skipped, and the rest stays heuristic.
const COPYRIGHT = /(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?((?:19|20)\d{2})\b/gi
const YEAR = /\b(20[12]\d)\b/g

export default {
  id: 'H5',
  title: 'Устаревший год',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    const now = new Date(site?.now || Date.now()).getFullYear()
    const out = []
    const years = [...String(page.text || '').matchAll(COPYRIGHT)].map(m => Number(m[1]))
    const latest = years.length ? Math.max(...years) : null
    if (latest !== null && latest < now) {
      out.push(finding(this, page, {
        selector: 'footer', found: `© ${latest} в копирайте`, expected: `© ${now} (или текущий год автоматически)`,
      }))
    }
    if (isPost(page)) return out
    const h1 = (page.headings || []).find(h => h.level === 1)?.text
    const seen = new Set()
    for (const [where, value] of [['title', page.title], ['H1', h1], ['description', page.metaDescription]]) {
      for (const m of String(value || '').matchAll(YEAR)) {
        const y = Number(m[1])
        if (y >= now || seen.has(y)) continue
        seen.add(y)
        out.push(finding(this, page, {
          selector: where === 'H1' ? 'h1' : `meta/${where}`, confidence: 'heuristic',
          found: `год ${y} в ${where}: «${value}»`, expected: `${now} или без года`,
        }))
      }
    }
    return out
  },
}
