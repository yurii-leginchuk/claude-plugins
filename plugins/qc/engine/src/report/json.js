const ORDER = { critical: 0, major: 1, minor: 2, note: 3 }

/**
 * Rules whose 'found' values contain fluctuating counts that don't reflect
 * the actual defect. Map each rule to the normalization pattern.
 * For rules not listed here, the exact 'found' value is part of the defect identity.
 */
const RULES_WITH_FLUCTUATING_COUNTS = {
  I1: /\d+/g,  // "Missing N images" - the count changes but the issue type is stable
  I6: /\d+/g,  // "N broken links" - same
}

/**
 * Normalize volatile patterns in the 'found' value only for rules where
 * the digits represent discovered quantities rather than the defect itself.
 * For other rules, the exact value is the defect identity.
 *
 * Examples:
 * - I1 "Missing 5 images" vs "Missing 6 images" → normalize to same, both represent "missing images"
 * - E4 "tel:855-607-8758" vs "tel:855-607-8759" → keep different, different phone numbers are different bugs
 * - E1 "HTTP 404" vs "HTTP 500" → keep different (though defensive; 4xx vs 5xx should probably normalize)
 */
function normalizeFound(found, rule) {
  if (typeof found !== 'string') return found

  const pattern = RULES_WITH_FLUCTUATING_COUNTS[rule]
  if (!pattern) {
    // No normalization needed for this rule - exact value matters
    return found
  }

  // Replace counts with placeholder for this rule
  return found.replace(pattern, 'N')
}

const key = (f) => [f.rule, f.page, f.selector, normalizeFound(f.found, f.rule)].join('|')

export function rollUp(findings) {
  // Validate that findings is iterable
  if (!findings || typeof findings[Symbol.iterator] !== 'function') {
    throw new TypeError(`rollUp requires an iterable collection, got ${typeof findings}`)
  }

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

    // Update severity if we found a more severe one
    const oldSeverityOrder = ORDER[g.severity] ?? 999  // Unknown severities sort last
    const newSeverityOrder = ORDER[f.severity] ?? 999
    if (newSeverityOrder < oldSeverityOrder) {
      g.severity = f.severity
      g.example = f
    }
  }

  return [...groups.values()].sort((a, b) => {
    const aOrder = ORDER[a.severity] ?? 999
    const bOrder = ORDER[b.severity] ?? 999
    return (aOrder - bOrder) || (b.count - a.count)
  })
}

export function verdict(findings) {
  const solid = findings.filter(f => f.confidence !== 'heuristic')
  if (solid.some(f => f.severity === 'critical')) return 'Fail'
  if (solid.some(f => f.severity === 'major')) return 'Needs fixes'
  return 'Pass'
}

export function diffRuns(current, previous) {
  // Handle null/missing previous
  const prevList = previous || []

  // Count occurrences of each identity in both runs
  const prevCounts = new Map()
  const prevExamples = new Map()  // Keep one example of each key for output
  for (const f of prevList) {
    const k = key(f)
    prevCounts.set(k, (prevCounts.get(k) || 0) + 1)
    if (!prevExamples.has(k)) prevExamples.set(k, f)
  }

  const curCounts = new Map()
  const curExamples = new Map()
  for (const f of current) {
    const k = key(f)
    curCounts.set(k, (curCounts.get(k) || 0) + 1)
    if (!curExamples.has(k)) curExamples.set(k, f)
  }

  // Build result arrays with multiplicity
  const fixed = []
  const remaining = []
  const added = []

  // Iterate once over all unique keys from both runs
  const allKeys = new Set([...prevCounts.keys(), ...curCounts.keys()])

  for (const k of allKeys) {
    const prevCount = prevCounts.get(k) || 0
    const curCount = curCounts.get(k) || 0

    if (prevCount > curCount) {
      // Some instances were fixed
      const numFixed = prevCount - curCount
      const example = prevExamples.get(k)
      for (let i = 0; i < numFixed; i++) {
        fixed.push(example)
      }
    }

    if (curCount > 0 && prevCount > 0) {
      // Some instances remain (exist in both)
      const numRemaining = Math.min(prevCount, curCount)
      const example = curExamples.get(k)
      for (let i = 0; i < numRemaining; i++) {
        remaining.push(example)
      }
    }

    if (curCount > prevCount) {
      // Some instances are new or increased
      const numAdded = curCount - prevCount
      const example = curExamples.get(k)
      for (let i = 0; i < numAdded; i++) {
        added.push(example)
      }
    }
  }

  return { fixed, remaining, added }
}
