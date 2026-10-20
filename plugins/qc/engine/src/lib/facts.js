import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { phoneKey } from './phone.js'
import { classifyGoogleLink } from './gbp.js'

// A site's reference facts: the phone numbers, emails, rating, GBP profiles
// and retired terms the copy must agree with. H9, H11 and the reference half of E12 can
// only say "this is wrong" against something known to be right, so without
// this file they stay silent rather than guessing.
//
// Lives outside the snapshot cache on purpose: `qc cache clear` deletes a
// host's crawl and run history, and the facts a human wrote down about the
// business must survive that.
export const PAGE_TYPES = new Set(['home', 'service', 'service-hub', 'location', 'location-hub', 'post', 'blog', 'about', 'team', 'contact', 'admissions', 'legal', 'thank-you', 'landing', 'careers', 'other'])

const factsDir = () => process.env.QC_FACTS_DIR || join(homedir(), '.qc-facts')

export const factsPathFor = (host) => join(factsDir(), `${host}.json`)

function fail(path, msg) {
  throw new Error(`facts file ${path}: ${msg}`)
}

function strings(path, value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(path, `field "${field}" must be an array`)
  return value.map((v, i) => {
    if (typeof v !== 'string' || !v.trim()) fail(path, `"${field}"[${i}] must be a non-empty string`)
    return v.trim()
  })
}

export function normalizeFacts(raw, path) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(path, 'expected a JSON object')

  const phones = strings(path, raw.phones, 'phones').map((p) => {
    const key = phoneKey(p)
    if (!key || key.length < 8) fail(path, `does not look like a phone number: "${p}"`)
    return { raw: p, key }
  })

  const emails = strings(path, raw.emails, 'emails').map((e) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(path, `does not look like an email: "${e}"`)
    return e.toLowerCase()
  })

  let rating = null
  if (raw.rating !== undefined && raw.rating !== null) {
    rating = Number(raw.rating)
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) fail(path, `"rating" must be a number from 1 to 5, got: ${raw.rating}`)
  }

  if (raw.banned !== undefined && !Array.isArray(raw.banned)) fail(path, 'field "banned" must be an array')
  const banned = (raw.banned || []).map((b, i) => {
    const term = typeof b === 'string' ? b : b?.term
    if (typeof term !== 'string' || !term.trim()) fail(path, `"banned"[${i}] must be a string or {term, note}`)
    return { term: term.trim(), note: typeof b === 'object' && b.note ? String(b.note) : null }
  })

  const ignore = strings(path, raw.ignore, 'ignore')

  if (raw.gbp !== undefined && !Array.isArray(raw.gbp)) fail(path, 'field "gbp" must be an array')
  const gbp = (raw.gbp || []).map((g, i) => {
    const o = typeof g === 'string' ? { url: g } : g
    if (!o || typeof o.url !== 'string' || !/^https?:\/\//i.test(o.url.trim())) {
      fail(path, `"gbp"[${i}] must be a profile link or {name, url, address, paths}`)
    }
    if (!classifyGoogleLink(o.url.trim())) fail(path, `"gbp"[${i}] does not look like a Google Maps/GBP link: ${o.url}`)
    return {
      name: o.name ? String(o.name) : null,
      url: o.url.trim(),
      address: o.address ? String(o.address).trim() : null,
      paths: strings(path, o.paths, `gbp[${i}].paths`),
    }
  })

  // States the business serves, for H12 ("Connecticut" on a Texas page).
  // The states of the gbp addresses count too; this adds service areas with
  // no office.
  const states = strings(path, raw.states, 'states')

  // The site's services and locations as Claude read them off its pages (PA
  // CMS markdown) and the user confirmed: the reference G13, E16, K16, H12
  // and H16 compare menus, footers and forms against, whatever the URLs.
  const listOf = (field) => {
    if (raw[field] === undefined) return []
    if (!Array.isArray(raw[field])) fail(path, `field "${field}" must be an array`)
    return raw[field].map((v, i) => {
      const o = typeof v === 'string' ? { name: v } : v
      if (!o || typeof o.name !== 'string' || !o.name.trim()) fail(path, `"${field}"[${i}] must be {name, url}`)
      return { name: o.name.trim(), url: typeof o.url === 'string' ? o.url.trim() : null }
    })
  }

  // Claude's classification of every published page ("/drug-rehab/": "service").
  if (raw.pages !== undefined && (typeof raw.pages !== 'object' || Array.isArray(raw.pages))) fail(path, 'field "pages" must be an object {"/path/": "type"}')
  const pages = {}
  for (const [k, t] of Object.entries(raw.pages || {})) {
    if (!PAGE_TYPES.has(t)) fail(path, `pages["${k}"]: type “${t}” is not one of ${[...PAGE_TYPES].join(', ')}`)
    pages[k.replace(/\/+$/, '') || '/'] = t
  }

  return { path, phones, emails, rating, banned, ignore, gbp, states, services: listOf('services'), locations: listOf('locations'), pages }
}

// `explicitPath` comes from --facts and must exist; the per-host default is
// optional and simply means "no facts" when absent. A file that exists but
// does not parse is always an error -- silently auditing without the facts
// the operator wrote would read as "data is consistent" when nothing was
// compared at all.
export function loadFacts(host, explicitPath = null) {
  const path = explicitPath || factsPathFor(host)
  if (!existsSync(path)) {
    if (explicitPath) throw new Error(`facts file not found: ${path}`)
    return null
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(path, `cannot be read as JSON (${e.message})`)
  }
  return normalizeFacts(raw, path)
}

// Paths the operator excluded (a privacy policy legitimately naming an old
// business entity, a press page quoting an old phone). Matched as a path
// prefix, so "/blog/2024/" excludes everything under it.
export function ignoredByFacts(facts, url) {
  if (!facts?.ignore?.length) return false
  let path
  try { path = new URL(url).pathname } catch { return false }
  return facts.ignore.some((p) => path.startsWith(p))
}

// The facts.gbp location whose `paths` hold this page (longest prefix wins:
// /locations/ny/queens/ over /locations/ny/), or null.
export function locationFor(locs, url) {
  let path
  try { path = new URL(url).pathname } catch { return null }
  let best = null
  for (const l of locs) {
    for (const p of l.paths || []) if (path.startsWith(p) && (!best || p.length > best.len)) best = { loc: l, len: p.length }
  }
  return best?.loc || null
}
