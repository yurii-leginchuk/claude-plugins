import { DEFAULT_TIMEOUT_MS } from '../crawl/fetch.js'

// Google Business Profile / Maps links. QA's E9 remarks are all one of:
// "make address active" (an address with no link), "change address link to
// GBP" (a link to the address on the map or to a Google search instead of
// the profile), "wrong GBP" (another location's profile, or a duplicate
// listing with a different rating) and "GBP link has a redirect".
//
// A profile is identified by its CID -- the decimal form of the second half
// of the feature id `0x…:0x…` that place URLs, map embeds and review links
// carry. Two different maps.app.goo.gl links can open the same profile, so
// short links are resolved and compared by CID, never by their own text.

const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.[a-z.]{2,6}$/i
const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'share.google', 'g.co'])
// The place's own feature id is the `!1s` one; place URLs can carry others
// first (`!5s` is the building it sits in), so `!1s` is preferred and a bare
// pair is the fallback for review links (`lrd=`) and hand-made URLs.
const FTID_1S = /!1s(0x[0-9a-f]{6,}):(0x[0-9a-f]+)/i
const FTID = /(0x[0-9a-f]{6,}):(0x[0-9a-f]+)/i
const ftidOf = (s) => FTID_1S.exec(s) || FTID.exec(s)

function cidOf(hex) {
  try { return BigInt(hex).toString() } catch { return null }
}

// The profile a resolved/inline Google URL points at, or null when it names
// no single profile. `raw` keeps the #fragment that normalizeUrl strips:
// review links carry the profile only in `#lrd=0x…:0x…`.
export function placeKey(raw) {
  if (!raw) return null
  let u
  try { u = new URL(raw) } catch { return null }
  const cid = u.searchParams.get('cid') || u.searchParams.get('ludocid')
  if (cid && /^\d+$/.test(cid)) return cid
  const ftid = ftidOf(decodeURIComponent(u.pathname + u.search + u.hash))
  if (ftid) return cidOf(ftid[2])
  const kg = u.searchParams.get('kgmid')
  return kg ? `kg:${kg}` : null
}

// Place name from /maps/place/<Name>/…, for messages only.
export function placeName(raw) {
  const m = /\/maps\/place\/([^/@?]+)/.exec(raw || '')
  if (!m) return null
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')) } catch { return m[1] }
}

// What kind of Google link this is:
//   short    maps.app.goo.gl / goo.gl/maps / share.google -- needs resolving
//   legacy   g.page -- the old short format, always a redirect hop
//   profile  names one profile inline (place URL with feature id, ?cid=,
//            review link with lrd/ludocid, kgmid search)
//   place    /maps/place/<name> with no feature id -- a profile by name,
//            usually right, but not comparable
//   search   a Google search or the address dropped on the map: not GBP
//   dir      directions -- a deliberate "Get directions" button, left alone
// null when it is not a Google Maps/GBP link at all.
export function classifyGoogleLink(raw) {
  let u
  try { u = new URL(raw) } catch { return null }
  const host = u.hostname.toLowerCase()
  const path = u.pathname
  if (SHORT_HOSTS.has(host) || (host === 'goo.gl' && path.startsWith('/maps'))) {
    if (host === 'g.co' && !path.startsWith('/kgs/')) return null
    return 'short'
  }
  // g.page/r/<id>/review is the "leave a review" link GBP itself hands out
  // today -- a short link like any other, not the retired g.page/<name>.
  if (host === 'g.page') return /^\/r\//.test(path) ? 'short' : 'legacy'
  if (!GOOGLE_HOST.test(host)) return null
  const isMaps = host.startsWith('maps.') || path.startsWith('/maps')
  if (!isMaps && path !== '/search') return null
  if (path.startsWith('/maps/dir')) return 'dir'
  if (path.startsWith('/maps/embed')) return null
  if (placeKey(raw)) return 'profile'
  if (path.startsWith('/maps/place/')) return 'place'
  return 'search'
}

// Map iframes: the embed's `pb` carries the feature id as `!1s0x…:0x…`.
export function embedKey(src) {
  const m = ftidOf(decodeURIComponent(src || ''))
  return m ? cidOf(m[2]) : null
}

// Short links answer a desktop-Chrome user agent with a 200 JavaScript page
// and only a plain client with the 302 -- so this is a bare fetch with its
// own UA rather than fetchOne, following the hops by hand to see each one.
const RESOLVE_UA = 'Mozilla/5.0 qc-engine'
const MAX_HOPS = 4

async function resolveOne(url, fetchImpl) {
  let current = url
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS)
    let res
    try {
      res = await fetchImpl(current, {
        method: 'GET', redirect: 'manual', signal: ac.signal, headers: { 'user-agent': RESOLVE_UA },
      })
    } catch (e) {
      return { url, status: 0, finalUrl: null, key: null, error: e.message }
    } finally {
      clearTimeout(timer)
    }
    if (res.body) { try { await res.body.cancel() } catch { /* ignore */ } }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!loc) {
      const key = placeKey(current)
      return { url, status: res.status, finalUrl: current, key, name: placeName(current), error: null }
    }
    let next = new URL(loc, current)
    // An EU consent wall wraps the real target in ?continue=.
    if (next.hostname.startsWith('consent.') && next.searchParams.get('continue')) {
      next = new URL(next.searchParams.get('continue'))
    }
    current = next.toString()
    if (placeKey(current)) {
      return { url, status: res.status, finalUrl: current, key: placeKey(current), name: placeName(current), error: null }
    }
  }
  return { url, status: 0, finalUrl: current, key: null, error: 'слишком много редиректов' }
}

// Resolves every short/legacy link not already in `known` (the snapshot's
// earlier results), a few at a time -- a site has a handful of these, not
// hundreds, and they all hit one Google host.
export async function resolveGbpLinks(urls, { known = new Map(), fetchImpl = fetch, concurrency = 3 } = {}) {
  // The key is re-derived from the stored finalUrl rather than trusted: a
  // snapshot outlives fixes to placeKey, and a stale CID would report the
  // right profile as the wrong one.
  const out = new Map([...known].map(([u, r]) => [u, r.finalUrl
    ? { ...r, key: placeKey(r.finalUrl), name: placeName(r.finalUrl) }
    : r]))
  const todo = [...new Set(urls)].filter(u => !out.has(u))
  let i = 0
  const worker = async () => {
    while (i < todo.length) {
      const u = todo[i++]
      out.set(u, await resolveOne(u, fetchImpl))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  return out
}

// Every link on the site (and in the facts file) that needs resolving.
export function gbpTargets(pages, facts) {
  const t = new Set()
  for (const p of pages) {
    for (const l of p.links || []) {
      const kind = l.href && classifyGoogleLink(l.raw)
      if (kind === 'short' || kind === 'legacy') t.add(l.href)
    }
  }
  for (const g of facts?.gbp || []) {
    const kind = classifyGoogleLink(g.url)
    if (kind === 'short' || kind === 'legacy') t.add(g.url)
  }
  return [...t]
}

// The CID a link (as written on the page) leads to: inline, or through its
// resolved redirect.
export function linkKey(raw, href, resolved) {
  return placeKey(raw) || resolved?.get(href)?.key || null
}
