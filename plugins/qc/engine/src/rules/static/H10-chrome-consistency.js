import { finding } from '../index.js'

// Taxonomy H10, the third-largest content code: "updated not everywhere" --
// a footer, header or shared block changed on most pages while a few kept
// the old copy (a page built on its own template, a stale Elementor
// override). Compared as text: the variant most pages share is the
// reference, and a variant carried by at most a fifth of that many pages is
// reported. Heuristic: a section may rightly have its own header.
const MIN_MAJORITY_PAGES = 3
const SHOW_WORDS = 8

const words = (t) => new Set(String(t || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'&-]*/gu) || [])

const index = new WeakMap()

function variants(site, field) {
  const key = `${field}`
  let cache = index.get(site)
  if (!cache) { cache = {}; index.set(site, cache) }
  if (cache[key]) return cache[key]
  const m = new Map()
  for (const p of site.pages || []) {
    const t = (p[field] || '').trim()
    if (!t) continue
    if (!m.has(t)) m.set(t, 0)
    m.set(t, m.get(t) + 1)
  }
  return (cache[key] = m)
}

function diff(mine, ref) {
  const a = words(mine)
  const b = words(ref)
  const missing = [...b].filter(w => !a.has(w)).slice(0, SHOW_WORDS)
  const extra = [...a].filter(w => !b.has(w)).slice(0, SHOW_WORDS)
  return [
    missing.length ? `нет: ${missing.join(', ')}` : null,
    extra.length ? `лишнее: ${extra.join(', ')}` : null,
  ].filter(Boolean).join('; ')
}

export default {
  id: 'H10',
  title: 'Общий блок отличается от остального сайта',
  severity: 'major',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    if (!site?.pages || site.pages.length < MIN_MAJORITY_PAGES + 1) return []
    const out = []
    for (const [field, label, selector] of [['footerText', 'Футер', 'footer'], ['headerText', 'Хедер', 'header']]) {
      const mine = (page[field] || '').trim()
      if (!mine) continue
      const v = variants(site, field)
      const [ref, refCount] = [...v].sort((a, b) => b[1] - a[1])[0]
      if (mine === ref || refCount < MIN_MAJORITY_PAGES) continue
      if (v.get(mine) > Math.max(1, Math.floor(refCount * 0.2))) continue
      const d = diff(mine, ref)
      if (!d) continue
      out.push(finding(this, page, {
        selector,
        found: `${label} отличается от ${refCount} других страниц (${d})`,
        expected: `${label.toLowerCase()} как на остальном сайте`,
      }))
    }
    return out
  },
}
