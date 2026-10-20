import { phoneKey } from '../lib/phone.js'

function group(pages, pick) {
  const m = new Map()
  for (const p of pages) {
    let v = pick(p)
    if (!v) continue
    // Trim whitespace for string values
    v = typeof v === 'string' ? v.trim() : v
    if (!v) continue
    if (!m.has(v)) m.set(v, [])
    m.get(v).push(p.url)
  }
  return m
}

// phoneKey -> the set of page urls whose `tel:` links dial it. E12 reads this
// to spot the one page still carrying an old number while the rest of the
// site moved on. A Set, not a list: a header and a footer linking the same
// number on one page is one page, not two.
function phonesByPage(pages) {
  const m = new Map()
  for (const p of pages) {
    for (const l of p.links || []) {
      if (l.protocol !== 'tel:') continue
      const key = phoneKey(l.raw)
      if (!key) continue
      if (!m.has(key)) m.set(key, new Set())
      m.get(key).add(p.url)
    }
  }
  return m
}

export function buildIndex(pages) {
  return {
    titles: group(pages, p => p.title),
    descriptions: group(pages, p => p.metaDescription),
    phones: phonesByPage(pages),
  }
}
