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
  const at = { menu: new Map(), footer: new Map(), hub: new Map() }
  for (const p of site.pages) {
    const isHub = hub && pathKey(p.url) === pathKey(hub)
    for (const l of p.links || []) {
      if (!l.internal || !l.href || !inRoot(l.href, sec)) continue
      const place = ['header', 'nav'].includes(l.region) ? 'menu' : l.region === 'footer' ? 'footer'
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
  for (const [kind, sec] of [['service', profile.services], ['location', profile.locations]]) {
    const at = places(site, sec, sec.hub)
    const anchor = (sec.hub && site.pages.find(p => pathKey(p.url) === pathKey(sec.hub))) || home
    const hub = sec.hub ? pathKey(sec.hub) : null
    // "in the menu / in the footer / on page /services" and "to the menu / to the footer / to page …"
    const label = (place) => place === 'hub' ? hub && `on page ${hub}` : place === 'footer' ? 'in the footer' : 'in the menu'
    const into = (place) => place === 'hub' ? `to page ${hub}` : place === 'footer' ? 'to the footer' : 'to the menu'
    const known = new Map(sec.items.filter(it => it.path).map(it => [it.path, it.name]))
    for (const m of Object.values(at)) for (const [path, v] of m) if (!known.has(path)) known.set(path, v.text)
    for (const [path, name] of known) {
      const present = Object.keys(at).filter(pl => at[pl].has(path))
      const shown = at.menu.get(path)?.text || at.footer.get(path)?.text || name
      for (const place of Object.keys(at)) {
        if (at[place].size < MIN_LIST || at[place].has(path) || !label(place)) continue
        const where = present.length ? `is ${present.map(label).join(', ')}` : 'the page exists on the site'
        result.push({
          page: anchor,
          props: {
            selector: place === 'footer' ? 'footer' : place === 'menu' ? 'nav' : 'main',
            zone: place === 'footer' ? 'footer' : place === 'menu' ? 'nav' : 'main',
            found: `${kind} “${shown}” (${path}) ${where}, but not ${label(place)}`,
            expected: `add link “${shown}” → ${path} ${into(place)}`,
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
            found: `link “${v.text}” ${label(place)} points to ${path}, which is not in the sitemap`,
            expected: 'link to a live page of the section, or add the page to the sitemap',
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
  title: 'Service and location lists differ between the menu, the footer and the section',
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
          found: `post links to a service outside the sitemap: ${pathKey(l.href)}`,
          expected: 'link to a live service page',
        }))
      }
    }
    return out
  },
}
