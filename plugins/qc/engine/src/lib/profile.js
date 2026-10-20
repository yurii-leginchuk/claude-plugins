// What the site is: brand, services, locations, contacts and forms, built
// once from the crawled pages. Rules compare pages against it ("the form
// lists 9 services, the menu 10"), and the CLI writes it to the run
// directory so Claude can describe the site and review findings with it.
//
// Everything here is read off the site itself, so it is a reference for
// consistency ("the site disagrees with itself"), never for truth -- that is
// what the facts file is for.
import { pathKey } from './url.js'
import { phoneKey } from './phone.js'

export const SERVICE_ROOTS = ['services', 'service', 'our-services', 'programs', 'treatment', 'treatments', 'what-we-do', 'solutions']
export const LOCATION_ROOTS = ['locations', 'location', 'areas', 'service-areas', 'areas-we-serve', 'cities', 'offices']

// Dropdown labels that hold a site's services or locations, whatever the
// URLs under them look like (/drug-rehab/…, /catering/, /carpet-cleaning/).
const SERVICE_LABEL = /^(our\s+)?(services?|treatments?|programs?|what\s+we\s+(do|treat|offer)|levels?\s+of\s+care|solutions|specialties|therapies|cleaning\s+services)$/i
const LOCATION_LABEL = /^(our\s+)?(locations?|areas?(\s+we\s+serve)?|service\s+areas?|offices?|cities|where\s+we\s+(serve|work))$/i

// Header/nav links in a dropdown whose label matches: path -> {text, href},
// plus the dropdown's own link (the hub, e.g. "Services" -> /services/).
function menuSection(pages, label) {
  const items = new Map()
  let hub = null
  for (const p of pages) {
    for (const l of p.links || []) {
      if (!l.internal || !l.href || !['header', 'nav'].includes(l.region) || !l.menuParent) continue
      if (!label.test(l.menuParent.text || '')) continue
      if (l.menuParent.href && !hub) hub = l.menuParent.href
      const k = pathKey(l.href)
      if (k && k !== '/' && !items.has(k)) items.set(k, { text: l.text, href: l.href })
    }
  }
  return { items, hub }
}

const GENERIC_SITE_NAMES = /^(site|home|website|wordpress|my blog|untitled)$/i

// "Carpet Cleaning Services NYC | Opura" -> "Carpet Cleaning Services NYC".
export const nameOf = (p) => {
  const h1 = (p.headings || []).find(h => h.level === 1)?.text
  return (h1 || String(p.title || '').split(/\s[|–—-]\s/)[0] || '').trim()
}

const segments = (url) => {
  try { return new URL(url).pathname.split('/').filter(Boolean) } catch { return [] }
}

// Pages one level under a section root (/services/carpet-cleaning/), plus
// the root itself as the hub (/services/).
function section(pages, roots, menu = { items: new Map(), hub: null }, listed = []) {
  const items = []
  let hub = null
  const byPath = new Map(pages.map(p => [pathKey(p.url), p]))
  // Facts first: the confirmed list replaces menu and URL guessing.
  if (listed.length) {
    for (const f of listed) {
      const path = f.url ? pathKey(f.url) : null
      const p = path && byPath.get(path)
      items.push({ url: p ? p.url : f.url, path, name: f.name, slug: path ? (segments(f.url).at(-1) || '') : '', menu: f.name, fromFacts: true })
    }
    return { hub: menu.hub && byPath.get(pathKey(menu.hub)) ? menu.hub : null, items, roots, paths: items.map(i => i.path).filter(Boolean), source: 'facts' }
  }
  // Menu-labelled items first: they are the site's own word for its list.
  for (const [path, m] of menu.items) {
    const p = byPath.get(path)
    const s = segments(m.href)
    items.push({ url: p ? p.url : m.href, path, name: p ? nameOf(p) : m.text, slug: s.at(-1) || '', menu: m.text })
  }
  if (menu.hub && byPath.get(pathKey(menu.hub))) hub = byPath.get(pathKey(menu.hub))
  for (const p of pages) {
    const s = segments(p.url)
    if (!s.length || !roots.includes(s[0].toLowerCase())) continue
    if (s.length === 1) { hub = hub || p; continue }
    if (s.length === 2 && !items.some(i => i.path === pathKey(p.url))) items.push({ url: p.url, path: pathKey(p.url), name: nameOf(p), slug: s[1] })
  }
  return { hub: hub ? hub.url : null, items, roots, paths: items.map(i => i.path) }
}

