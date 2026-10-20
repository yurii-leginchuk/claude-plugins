import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'
import { isPost } from '../../lib/kinds.js'
import { buildProfile } from '../../lib/profile.js'

// Taxonomy E14/E16: the lists of services and locations disagree between
// the places that show them -- the header menu, the footer, the hub page
// (/services/) and the pages themselves. "A new service page nobody added to
// the menu", "the footer still has 8 of 10 services", "the menu links a
// service page that is not on the site any more".
//
//   a page of the section (or a link to one) missing from the menu, footer
//     or hub, when that place lists at least MIN_LIST of them;
//   a menu/footer/hub link into the section to a page the sitemap does not
//     have (a -dev page, a removed service) -- sitemap runs only;
//   a blog post linking into the section to such a page.
//
// Site-wide defects are reported once, on the hub (else the homepage, else
// the first page). Heuristic: a footer may list "top services" on purpose.
const MIN_LIST = 3

const segments = (href) => { try { return new URL(href).pathname.split('/').filter(Boolean) } catch { return [] } }
// In the section: listed in the profile (menu dropdown or root), or one
// level under one of its roots.
const inRoot = (href, sec) => {
  if (sec.paths?.includes(pathKey(href))) return true
  const s = segments(href)
  return s.length === 2 && sec.roots.includes(s[0].toLowerCase())
}

const cache = new WeakMap()

function places(site, sec, hub) {
  const at = { меню: new Map(), футер: new Map(), hub: new Map() }
  for (const p of site.pages) {
    const isHub = hub && pathKey(p.url) === pathKey(hub)
    for (const l of p.links || []) {
      if (!l.internal || !l.href || !inRoot(l.href, sec)) continue
      const place = ['header', 'nav'].includes(l.region) ? 'меню' : l.region === 'footer' ? 'футер'
        : isHub && l.region === 'main' ? 'hub' : null
      if (place && !at[place].has(pathKey(l.href))) at[place].set(pathKey(l.href), { text: l.text, link: l })
    }
  }
  return at
}

function analyse(site) {
  if (cache.has(site)) return cache.get(site)
  const profile = buildProfile(site)
  const crawled = new Set(site.pages.map(p => pathKey(p.url)))
  const home = site.pages.find(p => pathKey(p.url) === '/') || site.pages[0]
  const result = []
  for (const [kind, sec] of [['услуга', profile.services], ['локация', profile.locations]]) {
    const at = places(site, sec, sec.hub)
    const anchor = (sec.hub && site.pages.find(p => pathKey(p.url) === pathKey(sec.hub))) || home
    const hub = sec.hub ? pathKey(sec.hub) : null
    // "в меню / в футере / на странице /services" and "в меню / в футер / на страницу …"
    const label = (place) => place === 'hub' ? hub && `на странице ${hub}` : place === 'футер' ? 'в футере' : 'в меню'
    const into = (place) => place === 'hub' ? `на страницу ${hub}` : place === 'футер' ? 'в футер' : 'в меню'
    const known = new Map(sec.items.filter(it => it.path).map(it => [it.path, it.name]))
    for (const m of Object.values(at)) for (const [path, v] of m) if (!known.has(path)) known.set(path, v.text)
    for (const [path, name] of known) {
      const present = Object.keys(at).filter(pl => at[pl].has(path))
      const shown = at.меню.get(path)?.text || at.футер.get(path)?.text || name
      for (const place of Object.keys(at)) {
        if (at[place].size < MIN_LIST || at[place].has(path) || !label(place)) continue
        const where = present.length ? `есть ${present.map(label).join(', ')}` : 'страница есть на сайте'
        result.push({
          page: anchor,
          props: {
            selector: place === 'футер' ? 'footer' : place === 'меню' ? 'nav' : 'main',
            zone: place === 'футер' ? 'footer' : place === 'меню' ? 'nav' : 'main',
            found: `${kind} «${shown}» (${path}) ${where}, но нет ${label(place)}`,
            expected: `добавить ссылку «${shown}» → ${path} ${into(place)}`,
          },
        })
      }
    }
    if (site.source !== 'sitemap') continue
    for (const place of Object.keys(at)) {
      for (const [path, v] of at[place]) {
        if (crawled.has(path)) continue
        const s = site.linkStatus?.get(v.link.href)
        if (s && !s.ok) continue // E1 reports it
        if (s?.finalUrl && crawled.has(pathKey(s.finalUrl))) continue // I18 reports it
        result.push({
          page: anchor,
          props: {
            link: v.link, severity: 'major',
            found: `ссылка «${v.text}» ${label(place)} ведёт на ${path}, которой нет в sitemap`,
            expected: 'ссылка на действующую страницу раздела или страница — в sitemap',
          },
        })
      }
    }
  }
  cache.set(site, { result, crawled })
  return cache.get(site)
}

export default {
  id: 'E16',
  title: 'Списки услуг и локаций не совпадают между меню, футером и разделом',
  // A service the menu offers but the footer or the services page leaves
  // out is read straight off the markup and loses visitors: major, certain.
  severity: 'major',
  engine: 'static',
  confidence: 'high',
  check(page, site) {
    if (!site?.pages?.length) return []
    const { result, crawled } = analyse(site)
    const profile = buildProfile(site)
    const out = result.filter(r => r.page === page).map(r => finding(this, page, r.props))
    if (site.source === 'sitemap' && isPost(page)) {
      for (const l of page.links || []) {
        if (l.region !== 'main' || !l.internal || !l.href) continue
        if (!inRoot(l.href, profile.services) || crawled.has(pathKey(l.href))) continue
        if (site.linkStatus?.get(l.href)?.ok === false) continue
        out.push(finding(this, page, {
          link: l, severity: 'major',
          found: `пост ссылается на услугу вне sitemap: ${pathKey(l.href)}`,
          expected: 'ссылка на действующую страницу услуги',
        }))
      }
    }
    return out
  },
}
