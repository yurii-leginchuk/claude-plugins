import { finding, whereInText } from '../index.js'
import { buildProfile } from '../../lib/profile.js'
import { pathKey } from '../../lib/url.js'

// Taxonomy check 13: the brand written several ways. Two cases:
//
//   og:site_name missing or a placeholder ("Site", "Home") -- what Google
//     and social cards show as the site's name. Certain, site-wide, so it
//     is reported once, on the homepage.
//   the brand in the copy in another form: ALL CAPS ("OPURA" for "Opura")
//     or continued into a longer name ("Opura Professional Cleaning
//     Services"). Heuristic -- a legal name may be meant -- and one finding
//     per variant, on the first page that has it.
const GENERIC = /^(site|home|website|wordpress|my blog|untitled)$/i
const MAX_TAIL = 3
// The tail of a longer name is made of the brand's own words and business
// suffixes only. Title Case headings ("the Opura Difference") and copy glued
// across elements ("Choose Opura" + "Fully insured") continue with ordinary
// words, and the tail stops at the first of those.
const SUFFIX = new Set(['professional', 'cleaning', 'services', 'service', 'recovery', 'center', 'centers', 'group', 'inc', 'llc', 'co', 'company', 'clinic', 'health', 'programs', 'treatment', 'agency', 'solutions', 'dental', 'law', 'partners', 'associates', 'restaurant', 'burgers', 'wellness', 'care'])
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const index = new WeakMap()
function variants(site, brand) {
  if (index.has(site)) return index.get(site)
  const first = brand.split(/\s+/)[0]
  const brandNorm = brand.toLowerCase()
  const own = new Set(brandNorm.split(/\s+/))
  const re = new RegExp(`\\b(${esc(first)}|${esc(first.toUpperCase())})((?:\\s+[A-Z][\\w&'’-]*){0,${MAX_TAIL}})`, 'g')
  const m = new Map()
  for (const p of site.pages || []) {
    for (const x of String(p.text || '').matchAll(re)) {
      const head = x[1]
      const tail = []
      for (const w of x[2].trim().split(/\s+/).filter(Boolean)) {
        const lw = w.toLowerCase().replace(/[’']s$/, '').replace(/[^a-z0-9&]/g, '')
        // A repeated word is the next element's text glued on ("…Recovery Liberty").
        if ((!own.has(lw) && !SUFFIX.has(lw)) || [head, ...tail].some(t => t.toLowerCase() === lw)) break
        // "Liberty Bay’s Recovery program": a possessive ends the name.
        if (/[’']s$/.test(w)) { tail.push(w); break }
        tail.push(w)
      }
      const phrase = [head, ...tail].join(' ').replace(/[’']s$/, '')
      const allCaps = head !== first
      const lower = phrase.toLowerCase()
      const longer = !brandNorm.startsWith(lower) && lower !== brandNorm
      if (!allCaps && !longer) continue
      if (!m.has(phrase)) m.set(phrase, p.url)
    }
  }
  index.set(site, m)
  return m
}

export default {
  id: 'H17',
  title: 'Название бренда',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    const brand = buildProfile(site || {}).brand
    const out = []
    if (pathKey(page.url) === '/' && (!page.siteName || GENERIC.test(page.siteName.trim()))) {
      out.push(finding(this, page, {
        selector: 'meta[property="og:site_name"]',
        found: page.siteName ? `og:site_name = «${page.siteName}»` : 'нет og:site_name',
        expected: brand ? `og:site_name = «${brand}» (Yoast: Settings → Site basics → Site name)` : 'название бренда в og:site_name',
      }))
    }
    if (!brand || !site?.pages) return out
    for (const [phrase, first] of variants(site, brand)) {
      if (first !== page.url) continue
      out.push(finding(this, page, {
        selector: 'body', confidence: 'heuristic',
        found: `бренд написан как «${phrase}», основное написание — «${brand}»`,
        where: whereInText(page, phrase), expected: `«${brand}», если другое написание не намеренное`,
      }))
    }
    return out
  },
}
