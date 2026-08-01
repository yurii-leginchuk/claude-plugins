export const BASE_WIDTHS = [360, 768, 1024, 1440]
export const MAX_WIDTHS = 10

const WIDTH_FEATURE = /\((?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/gi

export function extractMediaWidths(cssText) {
  const out = new Set()
  const blocks = String(cssText || '').match(/@media[^{]+/gi) || []
  for (const block of blocks) {
    let m
    WIDTH_FEATURE.lastIndex = 0
    while ((m = WIDTH_FEATURE.exec(block))) {
      const w = Math.floor(Number(m[1]))
      if (Number.isFinite(w) && w >= 240 && w <= 2560) out.add(w)
    }
  }
  return [...out]
}

// Distance to the nearest base width; used to keep the most informative
// discovered widths when the cap bites.
const distanceToBase = (w) => Math.min(...BASE_WIDTHS.map(b => Math.abs(b - w)))

export function resolveBreakpoints({ cssTexts = [], override = null } = {}) {
  if (Array.isArray(override) && override.length) {
    return { widths: [...new Set(override)].sort((a, b) => a - b), dropped: [] }
  }

  const discovered = new Set()
  for (const css of cssTexts) {
    for (const w of extractMediaWidths(css)) {
      discovered.add(w)
      if (w - 1 >= 240) discovered.add(w - 1)
    }
  }
  for (const b of BASE_WIDTHS) discovered.delete(b)

  const ranked = [...discovered].sort((a, b) => distanceToBase(a) - distanceToBase(b) || a - b)
  const room = Math.max(0, MAX_WIDTHS - BASE_WIDTHS.length)
  const kept = ranked.slice(0, room)
  const dropped = ranked.slice(room).sort((a, b) => a - b)

  const widths = [...new Set([...BASE_WIDTHS, ...kept])].sort((a, b) => a - b)
  return { widths, dropped }
}
