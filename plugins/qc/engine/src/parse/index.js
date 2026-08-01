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

export function buildIndex(pages) {
  return {
    titles: group(pages, p => p.title),
    descriptions: group(pages, p => p.metaDescription),
  }
}
