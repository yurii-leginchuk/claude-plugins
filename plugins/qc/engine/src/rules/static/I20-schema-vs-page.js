import { finding } from '../index.js'
import { ignoredByFacts, locationFor as locationOf } from '../../lib/facts.js'
import { addressNorm, streetOf } from '../../lib/address.js'
import { phoneKey } from '../../lib/phone.js'
import { hostOf } from '../../lib/url.js'

// Taxonomy I20 (+ H11, H12): structured data that disagrees with the page or
// the business. Schema is invisible, so it is where a copied template keeps
// the previous location's address or another network site's URL for years.
//
//   with facts.gbp addresses: a schema streetAddress must be one of them,
//     and on a location page (gbp[].paths) that location's;
//   without facts: a streetAddress or telephone that appears nowhere in the
//     page's copy or links (heuristic -- an Organization block may describe
//     a head office the page never shows);
//   always: a node's "url"/"@id" on a website that is neither this one nor
//     production -- a block pasted from another site (heuristic; sameAs
//     profiles are not checked).
const NOT_A_SITE = /(^|\.)(schema\.org|google\.[a-z.]+|facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|yelp\.com|gravatar\.com|wp\.com|wordpress\.org|cloudfront\.net)$/i

// cdn.example.com and example.com are one site.
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '')
const sameSite = (a, b) => {
  const x = bare(a), y = bare(b)
  return Boolean(x && y) && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`))
}

// Only the nodes that describe this business or site carry its own URL; an
// order action, a menu or an offer rightly points at Toast or a booking site.
const SITE_TYPES = /Organization|Business|Restaurant|Clinic|Store|WebSite|WebPage|Place|Hospital|Physician|Dentist|Attorney|Center/
const FILE = /\.(png|jpe?g|gif|svg|webp|avif|pdf|mp4)(\?|$)/i

function nodes(value, out = []) {
  if (Array.isArray(value)) value.forEach(v => nodes(v, out))
  else if (value && typeof value === 'object') {
    out.push(value)
    for (const [k, v] of Object.entries(value)) if (k !== 'sameAs') nodes(v, out)
  }
  return out
}

function parseBlocks(page) {
  const all = []
  for (const raw of page.jsonLdRaw || []) {
    try { nodes(JSON.parse(raw), all) } catch { /* S1 reports unparsable blocks */ }
  }
  return all
}

export default {
  id: 'I20',
  title: 'Schema does not match the page or the facts',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const facts = site?.facts
    if (ignoredByFacts(facts, page.url)) return []
    const all = parseBlocks(page)
    if (!all.length) return []
    const out = []
    const seen = new Set()
    const push = (props) => {
      if (seen.has(props.found)) return
      seen.add(props.found)
      out.push(finding(this, page, { selector: 'script[type="application/ld+json"]', ...props }))
    }

    const locs = (facts?.gbp || []).filter(g => g.address)
    const pageLoc = locationOf(locs, page.url)
    const text = addressNorm(page.text)
    const telKeys = new Set((page.links || []).filter(l => l.protocol === 'tel:').map(l => phoneKey(l.raw)))
    const digits = String(page.text || '').replace(/\D+/g, '')

    for (const n of all) {
      const street = typeof n.streetAddress === 'string' ? n.streetAddress.trim() : null
      if (street) {
        const s = addressNorm(streetOf(street))
        if (locs.length) {
          const match = locs.find(l => addressNorm(streetOf(l.address)).includes(s) || s.includes(addressNorm(streetOf(l.address))))
          if (pageLoc && match !== pageLoc) {
            push({ found: `streetAddress in schema “${street}” is not the address of this location`, expected: pageLoc.address })
          } else if (!match) {
            push({ found: `streetAddress in schema “${street}” is not in the facts`, expected: locs.map(l => l.address).join(' / ') })
          }
        } else if (s.trim().split(' ').length >= 2 && !text.includes(s)) {
          push({ confidence: 'heuristic', severity: 'minor', found: `address from schema “${street}” does not appear on the page`, expected: 'the same address as on the page' })
        }
      }
      if (typeof n.telephone === 'string' && !facts?.phones?.length) {
        const key = phoneKey(n.telephone)
        if (key && !telKeys.has(key) && !digits.includes(key.slice(1))) {
          push({ confidence: 'heuristic', severity: 'minor', found: `phone from schema ${n.telephone} does not appear on the page`, expected: 'the same number as on the page' })
        }
      }
      const types = [].concat(n['@type'] || []).join(' ')
      for (const k of SITE_TYPES.test(types) && !/Action|Menu|Offer/.test(types) ? ['url', '@id'] : []) {
        const v = n[k]
        if (typeof v !== 'string' || !/^https?:\/\//i.test(v) || FILE.test(v)) continue
        const h = hostOf(v)
        if (!h || sameSite(h, hostOf(page.url)) || NOT_A_SITE.test(h)) continue
        if (site?.prodHost && sameSite(h, site.prodHost)) continue
        push({ confidence: 'heuristic', found: `schema links to another site: ${h}`, expected: 'URLs of this site' })
      }
    }
    return out
  },
}
