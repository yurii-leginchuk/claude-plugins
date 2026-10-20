import { finding, whereInText } from '../index.js'
import { ignoredByFacts } from '../../lib/facts.js'
import { US_STATES, stateOfAddress } from '../../lib/address.js'
import { buildProfile } from '../../lib/profile.js'

// Taxonomy H3/H12: "Connecticut instead of another state", "content from
// another site of the network" -- copy pasted from a sister site (Florida
// Helps -> Texas Helps) keeps the other state's name.
//
// The states this page is about: from facts (`states` plus the states of
// the gbp addresses), else the states named in its title and H1. Any other
// state named in the copy is reported. Heuristic: "clients travel from
// Oklahoma" is legitimate, and a page naming many states is a list of
// service areas, not a copy-paste.
//
// Taxonomy H12 for cities too (checks 7, 8): on a location page, another
// location's name (from the site's own /locations/<slug>/ pages) in the
// copy, the title or the description -- the Bronx page that still says
// Brooklyn. On location and service pages, an image copied from the page it
// names together with its alt ("Brooklyn office" on the Bronx page, and the
// same file on the Brooklyn page). A scenic "Manhattan skyline" photo used
// only here is description, not copy-paste. All heuristic.
const MAX_STATES = 6
// More other locations than this in the copy is an "areas we serve" list.
const MAX_OTHER_PLACES = 2
// Longest names first, so "West Virginia" is consumed before "Virginia".
const NAMES = Object.values(US_STATES).sort((a, b) => b.length - a.length)
const STATE_NAMES = new Set(NAMES)
const NAME_RE = new RegExp(`\\b(${NAMES.join('|')})\\b`, 'g')

function statesIn(text) {
  const found = new Set()
  for (const m of String(text || '').matchAll(NAME_RE)) {
    // "Washington, DC", "Washington County" and "George Washington" are not
    // the state.
    if (m[1] === 'Washington' && /^\s*(,?\s*D\.?C\b|County|Street|St\b|Ave)/.test(text.slice(m.index + m[0].length))) continue
    if (m[1] === 'Washington' && /[A-Z][a-z]+\s$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    found.add(m[1])
  }
  return found
}

export default {
  id: 'H12',
  title: 'Упоминается чужой штат или город',
  severity: 'minor',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    if (ignoredByFacts(site?.facts, page.url)) return []
    return [...states(this, page, site), ...places(this, page, site)]
  },
}

// "staten-island" -> /\bstaten\s+island\b/i, labelled "Staten Island".
const phraseOf = (slug) => {
  const words = slug.split('-').filter(Boolean)
  return {
    label: words.map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
    re: new RegExp(`\\b${words.join('[\\s-]+')}\\b`, 'i'),
  }
}

function places(rule, page, site) {
  const profile = buildProfile(site || {})
  const out = []
  const file = (src) => String(src || '').split('?')[0].replace(/-\d+x\d+(?=\.\w+$)/, '')
  const srcsOn = (url) => new Set(((site?.pages || []).find(p => p.url === url)?.images || []).map(i => file(i.src)))
  const check = (items, kind) => {
    const own = items.find(i => i.url === page.url)
    if (!own) return
    const others = items.filter(i => i !== own && i.slug && !phraseOf(i.slug).re.test(own.slug.replace(/-/g, ' ')))
      .map(i => ({ ...phraseOf(i.slug), url: i.url }))
      // A location that is a state ("new-jersey") is states()'s finding.
      .filter(o => !STATE_NAMES.has(o.label))
    // A lazy image with no src has no identity: two of them are not "the
    // same picture", and comparing '' with '' made one up.
    const alts = (page.images || []).map(i => ({ alt: i.alt || '', selector: i.selector, src: file(i.src) })).filter(i => i.alt && i.src)
    // The featured image lives only in schema (Yoast primaryimage caption,
    // a Service's image): invisible on the page, shown in shares and results.
    const captions = (page.jsonLdRaw || []).flatMap(b => [...b.matchAll(/"caption"\s*:\s*"([^"]{3,200})"/g)].map(m => m[1]))
    const fields = kind === 'location'
      ? [['title', page.title], ['description', page.metaDescription]]
      : []
    for (const o of others) {
      for (const [where, value] of fields) {
        if (value && o.re.test(value)) {
          out.push(finding(rule, page, {
            selector: `meta/${where}`, found: `${where} страницы «${own.name}» упоминает «${o.label}»: «${value}»`,
            expected: `${where} про «${own.name}»`,
          }))
        }
      }
      for (const c of new Set(captions)) {
        if (o.re.test(c) && !phraseOf(own.slug).re.test(c)) {
          out.push(finding(rule, page, {
            selector: 'script[type="application/ld+json"]',
            found: `картинка записи (featured image) страницы «${own.name}» подписана про «${o.label}»: «${c}»`,
            where: 'schema (Yoast primaryimage / Service image) — на странице её не видно, она в превью и поиске',
            expected: `поставить странице свою featured image или сменить подпись/alt картинки в медиатеке на «${own.name}»`,
          }))
        }
      }
      for (const a of alts) {
        if (o.re.test(a.alt) && !phraseOf(own.slug).re.test(a.alt) && srcsOn(o.url).has(a.src)) {
          out.push(finding(rule, page, {
            selector: a.selector, found: `картинка со страницы «${o.label}» вместе с её alt: «${a.alt}»`,
            where: `контент · картинка ${a.src.split('/').pop()}`, expected: `своя картинка и alt про «${own.name}»`,
          }))
        }
      }
    }
    if (kind !== 'location') return
    let copy = String(page.text || '')
    for (const chrome of [page.headerText, page.footerText]) if (chrome) copy = copy.replace(chrome, ' ')
    for (const l of page.links || []) if (l.text) copy = copy.split(l.text).join(' ')
    const named = others.filter(o => o.re.test(copy))
    if (!named.length || named.length > MAX_OTHER_PLACES) return
    for (const o of named) {
      out.push(finding(rule, page, {
        selector: 'body', found: `на странице «${own.name}» упоминается «${o.label}»`,
        where: whereInText(page, copy.match(o.re)[0]),
        expected: `«${own.name}», если упоминание не намеренное`,
      }))
    }
  }
  check(profile.locations.items, 'location')
  check(profile.services.items, 'service')
  return out
}

function states(rule, page, site) {
  const facts = site?.facts
  let own = new Set([
    ...(facts?.states || []),
    ...(facts?.gbp || []).map(g => stateOfAddress(g.address)).filter(Boolean),
  ])
  if (!own.size) {
    const h1 = (page.headings || []).filter(h => h.level === 1).map(h => h.text).join(' ')
    own = statesIn(`${page.title || ''} ${h1}`)
  }
  if (!own.size) return []
  // The header and footer list every location of a multi-state brand on
  // every page; only the page's own copy can mention the wrong state.
  let copy = String(page.text || '')
  for (const chrome of [page.headerText, page.footerText]) if (chrome) copy = copy.replace(chrome, ' ')
  const mentioned = statesIn(copy)
  if (mentioned.size > MAX_STATES) return []
  // A state that is a link ("New Jersey" -> /locations/new-jersey/) is
  // navigation to another location, not pasted copy.
  const linked = new Set((page.links || []).map(l => (l.text || '').trim()))
  const ownLabel = [...own].join(', ')
  return [...mentioned].filter(s => !own.has(s) && !linked.has(s)).map(s => finding(rule, page, {
    selector: 'body',
    found: `на странице про ${ownLabel} упоминается ${s}`,
    where: whereInText(page, s),
    expected: `только ${ownLabel}, если упоминание не намеренное`,
  }))
}
