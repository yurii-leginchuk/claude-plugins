import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'
import { buildProfile } from '../../lib/profile.js'

// Taxonomy K10/K16: "this location page has no map", "the form here is the
// old one" -- a page of a section missing a block its siblings all have.
// Siblings are the pages of one section (/services/*, /locations/*); a
// feature carried by at least SHARE of the other siblings is expected here.
// Heuristic: a page may drop a block on purpose.
const MIN_SIBLINGS = 4
const SHARE = 0.75

const FEATURES = {
  'a form': (p) => (p.forms || []).length > 0,
  'an FAQ block': (p) => (p.headings || []).some(h => /faq|frequently asked/i.test(h.text)),
  'a phone link in the content': (p) => (p.links || []).some(l => l.protocol === 'tel:' && l.region === 'main'),
  'a map': (p) => (p.mapEmbeds || []).length > 0,
  'a reviews block': (p) => (p.headings || []).some(h => /review|testimonial/i.test(h.text)),
}

const siblingsOf = (site, page) => {
  const profile = buildProfile(site)
  const key = pathKey(page.url)
  for (const sec of [profile.services, profile.locations]) {
    if (!sec.items.some(it => it.path === key)) continue
    const paths = new Set(sec.items.map(it => it.path))
    return site.pages.filter(p => paths.has(pathKey(p.url)))
  }
  return []
}

export default {
  id: 'K16',
  title: 'Missing a block that sibling pages in the section have',
  severity: 'minor',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    if (!site?.pages) return []
    const sibs = siblingsOf(site, page)
    if (sibs.length < MIN_SIBLINGS) return []
    const others = sibs.filter(p => p !== page)
    const M = sibs.length
    const out = []
    const report = (what, n, example, expected) => out.push(finding(this, page, {
      selector: null,
      found: `${n} of ${M} pages in the section have ${what}, this one does not`,
      expected: expected || `add ${what}, as on ${pathKey(example.url)}`,
    }))
    for (const [what, has] of Object.entries(FEATURES)) {
      const withIt = others.filter(has)
      if (!has(page) && withIt.length / others.length >= SHARE) report(what, withIt.length, withIt[0])
    }
    // Same section, another form: usually a page built before the form was
    // replaced.
    const ids = new Map()
    for (const p of others) for (const id of new Set((p.forms || []).map(f => f.id).filter(Boolean))) ids.set(id, (ids.get(id) || 0) + 1)
    const [topId, n] = [...ids].sort((a, b) => b[1] - a[1])[0] || []
    const mine = (page.forms || []).map(f => f.id)
    if (topId && mine.length && !mine.includes(topId) && n / others.length >= SHARE) {
      out.push(finding(this, page, {
        selector: 'form',
        found: `${n} of ${M} pages in the section use form #${topId}, this one uses another (#${mine.filter(Boolean).join(', #') || 'no id'})`,
        expected: `use form #${topId}, as on the sibling pages`,
      }))
    }
    return out
  },
}
