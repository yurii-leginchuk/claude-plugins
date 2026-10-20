import { finding } from '../index.js'
import { ignoredByFacts, locationFor as locationOf } from '../../lib/facts.js'
import { addressNorm as norm, streetOf } from '../../lib/address.js'
import { classifyGoogleLink, linkKey, placeKey, embedKey } from '../../lib/gbp.js'

// Taxonomy E9: 32 QA remarks in a year -- "make address active", "change
// address link to GBP", "make all links to GBP (not address on the map)",
// "wrong GBP link on the Tuesday page", "GBP link has a redirect", "the map
// doesn't show the right location". See lib/gbp.js for how a link is
// reduced to the profile (CID) it opens.
//
// Always checked: links to a Google search or to the address on the map
// instead of a profile, g.page links, short links that open nothing, and
// addresses with no link (heuristic: found by pattern).
//
// With facts.gbp: every profile link and map embed must open one of the
// listed profiles, a location page (facts.gbp[].paths) must link its own
// location, and each listed address must be a link wherever it appears.
//
// Without facts: the same address text linked to different profiles on
// different pages (heuristic -- one of them is likely the duplicate listing).

const count = (hay, needle) => needle.trim() ? hay.split(needle).length - 1 : 0

// A US street line: number, up to four capitalised words, a street suffix.
// The words are Title-case or ordinals only, and the number may not follow
// a digit or dash: otherwise a phone tail and a button label in front of the
// address ("607-8758 VERIFY INSURANCE 343 Forest Ave") become part of it.
const ADDRESS = /(?<![\d-])\b\d{2,6}\s+(?:[NSEW]\.?\s+)?(?:(?:[A-Z][a-z'-]+|\d+(?:st|nd|rd|th))\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Highway|Hwy|Parkway|Pkwy|Court|Ct|Place|Pl|Circle|Cir|Trail|Trl|Terrace|Pike|Square|Loop)\b/g

// "2025 From Drive-Thru to…": a year starting a heading is not a house
// number often enough to drop 1990–2039 from the pattern-only mode.
const YEARLIKE = /^(199\d|20[0-3]\d)\s/

const SEARCH_KIND = (raw) => /\/search/.test(new URL(raw).pathname) && !/\/maps/.test(new URL(raw).pathname)
  ? 'поиск Google' : 'адрес на карте'

export default {
  id: 'E9',
  title: 'Ссылки на Google Business Profile и карты',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const facts = site?.facts
    if (ignoredByFacts(facts, page.url)) return []
    const resolved = site?.gbp || new Map()
    const ctx = { rule: this, page, resolved, locs: locations(facts, resolved), out: [], seen: new Set() }
    ctx.pageLoc = locationOf(ctx.locs, page.url)
    links(ctx)
    embeds(ctx)
    addresses(ctx)
    if (!ctx.locs.length) consistency(ctx, site)
    return ctx.out
  },
}

function push(ctx, props) {
  const k = `${props.selector}|${props.found}`
  if (ctx.seen.has(k)) return
  ctx.seen.add(k)
  ctx.out.push(finding(ctx.rule, ctx.page, props))
}

function locations(facts, resolved) {
  return (facts?.gbp || []).map(g => ({ ...g, key: placeKey(g.url) || resolved.get(g.url)?.key || null }))
}

const label = (loc) => loc.name || loc.address || loc.url
const expectedFor = (ctx) => ctx.pageLoc ? ctx.pageLoc.url
  : ctx.locs.length === 1 ? ctx.locs[0].url : 'ссылка на профиль GBP нужной локации'

// Compares a profile against the facts. A facts entry whose short link could
// not be resolved (network) leaves its CID unknown, so mismatches are then
// only heuristic: the link may well be that entry.
function checkKey(ctx, key, selector, what) {
  if (!key || !ctx.locs.length) return
  const known = ctx.locs.filter(l => l.key)
  if (!known.length) return
  const confidence = known.length < ctx.locs.length ? 'heuristic' : 'high'
  const match = known.find(l => l.key === key)
  const name = ctx.resolvedName || ''
  if (ctx.pageLoc?.key && key !== ctx.pageLoc.key) {
    push(ctx, {
      selector, confidence,
      found: match
        ? `${what} на странице локации «${label(ctx.pageLoc)}» ведёт на профиль другой локации «${label(match)}»`
        : `${what} на странице локации «${label(ctx.pageLoc)}» ведёт на профиль не из фактов${name}`,
      expected: ctx.pageLoc.url,
    })
  } else if (!match) {
    push(ctx, { selector, confidence, found: `${what} ведёт на профиль не из фактов${name}`, expected: expectedFor(ctx) })
  }
}

function links(ctx) {
  for (const l of ctx.page.links || []) {
    if (!l.href) continue
    const kind = classifyGoogleLink(l.raw)
    if (!kind || kind === 'dir') continue
    if (kind === 'search') {
      push(ctx, {
        selector: l.selector,
        found: `ссылка ведёт на ${SEARCH_KIND(l.raw)}, а не на профиль GBP: ${l.raw}`,
        expected: expectedFor(ctx),
      })
      continue
    }
    if (kind === 'legacy') {
      push(ctx, {
        selector: l.selector, severity: 'minor',
        found: `ссылка старого формата g.page, открывается через редирект: ${l.raw}`,
        expected: 'прямая ссылка на профиль (maps.app.goo.gl/… из «Поделиться» в GBP)',
      })
    }
    const r = ctx.resolved.get(l.href)
    if ((kind === 'short' || kind === 'legacy') && r && r.status >= 400) {
      push(ctx, {
        selector: l.selector, severity: 'critical',
        found: `ссылка на GBP не открывается (HTTP ${r.status}): ${l.raw}`, expected: expectedFor(ctx),
      })
      continue
    }
    if ((kind === 'short' || kind === 'legacy') && r && r.status && !r.key && r.finalUrl) {
      const k = classifyGoogleLink(r.finalUrl)
      if (k === 'search') {
        push(ctx, {
          selector: l.selector,
          found: `короткая ссылка ведёт на ${SEARCH_KIND(r.finalUrl)}, а не на профиль GBP: ${l.raw}`,
          expected: expectedFor(ctx),
        })
        continue
      }
    }
    const key = linkKey(l.raw, l.href, ctx.resolved)
    ctx.resolvedName = r?.name ? ` (${r.name})` : ''
    checkKey(ctx, key, l.selector, `ссылка ${l.raw}`)
  }
  ctx.resolvedName = ''
}

function embeds(ctx) {
  for (const src of ctx.page.mapEmbeds || []) {
    checkKey(ctx, embedKey(src), 'iframe[src*="google"]', 'карта (iframe)')
  }
}

const isProfileLink = (l) => {
  const k = l.href ? classifyGoogleLink(l.raw) : null
  return k && k !== 'search'
}

// "make address active": an address in the copy that is not inside a link.
// Counted, not just found: the footer address may be linked while the same
// address in the hero is not, and that is still a remark.
function addresses(ctx) {
  const text = norm(ctx.page.text)
  const linkTexts = (ctx.page.links || []).map(l => ({ l, t: norm(l.text) }))
  const known = ctx.locs.filter(l => l.address)
  const streets = known.length
    ? known.map(l => ({ street: streetOf(l.address), loc: l }))
    : [...new Map([...String(ctx.page.text || '').matchAll(ADDRESS)]
      .filter(m => !YEARLIKE.test(m[0]))
      .map(m => [norm(m[0]), m[0].trim()])).values()].map(street => ({ street }))
  const confidence = known.length ? 'high' : 'heuristic'
  for (const { street, loc } of streets) {
    const s = norm(street)
    if (s.trim().split(' ').length < 2) continue
    const inText = count(text, s)
    if (!inText) continue
    const linked = linkTexts.filter(x => x.t.includes(s))
    const toProfile = linked.filter(x => isProfileLink(x.l)).length
    for (const x of linked) {
      if (isProfileLink(x.l) || !x.l.href) continue
      push(ctx, {
        selector: x.l.selector, confidence,
        found: `адрес «${street}» ведёт не на GBP: ${x.l.raw}`,
        expected: loc?.url || expectedFor(ctx),
      })
    }
    if (inText > linked.length) {
      push(ctx, {
        selector: 'body', confidence,
        found: `адрес «${street}» не кликабельный`,
        occurrences: `${inText - linked.length} из ${inText} упоминаний без ссылки`,
        expected: loc?.url || expectedFor(ctx),
        ...(toProfile ? { severity: 'minor' } : {}),
      })
    }
  }
}

// Without facts, the site against itself: one anchor text (an address, a
// location name) opening different profiles on different pages.
const anchorIndex = new WeakMap()

function anchorsOf(site) {
  if (anchorIndex.has(site)) return anchorIndex.get(site)
  const m = new Map()
  for (const p of site.pages || []) {
    for (const l of p.links || []) {
      if (!l.href || !isProfileLink(l)) continue
      const t = norm(l.text).trim()
      if (t.length < 6) continue
      const key = linkKey(l.raw, l.href, site.gbp)
      if (!key) continue
      if (!m.has(t)) m.set(t, new Map())
      const byKey = m.get(t)
      if (!byKey.has(key)) byKey.set(key, new Set())
      byKey.get(key).add(p.url)
    }
  }
  anchorIndex.set(site, m)
  return m
}

function consistency(ctx, site) {
  if (!site?.pages) return
  const idx = anchorsOf(site)
  for (const l of ctx.page.links || []) {
    if (!l.href || !isProfileLink(l)) continue
    const byKey = idx.get(norm(l.text).trim())
    if (!byKey || byKey.size < 2) continue
    const key = linkKey(l.raw, l.href, ctx.resolved)
    const [topKey, topPages] = [...byKey].sort((a, b) => b[1].size - a[1].size)[0]
    if (key === topKey) continue
    push(ctx, {
      selector: l.selector, confidence: 'heuristic',
      found: `«${l.text}» ведёт на другой профиль GBP, чем на ${topPages.size} других стр.: ${l.raw}`,
      expected: 'одна ссылка на профиль для одной локации по всему сайту',
    })
  }
}
