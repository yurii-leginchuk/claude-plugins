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
  'форма': (p) => (p.forms || []).length > 0,
  'блок FAQ': (p) => (p.headings || []).some(h => /faq|frequently asked/i.test(h.text)),
  'телефон-ссылка в контенте': (p) => (p.links || []).some(l => l.protocol === 'tel:' && l.region === 'main'),
  'карта': (p) => (p.mapEmbeds || []).length > 0,
  'блок отзывов': (p) => (p.headings || []).some(h => /review|testimonial/i.test(h.text)),
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
  title: 'Нет блока, который есть у соседних страниц раздела',
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
      found: `на ${n} из ${M} страниц раздела есть ${what}, здесь нет`,
      expected: expected || `добавить ${what}, как на ${pathKey(example.url)}`,
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
        found: `на ${n} из ${M} страниц раздела форма #${topId}, здесь другая (#${mine.filter(Boolean).join(', #') || 'без id'})`,
        expected: `поставить форму #${topId}, как на соседних страницах`,
      }))
    }
    return out
  },
}
