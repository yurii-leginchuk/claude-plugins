import { finding } from '../index.js'
import { isThankYouUrl } from '../../lib/kinds.js'
import { stems, SERVICE_ROOTS, LOCATION_ROOTS } from '../../lib/profile.js'

// Taxonomy check 6 (A/H "copied page"): a page duplicated from a sibling and
// half-edited -- /carpet-cleaning/ still headed «Floor Polishing». The URL
// is the part nobody forgets to change, so its slug is the reference:
//
//   slug words sharing no stem with the H1 and none with the title ->
//     heuristic major (a renamed service legitimately keeps an old slug);
//   the same H1 on two pages (not pagination) -> minor, certain.
const ROOTS = new Set([...SERVICE_ROOTS, ...LOCATION_ROOTS, 'blog', 'category', 'tag'])
const PAGED = /\/page\/\d+\/?$/

const h1Of = (p) => (p.headings || []).find(h => h.level === 1)?.text?.trim() || ''

const index = new WeakMap()
function h1Index(site) {
  if (index.has(site)) return index.get(site)
  const m = new Map()
  for (const p of site.pages || []) {
    const h = h1Of(p)
    if (!h || PAGED.test(new URL(p.url).pathname) || isThankYouUrl(p.url)) continue
    if (!m.has(h)) m.set(h, [])
    m.get(h).push(p.url)
  }
  index.set(site, m)
  return m
}

export default {
  id: 'I21',
  title: 'Page is not about what its URL says, or duplicate H1',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    let path
    try { path = new URL(page.url).pathname } catch { return [] }
    const out = []
    const h1 = h1Of(page)
    const segs = path.split('/').filter(Boolean)
    const slug = segs.at(-1) || ''
    const slugStems = stems(ROOTS.has(slug) || /^\d+$/.test(slug) ? '' : slug)
    if (slugStems.size && h1 && !PAGED.test(path)) {
      const shares = (s) => [...stems(s)].some(w => slugStems.has(w))
      // "/faq/" for «Frequently Asked Questions».
      const acronym = (s) => String(s || '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').toLowerCase().includes(slug.toLowerCase())
      if (!shares(h1) && !acronym(h1)) {
        // URL and title agree and the H1 does not: the page was copied and
        // only its SEO fields were redone -- the clearest copy-paste sign.
        // URL disagreeing with both is more often a renamed service.
        const titleAgrees = shares(page.title)
        // A creative H1 ("Fresh Floors") under a matching title is fine; one
        // that is another page's topic is the copy.
        const source = titleAgrees ? (site?.pages || []).find(p => {
          if (p === page) return false
          const s = stems((p.url.split('/').filter(Boolean).at(-1) || '').replace(/^\d+$/, ''))
          return s.size && [...stems(h1)].some(w => s.has(w))
        }) : null
        if (titleAgrees && !source) { /* creative H1, title carries the topic */ } else {
          out.push(finding(this, page, {
            selector: 'h1', severity: source ? 'major' : 'minor', confidence: 'heuristic',
            found: source
              ? `H1 “${h1}” is the topic of another page (${new URL(source.url).pathname}); the page looks copied`
              : `page ${path} has H1 “${h1}”: the URL and the headings are about different things`,
            where: `H1 “${h1}” · title “${page.title || '—'}”`,
            expected: source ? `H1 about the same thing as the title: “${String(page.title).split(/\s[|–—]\s/)[0]}”` : `H1 and title about “${slug.replace(/-/g, ' ')}”, or change the URL`,
          }))
        }
      }
    }
    const same = h1 && !PAGED.test(path) ? (h1Index(site || {}).get(h1) || []) : []
    if (same.length > 1) {
      out.push(finding(this, page, {
        selector: 'h1',
        found: `same H1 “${h1}” on ${same.length} pages`,
        where: same.map(u => new URL(u).pathname).join(', '),
        expected: 'a unique H1 on every page',
      }))
    }
    return out
  },
}
