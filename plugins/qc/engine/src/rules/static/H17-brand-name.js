import { finding, whereInText } from '../index.js'
import { buildProfile } from '../../lib/profile.js'
import { pathKey } from '../../lib/url.js'

// Taxonomy check 13: the brand written several ways. Two cases:
//
//   og:site_name missing or a placeholder ("Site", "Home") -- what Google
//     and social cards show as the site's name. Certain, site-wide, so it
//     is reported once, on the homepage.
//   the brand in the copy in ALL CAPS ("OPURA" for "Opura"). Heuristic --
//     it may be the logo's styling -- and one finding per variant, on the
//     first page that has it. The brand followed by what the business does
//     ("Opura Cleaning Services", "Opura Services LLC") is the same name and
//     is not reported: that is how companies are named in copy.
const GENERIC = /^(site|home|website|wordpress|my blog|untitled)$/i
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const index = new WeakMap()
function variants(site, brand) {
  if (index.has(site)) return index.get(site)
  const first = brand.split(/\s+/)[0]
  const caps = first.toUpperCase()
  const m = new Map()
  if (caps !== first) {
    const re = new RegExp(`\\b${esc(caps)}\\b`)
    for (const p of site.pages || []) if (re.test(String(p.text || '')) && !m.has(caps)) m.set(caps, p.url)
  }
  index.set(site, m)
  return m
}

export default {
  id: 'H17',
  title: 'Brand name',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    const brand = buildProfile(site || {}).brand
    const out = []
    if (pathKey(page.url) === '/' && (!page.siteName || GENERIC.test(page.siteName.trim()))) {
      out.push(finding(this, page, {
        selector: 'meta[property="og:site_name"]',
        found: page.siteName ? `og:site_name = “${page.siteName}”` : 'no og:site_name',
        expected: brand ? `og:site_name = “${brand}” (Yoast: Settings → Site basics → Site name)` : 'brand name in og:site_name',
      }))
    }
    if (!brand || !site?.pages) return out
    for (const [phrase, first] of variants(site, brand)) {
      if (first !== page.url) continue
      out.push(finding(this, page, {
        selector: 'body', confidence: 'heuristic',
        found: `brand is written as “${phrase}”, the main spelling is “${brand}”`,
        where: whereInText(page, phrase), expected: `“${brand}”, unless the other spelling is intentional`,
      }))
    }
    return out
  },
}
