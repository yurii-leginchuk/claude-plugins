export const BASE_WIDTHS = [360, 768, 1024, 1440]
export const MAX_WIDTHS = 10

// Matches: (min|max)-width: <number><unit>
// Captures: number, unit separately for conversion logic
const WIDTH_FEATURE = /\((?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|e[mr]|rem|vw|ch|pt|%|in|cm|mm|ex|pc|q)(?:\s*\))/gi

export function extractMediaWidths(cssText) {
  const widths = new Set()
  const unparseable = []
  const blocks = String(cssText || '').match(/@media[^{]+/gi) || []

  for (const block of blocks) {
    let m
    WIDTH_FEATURE.lastIndex = 0
    while ((m = WIDTH_FEATURE.exec(block))) {
      const value = Number(m[1])
      const unit = m[2].toLowerCase()

      let w = null
      if (unit === 'px') {
        w = Math.floor(value)
      } else if (unit === 'em' || unit === 'rem') {
        // em/rem in media queries resolve against initial font size (16px)
        w = Math.floor(value * 16)
      } else {
        // Unsupported units: vw, ch, pt, %, in, cm, mm, ex, pc, q, and calc()
        unparseable.push(m[0].trim())
        continue
      }

      if (Number.isFinite(w) && w >= 240 && w <= 2560) {
        widths.add(w)
      }
    }
  }

  return { widths: [...widths], unparseable }
}

// Distance to the nearest base width; used to keep the most informative
// discovered widths when the cap bites.
const distanceToBase = (w) => Math.min(...BASE_WIDTHS.map(b => Math.abs(b - w)))

export function resolveBreakpoints({ cssTexts = [], override = null } = {}) {
  // If override provided, validate and use it (filter to finite numbers only)
  if (Array.isArray(override) && override.length) {
    const valid = override.filter(v => Number.isFinite(v))
    return {
      widths: [...new Set(valid)].sort((a, b) => a - b),
      dropped: [],
      unparseable: []
    }
  }

  const discovered = new Set()
  const allUnparseable = []

  for (const css of cssTexts) {
    const result = extractMediaWidths(css)
    for (const w of result.widths) {
      discovered.add(w)
      if (w - 1 >= 240) discovered.add(w - 1)
    }
    allUnparseable.push(...result.unparseable)
  }

  for (const b of BASE_WIDTHS) discovered.delete(b)

  const ranked = [...discovered].sort((a, b) => distanceToBase(a) - distanceToBase(b) || a - b)
  const room = Math.max(0, MAX_WIDTHS - BASE_WIDTHS.length)
  const kept = ranked.slice(0, room)
  const dropped = ranked.slice(room).sort((a, b) => a - b)

  const widths = [...new Set([...BASE_WIDTHS, ...kept])].sort((a, b) => a - b)

  // Deduplicate unparseable while maintaining discovery order
  const uniqueUnparseable = [...new Map(allUnparseable.map(u => [u, u])).values()]

  return { widths, dropped, unparseable: uniqueUnparseable }
}
