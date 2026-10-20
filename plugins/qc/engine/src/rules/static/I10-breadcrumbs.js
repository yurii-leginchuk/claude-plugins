import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'
import { isLandingPath, isThankYouUrl } from '../../lib/kinds.js'

// Taxonomy I9–I11: breadcrumbs missing on some pages, not matching the URL
// ("all program pages should have `programs` in breadcrumbs"), or leading to
// a category instead of the parent page.
//
//   missing: most pages of the site have breadcrumbs and this one does not
//     (heuristic -- a landing page may drop them on purpose);
//   structure: on a nested URL (/programs/detox/), each crumb between Home
//     and the page should be one of its parents (/programs/). A crumb outside
//     that path is the category-instead-of-parent case (heuristic -- some
//     sites build crumbs from categories on purpose).
// Pages cached before `breadcrumbs` existed are skipped.
const MIN_PAGES = 5
const SHARE = 0.6

const index = new WeakMap()
function share(site) {
  if (!index.has(site)) {
    const inner = site.pages.filter(p => pathKey(p.url) !== '/' && 'breadcrumbs' in p)
    const withCrumbs = inner.filter(p => p.breadcrumbs).length
    index.set(site, { total: inner.length, withCrumbs })
  }
  return index.get(site)
}

export default {
  id: 'I10',
  title: 'Breadcrumbs',
  severity: 'minor',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    if (!('breadcrumbs' in page)) return []
    const path = pathKey(page.url)
    if (!path || path === '/') return []
    const out = []

    if (!page.breadcrumbs) {
      const s = site?.pages ? share(site) : { total: 0, withCrumbs: 0 }
      if (s.total >= MIN_PAGES && s.withCrumbs / s.total >= SHARE && !isLandingPath(path) && !isThankYouUrl(page.url)) {
        out.push(finding(this, page, {
          selector: null,
          found: `no breadcrumbs, though ${s.withCrumbs} of ${s.total} pages have them`,
          expected: 'breadcrumbs as on the other pages',
        }))
      }
      return out
    }

    const segments = path.split('?')[0].split('/').filter(Boolean)
    if (segments.length < 2) return out
    const parents = new Set(segments.slice(0, -1).map((_, i) => '/' + segments.slice(0, i + 1).join('/')))
    for (const item of page.breadcrumbs.items) {
      const p = item.href && pathKey(item.href)
      if (!p || p === '/' || p === path || parents.has(p.split('?')[0])) continue
      out.push(finding(this, page, {
        selector: '[class*="breadcrumb"]',
        found: `breadcrumb “${item.text}” points to ${p}, but the page sits in ${[...parents].pop()}/`,
        expected: `parent sections from the URL: ${[...parents].join(' › ')}`,
      }))
    }
    return out
  },
}