function brandOf(pages) {
  const counts = new Map()
  const add = (v) => { if (v && !GENERIC_SITE_NAMES.test(v)) counts.set(v, (counts.get(v) || 0) + 1) }
  for (const p of pages) {
    add(p.siteName?.trim())
    const parts = String(p.title || '').split(/\s[|–—]\s/)
    if (parts.length > 1) add(parts.at(-1).trim())
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null
}

function formsOf(pages) {
  const byId = new Map()
  for (const p of pages) {
    for (const f of p.forms || []) {
      const key = f.id || `${f.fields.map(x => x.label).join('|')}`
      if (!byId.has(key)) byId.set(key, { id: f.id, pages: [], fields: f.fields.map(x => ({ label: x.label, type: x.inputType, options: x.options || [] })) })
      byId.get(key).pages.push(p.url)
    }
  }
  return [...byId.values()]
}

// Pages Claude classified as this type in facts.pages, as {name, url}.
function typed(pages, facts, type) {
  const types = facts?.pages || {}
  return pages.filter(p => types[pathKey(p.url)?.split('?')[0]] === type).map(p => ({ name: nameOf(p), url: p.url }))
}

const cache = new WeakMap()

export function buildProfile(site) {
  if (cache.has(site)) return cache.get(site)
  const pages = site.pages || []
  const phones = new Map()
  for (const p of pages) {
    for (const l of p.links || []) {
      const k = l.protocol === 'tel:' && phoneKey(l.raw)
      if (k) phones.set(k, (phones.get(k) || 0) + 1)
    }
  }
  const emails = new Set()
  for (const p of pages) for (const l of p.links || []) if (l.protocol === 'mailto:') emails.add(l.raw.replace(/^mailto:/i, '').split('?')[0].toLowerCase())
  const profile = {
    brand: brandOf(pages),
    pages: pages.length,
    services: section(pages, SERVICE_ROOTS, menuSection(pages, SERVICE_LABEL), site.facts?.services?.length ? site.facts.services : typed(pages, site.facts, 'service')),
    locations: section(pages, LOCATION_ROOTS, menuSection(pages, LOCATION_LABEL), site.facts?.locations?.length ? site.facts.locations : typed(pages, site.facts, 'location')),
    phones: [...phones].sort((a, b) => b[1] - a[1]).map(([key, links]) => ({ key, links })),
    emails: [...emails],
    forms: formsOf(pages),
  }
  cache.set(site, profile)
  return profile
}

// Loose name match: "Apartment & Home Cleaning" ~ "Residential"? no;
// "Car Dealerships" ~ "Car Dealership"? yes. Word stems (first 5 letters)
// minus filler words, matched when most of the shorter side is shared.
const FILLER = new Set(['and', 'the', 'of', 'for', 'in', 'services', 'service', 'cleaning', 'treatment', 'program', 'programs', 'nyc', 'ny'])
export const stems = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/)
  .filter(w => w && !FILLER.has(w)).map(w => w.slice(0, 5)))
export function sameName(a, b) {
  const x = stems(a), y = stems(b)
  if (!x.size || !y.size) return String(a).toLowerCase().trim() === String(b).toLowerCase().trim()
  const shared = [...x].filter(w => y.has(w)).length
  return shared / Math.min(x.size, y.size) >= 0.5
}
