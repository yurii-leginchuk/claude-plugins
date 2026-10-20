import { finding } from '../index.js'
import { pathKey, sameHost } from '../../lib/url.js'

// Taxonomy K13: the dev site drifted from the live one -- "the menu lost
// Admissions", "the footer is different", "where did the animation go".
// Runs only on a dev audit that knows production (`site.prod`, built by
// crawl/prod.js from --prod or a sheet's Dev Link column), comparing each dev
// page with its live counterpart:
//
//   menu and footer links: a live menu item whose page is not in the dev
//     menu is the main thing a relaunch loses. Compared by path; the same
//     text on a different path is reported as a renamed link instead.
//   pages: a live page that 404s on dev (whole-site audits only), which
//     would be a 404 for every visitor the day dev goes live;
//   schema types the live page has and the dev page lost;
//   headings, title, description and logo that changed (heuristic -- a
//     redesign changes them on purpose, but they should be changed on
//     purpose).
const MENU = { header: 'меню', nav: 'меню', footer: 'футер' }
const MAX_HEADINGS = 5
const TYPE = /"@type"\s*:\s*(?:"([^"]+)"|\[([^\]]+)\])/g

// Sub-nodes Yoast and RankMath emit inside the graph: their presence follows
// the parent types, so reporting them repeats the same loss five times.
const MINOR_TYPES = new Set(['ReadAction', 'EntryPoint', 'PropertyValueSpecification', 'SearchAction', 'ImageObject', 'ListItem'])

const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// `prodHost`: a dev clone often links its menu at production with absolute
// URLs. The item is still there (I14 reports the absolute link), so those
// count as the page's own.
function menuOf(p, prodHost) {
  const m = new Map()
  for (const l of p.links || []) {
    const where = MENU[l.region]
    if (!where || !l.href || (l.raw || '').startsWith('#')) continue
    if (!l.internal && !(prodHost && sameHost(l.href, `https://${prodHost}`))) continue
    const key = `${where}|${pathKey(l.href)}`
    if (!m.has(key)) m.set(key, { where, path: pathKey(l.href), text: l.text })
  }
  return m
}

function schemaTypes(p) {
  const t = new Set()
  for (const block of p.jsonLdRaw || []) {
    for (const m of block.matchAll(TYPE)) {
      for (const v of (m[1] ? [m[1]] : m[2].split(',').map(s => s.replace(/["\s]/g, '')))) if (v) t.add(v)
    }
  }
  return t
}

const fileOf = (u) => { try { return new URL(u).pathname.split('/').pop().replace(/-\d+x\d+(?=\.)/, '') } catch { return u } }

export default {
  id: 'K13',
  title: 'Дев расходится с лайвом',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const prod = site?.prod
    if (site?.env !== 'dev' || !prod) return []
    const out = []
    const push = (props) => out.push(finding(this, page, props))

    const home = site.pages.find(p => pathKey(p.url) === '/') || site.pages[0]
    if (page === home) {
      for (const m of prod.missing || []) {
        push({
          selector: 'sitemap',
          found: `страница есть на лайве, на деве ${m.status}: ${pathKey(m.prod)}`,
          expected: 'перенести страницу или поставить редирект до запуска',
        })
      }
    }

    const pair = (prod.pairs || []).find(x => x.dev === page.url)
    const live = pair && (prod.pages || []).find(p => p.url === pair.prod)
    if (!live) return out

    const devMenu = menuOf(page, prod.host)
    const devByText = new Map([...devMenu.values()].map(v => [`${v.where}|${norm(v.text)}`, v]))
    for (const [key, item] of menuOf(live)) {
      if (devMenu.has(key)) continue
      const renamed = item.text && devByText.get(`${item.where}|${norm(item.text)}`)
      push(renamed ? {
        selector: item.where === 'футер' ? 'footer' : 'nav', severity: 'minor', confidence: 'heuristic',
        found: `${item.where}: «${item.text}» ведёт на ${renamed.path}, на лайве — на ${item.path}`,
        expected: `${item.path} или редирект с него`,
      } : {
        selector: item.where === 'футер' ? 'footer' : 'nav',
        found: `${item.where}: пункт «${item.text || item.path}» (${item.path}) есть на лайве, нет на деве`,
        expected: 'тот же пункт, если его не убрали намеренно',
      })
    }

    const devTypes = schemaTypes(page)
    for (const t of [...schemaTypes(live)].filter(t => !devTypes.has(t) && !MINOR_TYPES.has(t))) {
      push({
        selector: 'script[type="application/ld+json"]', confidence: 'heuristic',
        found: `schema ${t} есть на лайве, нет на деве`, expected: 'та же разметка',
      })
    }

    const devHeadings = new Set((page.headings || []).map(h => norm(h.text)))
    const goneHeadings = (live.headings || [])
      .filter(h => h.level <= 3 && h.text && !devHeadings.has(norm(h.text)))
      .slice(0, MAX_HEADINGS)
    for (const h of goneHeadings) {
      push({
        selector: `h${h.level}`, severity: 'minor', confidence: 'heuristic',
        found: `заголовок H${h.level} «${h.text}» есть на лайве, нет на деве`, expected: 'тот же блок, если его не убрали намеренно',
      })
    }

    for (const [label, a, b] of [['title', live.title, page.title], ['description', live.metaDescription, page.metaDescription]]) {
      if (!a || norm(a) === norm(b)) continue
      push({
        selector: `meta/${label}`, severity: 'minor', confidence: 'heuristic',
        found: `${label} изменился: лайв «${a}» → дев «${b || '—'}»`, expected: 'как на лайве, если не меняли намеренно',
      })
    }

    if (live.logo && page.logo && fileOf(live.logo) !== fileOf(page.logo)) {
      push({
        selector: 'header img', severity: 'minor', confidence: 'heuristic',
        found: `другой логотип: лайв ${fileOf(live.logo)}, дев ${fileOf(page.logo)}`, expected: 'тот же логотип',
      })
    }
    return out
  },
}
