import { finding } from '../index.js'

// Taxonomy check 5 (H10 family): the same list on many pages -- "Insurances
// we accept", "Areas we serve", "What's included" -- kept by hand on each,
// so one page misses the insurance added last month. Lists in the page body
// with the same heading on at least MIN_PAGES pages are compared item by
// item. Heuristic: a page may rightly show a shorter list.
const MIN_PAGES = 3
const SHARE = 0.75

const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const index = new WeakMap()
function groups(site) {
  if (index.has(site)) return index.get(site)
  const m = new Map()
  for (const p of site.pages || []) {
    for (const l of p.lists || []) {
      const h = l.region === 'main' && norm(l.heading)
      if (!h) continue
      if (!m.has(h)) m.set(h, new Map())
      // One list per heading per page: a repeated block counts once.
      if (!m.get(h).has(p.url)) m.get(h).set(p.url, new Set(l.items.map(norm)))
    }
  }
  const out = new Map()
  const label = new Map()
  for (const p of site.pages || []) for (const x of p.lists || []) for (const i of x.items) if (!label.has(norm(i))) label.set(norm(i), i)
  out.label = label
  for (const [h, byPage] of m) {
    if (byPage.size < MIN_PAGES) continue
    const freq = new Map()
    for (const items of byPage.values()) for (const i of items) freq.set(i, (freq.get(i) || 0) + 1)
    // Only one list kept on many pages: most of its items are shared. Lists
    // that merely share a heading («Ingredients» on every recipe) differ by design.
    const common = [...freq.values()].filter(n => n / byPage.size >= SHARE).length
    const avg = [...byPage.values()].reduce((a, s) => a + s.size, 0) / byPage.size
    if (common < avg / 2) continue
    out.set(h, { byPage, freq })
  }
  index.set(site, out)
  return out
}

export default {
  id: 'H14',
  title: 'List differs from the same list on other pages',
  severity: 'minor',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    if (!site?.pages) return []
    const out = []
    const g = groups(site)
    const label = g.label
    const seen = new Set()
    for (const l of page.lists || []) {
      const h = l.region === 'main' && norm(l.heading)
      const grp = h && !seen.has(h) && g.get(h)
      if (!grp || !grp.byPage.has(page.url)) continue
      seen.add(h)
      const mine = grp.byPage.get(page.url)
      const total = grp.byPage.size
      for (const [item, n] of grp.freq) {
        if (!mine.has(item) && n / total >= SHARE) {
          out.push(finding(this, page, {
            selector: 'ul', found: `list “${l.heading}” is missing “${label.get(item)}”, though it is on ${n} of ${total} pages`,
            where: `content · under heading “${l.heading}”`, expected: `add “${label.get(item)}” to the list`,
          }))
        }
      }
      for (const item of mine) {
        if (grp.freq.get(item) === 1) {
          out.push(finding(this, page, {
            selector: 'ul', severity: 'note', found: `list “${l.heading}” has “${label.get(item)}”, which the other ${total - 1} pages do not have`,
            where: `content · under heading “${l.heading}”`, expected: 'the same list on every page, unless the difference is intentional',
          }))
        }
      }
    }
    return out
  },
}
