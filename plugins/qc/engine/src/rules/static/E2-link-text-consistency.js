import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'

// Taxonomy E2: "wrong link", "should be this link" -- 60 defects a year, the
// second-largest code. The engine cannot know where a link *should* go, but
// the site usually can: when "Verify Insurance" opens /verify-insurance/ on
// forty pages and /contact/ on two, the two are very likely the stale ones.
//
// Heuristic by construction (a "Locations" link may rightly differ per
// section), so it never moves the verdict. Generic texts ("Learn more",
// "Read more") legitimately point everywhere and are not compared.
const GENERIC = new Set([
  'learn more', 'read more', 'more', 'click here', 'here', 'view more', 'see more', 'view all',
  'see all', 'details', 'more info', 'more information', 'continue reading', 'read article', 'view',
  'next', 'previous', 'prev', 'back', 'read', 'read post', 'view details', 'find out more',
  'discover more', 'explore', 'learn more about us', 'get started',
])
const MIN_MAJORITY_PAGES = 3

const normText = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const comparable = (t) => t.length >= 3 && t.length <= 60 && !GENERIC.has(t) && !/^\d+$/.test(t)

// Tag and category archives: a post's "Dual Diagnosis" category link and a
// body link to the Dual Diagnosis service page share a text, not a purpose.
const ARCHIVE = /\/(category|tag|author)\//
const targetOf = (l, status) => {
  const t = pathKey(status?.get(l.href)?.finalUrl || l.href)
  return t && !ARCHIVE.test(`${t}/`) ? t : null
}

const index = new WeakMap()

function textIndex(site) {
  if (index.has(site)) return index.get(site)
  const m = new Map()
  for (const p of site.pages || []) {
    for (const l of p.links || []) {
      if (!l.internal || !l.href || l.region === 'breadcrumbs') continue
      const t = normText(l.text)
      if (!comparable(t)) continue
      const target = targetOf(l, site.linkStatus)
      if (!target) continue
      if (!m.has(t)) m.set(t, new Map())
      const byTarget = m.get(t)
      if (!byTarget.has(target)) byTarget.set(target, new Set())
      byTarget.get(target).add(p.url)
    }
  }
  index.set(site, m)
  return m
}

export default {
  id: 'E2',
  title: 'Одинаковый текст ссылки ведёт в разные места',
  severity: 'major',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    if (!site?.pages || site.pages.length < MIN_MAJORITY_PAGES) return []
    const idx = textIndex(site)
    const out = []
    const seen = new Set()
    for (const l of page.links || []) {
      if (!l.internal || !l.href || l.region === 'breadcrumbs') continue
      const t = normText(l.text)
      const byTarget = comparable(t) && idx.get(t)
      if (!byTarget || byTarget.size < 2) continue
      const target = targetOf(l, site.linkStatus)
      const [topTarget, topPages] = [...byTarget].sort((a, b) => b[1].size - a[1].size)[0]
      if (target === topTarget || topPages.size < MIN_MAJORITY_PAGES) continue
      const mine = byTarget.get(target)
      if (!mine || mine.size > Math.max(1, Math.floor(topPages.size * 0.2))) continue
      if (seen.has(`${t}|${target}`)) continue
      seen.add(`${t}|${target}`)
      out.push(finding(this, page, {
        selector: l.selector,
        found: `«${l.text}» ведёт на ${target}, а на ${topPages.size} других стр. — на ${topTarget}`,
        expected: `${topTarget}, если эта ссылка не должна отличаться`,
      }))
    }
    return out
  },
}
