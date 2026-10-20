import { finding, whereInText } from '../index.js'
import { phoneKey, textPhones } from '../../lib/phone.js'
import { ignoredByFacts } from '../../lib/facts.js'
import { pathKey, hostOf } from '../../lib/url.js'

// Taxonomy E13: "should be a link but isn't" -- 21 defects. Addresses are
// E9's and emails E6's; this rule covers:
//
//   a phone number shown in the copy with no tel: link around it. Counted
//     per number, so the linked one in the header does not excuse the bare
//     one in the hero. "Fax:" numbers are not meant to be dialled.
//   an author or medical reviewer byline ("Medically reviewed by Dr. Jane
//     Roe") with no link, on a site that has author pages at all.
//   a site path or URL typed into the copy («See our /services/x/ page»):
//     copied from the copy doc where it was a link note. A path to no
//     existing page is worse -- the reader is sent nowhere.
const FAX = /fax\W{0,3}$/i
// Explicit bylines only: a bare "by" ("cleaning by room type") is prose.
const BYLINE = /\b(?:(?:[Mm]edically |[Cc]linically )?[Rr]eviewed by|[Ww]ritten by|Author:)\s+((?:Dr\.\s+)?[A-Z][a-z]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z'-]+){1,2})(?:,\s*[A-Z]{2,6})?/g

const index = new WeakMap()
const hasAuthorPages = (site) => {
  if (!site?.pages) return false
  if (!index.has(site)) {
    index.set(site, site.pages.some(p => (p.links || []).some(l => l.internal && /\/(author|team|staff|our-team)\//.test(l.href || ''))))
  }
  return index.get(site)
}

export default {
  id: 'E13',
  title: 'Должно быть ссылкой, но не ссылка',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    if (ignoredByFacts(site?.facts, page.url)) return []
    return [...phones(this, page), ...bylines(this, page, site), ...paths(this, page, site)]
  },
}

function phones(rule, page) {
  const text = String(page.text || '')
  const shown = new Map()
  for (const p of textPhones(text)) {
    const at = text.indexOf(p.raw)
    if (at >= 0 && FAX.test(text.slice(Math.max(0, at - 8), at).trim())) continue
    if (!shown.has(p.key)) shown.set(p.key, { raw: p.raw, n: 0 })
    shown.get(p.key).n++
  }
  const linked = new Map()
  for (const l of page.links || []) {
    if (l.protocol !== 'tel:') continue
    const key = phoneKey(l.raw)
    const visible = textPhones(l.text || '').filter(p => p.key === key).length
    if (key) linked.set(key, (linked.get(key) || 0) + visible)
  }
  const out = []
  for (const [key, { raw, n }] of shown) {
    const bare = n - (linked.get(key) || 0)
    if (bare <= 0) continue
    out.push(finding(rule, page, {
      selector: 'body',
      found: `телефон ${raw} в тексте без tel:-ссылки`,
      occurrences: `${bare} из ${n}`,
      where: whereInText(page, raw),
      expected: `<a href="tel:+${key}">${raw}</a>`,
    }))
  }
  return out
}

function bylines(rule, page, site) {
  if (!hasAuthorPages(site)) return []
  const linkTexts = (page.links || []).map(l => l.text || '').join(' | ')
  const out = []
  const seen = new Set()
  for (const m of String(page.text || '').matchAll(BYLINE)) {
    const name = m[1].trim()
    if (seen.has(name) || linkTexts.includes(name.replace(/^Dr\.\s+/, ''))) continue
    seen.add(name)
    out.push(finding(rule, page, {
      selector: 'body', severity: 'minor', confidence: 'heuristic',
      found: `автор/рецензент «${name}» без ссылки на страницу автора`,
      where: whereInText(page, name),
      expected: 'имя ссылкой на страницу автора',
    }))
  }
  return out
}

// A path in the copy: starts with «/», 1–4 lowercase segments, ends with «/».
// The site's own absolute URLs count too; other sites' URLs (reference
// lists) are prose.
const PATH = /(?<![\w./:-])\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/){1,4}(?![\w-])/g

function paths(rule, page, site) {
  const text = String(page.text || '')
  const host = hostOf(page.url)
  const linkTexts = (page.links || []).map(l => l.text || '').join(' | ')
  const existing = new Set([...(site?.pages || []).map(p => pathKey(p.url)), ...(site?.wpContent || []).map(w => pathKey(w.url))])
  const own = host ? new RegExp(`https?://(?:www\\.)?${host.replace(/^www\./, '').replace(/\./g, '\\.')}(\\/[^\\s"'<>)]*)`, 'g') : null
  const found = new Map()
  for (const m of text.matchAll(PATH)) found.set(m[0], m[0])
  if (own) for (const m of text.matchAll(own)) found.set(m[0], m[1] || '/')
  const out = []
  for (const [shown, path] of found) {
    if (linkTexts.includes(shown)) continue
    const key = pathKey(`https://x${path}`)
    const exists = existing.has(key)
    out.push(finding(rule, page, {
      selector: 'body', where: whereInText(page, shown),
      found: exists ? `путь ${shown} напечатан текстом, а не ссылкой` : `путь ${shown} напечатан текстом, и такой страницы на сайте нет`,
      expected: exists ? `текст-ссылка на ${path}` : 'ссылка на существующую страницу или убрать отсылку',
    }))
  }
  return out
}
