import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const ZONE = { header: 'header', nav: 'menu', footer: 'footer', breadcrumbs: 'breadcrumbs', main: 'content' }

// Where a link is on the page, in words a person can search for.
export function describeLink(l) {
  return [
    ZONE[l.region] || null,
    l.section ? `under heading “${l.section}”` : null,
    l.text ? `link text “${l.text.slice(0, 80)}”` : 'link without text (image or icon)',
  ].filter(Boolean).join(' · ')
}

// Where a piece of copy is: the heading above it and the words around it.
// Prefers an occurrence outside the header and footer, since the one in the
// page body is usually the one QA means.
// `avoid`: texts whose occurrences do not count — e.g. the link texts holding
// the same phone number, so "the bare number" points at the bare one and not
// at a "Call: +1 …" button that comes first on the page.
export function whereInText(page, needle, { avoid = [] } = {}) {
  const text = String(page.text || '')
  if (!needle) return null
  const ranges = (list) => list.filter(Boolean).flatMap(t => {
    const out = []
    for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + 1)) out.push([i, i + t.length])
    return out
  })
  const spans = [page.headerText, page.footerText].filter(Boolean)
    .map(t => { const i = text.indexOf(t); return i < 0 ? null : [i, i + t.length] }).filter(Boolean)
  const linked = ranges(avoid)
  const inChrome = (i) => spans.some(([a, b]) => i >= a && i < b)
  const inLinked = (i) => linked.some(([a, b]) => i >= a && i + needle.length <= b)
  let at = -1
  let fallback = -1
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (fallback < 0) fallback = i
    if (inLinked(i)) continue
    if (at < 0) at = i
    if (!inChrome(i)) { at = i; break }
  }
  if (at < 0) at = fallback
  if (at < 0) return null
  let section = null
  let from = 0
  for (const h of page.headings || []) {
    const i = h.text ? text.indexOf(h.text, from) : -1
    if (i < 0 || i > at) continue
    section = h.text
    from = i
  }
  const snippet = `…${text.slice(Math.max(0, at - 60), at + needle.length + 60).trim()}…`
  return [inChrome(at) ? 'header/footer' : 'content', section ? `under heading “${section.slice(0, 80)}”` : null, snippet]
    .filter(Boolean).join(' · ')
}

export function finding(rule, page, props) {
  const { link, ...rest } = props
  return {
    rule: rule.id,
    title: rule.title,
    severity: rule.severity,
    engine: rule.engine,
    confidence: rule.confidence || 'high',
    page: page.url,
    breakpoint: null,
    selector: null,
    found: null,
    expected: null,
    where: null,
    // `locate` tells `qc evidence` how to find the spot on the live page.
    ...(link ? { selector: link.selector, where: describeLink(link), locate: { href: link.raw || null, text: (link.text || '').trim().slice(0, 120) || null } } : {}),
    ...rest,
    // header/nav/footer/breadcrumbs/main/chrome: the report files a defect
    // in site chrome under global errors, fixed once for every page.
    zone: rest.zone ?? (link ? link.region : (String(rest.where || '').startsWith('header/footer') ? 'chrome' : null)),
  }
}

let cache = null

export async function allRules() {
  if (cache) return cache
  const dir = join(here, 'static')
  const files = readdirSync(dir).filter(f => f.endsWith('.js')).sort()
  const mods = await Promise.all(
    files.map(f => import(pathToFileURL(join(dir, f)).href))
  )
  cache = mods.map(m => m.default)
  return cache
}

export async function runStaticRules(pages, site, { only = [], skip = [], rules = null } = {}) {
  const ruleSet = rules !== null ? rules : await allRules()
  const filtered = ruleSet.filter(r =>
    (only.length === 0 || only.includes(r.id)) && !skip.includes(r.id))
  const out = []
  for (const page of pages) {
    for (const rule of filtered) {
      try {
        out.push(...(rule.check(page, site) || []))
      } catch (e) {
        out.push({
          rule: rule.id, title: rule.title, severity: 'note', engine: 'static',
          confidence: 'high', page: page.url, breakpoint: null, selector: null,
          found: `rule crashed: ${e.message}`, expected: null,
        })
      }
    }
  }
  return out
}
