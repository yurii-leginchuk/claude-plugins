import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'
import { buildProfile, sameName } from '../../lib/profile.js'

// Taxonomy G13: "the form has old options", "this service is missing from
// the dropdown". The choices of a services or locations field are compared
// with what the site actually offers: its service/location pages and the
// header menu. Naming differs legitimately ("Restaurant" vs "Restaurants"),
// so matching is loose and the findings stay heuristic.
//
// One finding per form, on the first page that carries it: a form embedded
// on thirty pages is one form to fix.
const SERVICE_FIELD = /service|interested|treatment|program|help with|need/i
const LOCATION_FIELD = /location|city|area|office|county|borough/i
const NOT_A_CHOICE = /^(other|select|none|choose|please|--|n\/a|not sure|all)\b/i

const segments = (href) => { try { return new URL(href).pathname.split('/').filter(Boolean) } catch { return [] } }

// path -> { menu texts, the page's own H1, slug words }. Menu texts come
// first when matching: a page's H1 can be wrong itself (a copied page).
function inventory(site, sec, items) {
  const m = new Map()
  const get = (path) => m.get(path) || m.set(path, { path, names: new Set(), page: null, slug: '' }).get(path)
  for (const it of items) {
    const s = get(it.path)
    s.page = it.name || null
    s.slug = it.slug.replace(/-/g, ' ')
  }
  for (const p of site.pages || []) {
    for (const l of p.links || []) {
      if (!l.internal || !l.href || !['header', 'nav'].includes(l.region) || !l.text) continue
      const seg = segments(l.href)
      const inSec = sec.paths?.includes(pathKey(l.href)) || (seg.length === 2 && sec.roots.includes(seg[0].toLowerCase()))
      if (!inSec) continue
      const s = get(pathKey(l.href))
      s.names.add(l.text)
      s.slug = s.slug || (seg.at(-1) || '').replace(/-/g, ' ')
    }
  }
  return [...m.values()]
}

const formKey = (f) => f.id || f.fields.map(x => x.label).join('|')
const firstPage = new WeakMap()
function isFirstPage(site, page, f) {
  if (!firstPage.has(site)) {
    const m = new Map()
    for (const p of site.pages || []) for (const x of p.forms || []) if (!m.has(formKey(x))) m.set(formKey(x), p.url)
    firstPage.set(site, m)
  }
  const first = firstPage.get(site).get(formKey(f))
  return !first || first === page.url
}

export default {
  id: 'G13',
  title: 'Form options do not match the site services and locations',
  severity: 'major',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    if (!page.forms?.length || !site?.pages) return []
    const profile = buildProfile(site)
    const kinds = [
      { re: SERVICE_FIELD, what: 'service', list: inventory(site, profile.services, profile.services.items) },
      { re: LOCATION_FIELD, what: 'location', list: inventory(site, profile.locations, profile.locations.items) },
    ]
    const out = []
    for (const f of page.forms) {
      if (!isFirstPage(site, page, f)) continue
      for (const field of f.fields || []) {
        const options = (field.options || []).filter(o => !NOT_A_CHOICE.test(o))
        if (options.length < 2) continue
        const kind = kinds.find(k => k.re.test(field.label || ''))
        if (!kind || kind.list.length < 2) continue
        out.push(...compare(this, page, f, field, options, kind))
      }
    }
    return out
  },
}

function compare(rule, page, form, field, options, { what, list }) {
  const label = (field.label || '').replace(/\*?\(Required\)$/i, '').replace(/\*$/, '').trim()
  const where = `${form.id ? `form #${form.id} · ` : ''}field “${label}”`
  // The form id leads `found`: two forms with the same wrong option are two fixes.
  const tag = form.id ? `form #${form.id}: ` : ''
  const at = (props) => finding(rule, page, { selector: field.selector, where, ...props, found: tag + props.found })
  const out = []
  const covered = new Set()
  for (const o of options) {
    const byName = list.find(s => [...s.names].some(n => sameName(o, n))) ||
      list.find(s => s.page && sameName(o, s.page))
    if (byName) { covered.add(byName); continue }
    const bySlug = list.find(s => s.slug && sameName(o, s.slug))
    if (bySlug) {
      covered.add(bySlug)
      const name = [...bySlug.names][0]
      if (name) {
        out.push(at({
          severity: 'minor',
          found: `option “${o}” does not match the name: the ${what} is called “${name}” (${bySlug.path})`,
          expected: `rename the option to “${name}”`,
        }))
      }
      continue
    }
    out.push(at({
      found: `option “${o}” matches no page (${what})`,
      expected: `remove option “${o}” or check whether this service/location was removed from the site`,
    }))
  }
  for (const s of list) {
    if (covered.has(s)) continue
    const name = [...s.names][0] || s.page || s.slug
    out.push(at({
      found: `the field has no option “${name}” (${s.path})`,
      expected: `add option “${name}” to field “${label}”`,
    }))
  }
  return out
}
