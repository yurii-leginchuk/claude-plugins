export const BASE_WIDTHS = [360, 768, 1024, 1440]
export const MAX_WIDTHS = 10

// Matches: (min|max)-width: <number><unit>
// Captures: number, unit separately for conversion logic
const WIDTH_FEATURE = /\((?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|e[mr]|rem|vw|ch|pt|%|in|cm|mm|ex|pc|q)(?:\s*\))/gi

const MIN_WIDTH = 240
const MAX_WIDTH = 2560

// `counts` carries how many times each width was DECLARED, across every
// stylesheet handed in -- the spec's "most frequently occurring values"
// ranking criterion, which the original implementation could not express at
// all because it returned a Set and threw the frequency away with the
// duplicates. `widths` stays a plain de-duplicated number array, which is
// what every existing caller and test reads.
export function extractMediaWidths(cssText) {
  const counts = new Map()
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

      if (Number.isFinite(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) {
        counts.set(w, (counts.get(w) || 0) + 1)
      }
    }
  }

  return { widths: [...counts.keys()], counts: Object.fromEntries(counts), unparseable }
}

// Distance to the nearest base width; used to keep the most informative
// discovered boundaries when the cap bites.
const distanceToBase = (w) => Math.min(...BASE_WIDTHS.map(b => Math.abs(b - w)))

// A media width W describes a BOUNDARY, not a width worth testing on its own:
// a layout defect lives on one side of it and not the other, so W and W-1 are
// only useful together. Ranking them as two independent candidates -- what
// this module used to do -- let one boundary eat two of the six discretionary
// slots, and, worse, invented a third width for boundaries a theme declares
// from both sides.
//
// Measured live (task 11, cleaningny.com): the site declares max-width:640 /
// min-width:641, max-width:767 / min-width:768, max-width:1024 /
// min-width:1025 and min-width:1200. The old blind "add W and W-1 for every
// declared W" turned the single 767|768 boundary into three candidates
// (766, 767, 768) and the single 1024|1025 boundary into three (1023, 1024,
// 1025). Four discretionary slots went to widths within 2px of a base width,
// and 1200 -- the Bootstrap and Elementor desktop boundary, the one width on
// that list a desktop layout can actually break at -- was dropped.
//
// So: two declared widths that are adjacent integers (W and W+1) are the two
// sides of ONE boundary and are paired as such; a declared width with no
// declared neighbour pairs with W-1, as before. 766 is never invented,
// because nothing declares it.
function boundariesFrom(declared) {
  const values = [...declared.keys()].sort((a, b) => a - b)
  const consumed = new Set()
  const boundaries = []

  for (const w of values) {
    if (consumed.has(w)) continue
    let pair, freq
    if (declared.has(w + 1) && !consumed.has(w + 1)) {
      pair = [w, w + 1]
      freq = declared.get(w) + declared.get(w + 1)
      consumed.add(w)
      consumed.add(w + 1)
    } else {
      pair = [w - 1, w]
      freq = declared.get(w)
      consumed.add(w)
    }
    boundaries.push({ pair: pair.filter(v => v >= MIN_WIDTH && v <= MAX_WIDTH), freq })
  }
  return boundaries
}

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

  const declared = new Map()
  const allUnparseable = []

  for (const css of cssTexts) {
    const result = extractMediaWidths(css)
    for (const [w, n] of Object.entries(result.counts)) {
      const width = Number(w)
      declared.set(width, (declared.get(width) || 0) + n)
    }
    allUnparseable.push(...result.unparseable)
  }

  const base = new Set(BASE_WIDTHS)
  const boundaries = boundariesFrom(declared)
    .map(b => ({
      // What this boundary would actually cost: a side already covered by a
      // base width is free, because that width is always measured anyway.
      candidates: b.pair.filter(v => !base.has(v)),
      distance: Math.min(...b.pair.map(distanceToBase)),
      freq: b.freq,
      at: Math.min(...b.pair),
    }))
    .filter(b => b.candidates.length)

  // Ranking, in order: nearest to a base width first (unchanged -- the widths
  // most likely to be where a layout actually flips), then the most
  // frequently declared, then lowest first for a stable, reproducible result.
  // Frequency is the spec's own second criterion and had never been
  // implemented: a boundary declared by several stylesheets is a boundary the
  // theme genuinely leans on, and outranks one some plugin mentioned once.
  boundaries.sort((a, b) =>
    a.distance - b.distance || b.freq - a.freq || a.at - b.at
  )

  const room = Math.max(0, MAX_WIDTHS - BASE_WIDTHS.length)
  const kept = new Set()
  const seen = new Set()
  for (const b of boundaries) {
    for (const c of b.candidates) seen.add(c)
    const need = b.candidates.filter(c => !kept.has(c))
    // All of a boundary or none of it: half a boundary measures only the side
    // that already worked. A boundary that does not fit is skipped rather
    // than ending the loop, so a cheaper one further down (one side of which
    // is already a base width, so it costs a single slot) can still use the
    // room left over.
    if (need.length && kept.size + need.length <= room) {
      for (const c of need) kept.add(c)
    }
  }

  const dropped = [...seen].filter(w => !kept.has(w)).sort((a, b) => a - b)
  const widths = [...new Set([...BASE_WIDTHS, ...kept])].sort((a, b) => a - b)

  // Deduplicate unparseable while maintaining discovery order
  const uniqueUnparseable = [...new Map(allUnparseable.map(u => [u, u])).values()]

  return { widths, dropped, unparseable: uniqueUnparseable }
}
