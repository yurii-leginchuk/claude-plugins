const ORDER = { critical: 0, major: 1, minor: 2, note: 3 }

export function rollUp(findings) {
  const groups = new Map()
  for (const f of findings) {
    if (!groups.has(f.rule)) {
      groups.set(f.rule, {
        rule: f.rule, title: f.title, severity: f.severity,
        confidence: f.confidence, count: 0, pages: [], example: f,
      })
    }
    const g = groups.get(f.rule)
    g.count++
    if (!g.pages.includes(f.page)) g.pages.push(f.page)
    if (ORDER[f.severity] < ORDER[g.severity]) {
      g.severity = f.severity
      g.example = f
    }
  }
  return [...groups.values()].sort((a, b) =>
    (ORDER[a.severity] - ORDER[b.severity]) || (b.count - a.count))
}

export function verdict(findings) {
  const solid = findings.filter(f => f.confidence !== 'heuristic')
  if (solid.some(f => f.severity === 'critical')) return 'Fail'
  if (solid.some(f => f.severity === 'major')) return 'Needs fixes'
  return 'Pass'
}

/**
 * Normalize volatile patterns in the 'found' value.
 * This helps identify the same logical issue even when volatile content changes.
 * For example: "Missing 5 images" and "Missing 6 images" are the same issue type.
 */
function normalizeFound(found) {
  if (typeof found !== 'string') return found
  // Replace numbers and query parameters with normalized patterns
  return found
    .replace(/\d+/g, 'N')  // Replace numbers with N
    .replace(/[?&][^=]+=[^&]*/g, '?param')  // Replace query params with placeholder
}

const key = (f) => [f.rule, f.page, f.selector, normalizeFound(f.found)].join('|')

export function diffRuns(current, previous) {
  const prev = new Map((previous || []).map(f => [key(f), f]))
  const cur = new Map(current.map(f => [key(f), f]))
  return {
    fixed: [...prev.values()].filter(f => !cur.has(key(f))),
    remaining: [...cur.values()].filter(f => prev.has(key(f))),
    added: [...cur.values()].filter(f => !prev.has(key(f))),
  }
}
