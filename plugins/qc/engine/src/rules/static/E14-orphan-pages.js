import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'
import { isPost, isThankYouUrl } from '../../lib/kinds.js'

// Taxonomy E14: "no interlinking with the neighbouring pages", an orphan page
// nobody can reach. Visitors and crawlers find a page through links; one that
// only the sitemap knows about was usually forgotten when the menu changed.
//
// Only meaningful when the audited set is the whole site from its sitemap:
// a crawl found every page through a link by definition, and a sheet is a
// chosen subset. Posts and archives are skipped -- they are reached through
// paginated listings (/blog/page/7/) that the sitemap does not list.
const MIN_PAGES = 5
const ARCHIVE = /\/(tag|category|author|page)\//

const index = new WeakMap()

function inbound(site) {
  if (index.has(site)) return index.get(site)
  const m = new Map()
  for (const p of site.pages) {
    const self = pathKey(p.url)
    for (const l of p.links || []) {
      if (!l.internal || !l.href) continue
      const target = pathKey(site.linkStatus?.get(l.href)?.finalUrl || l.href)
      if (!target || target === self) continue
      if (!m.has(target)) m.set(target, new Set())
      m.get(target).add(p.url)
    }
  }
  index.set(site, m)
  return m
}

export default {
  id: 'E14',
  title: 'Orphan page: no internal links point to it',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    if (site?.source !== 'sitemap' || (site.pages || []).length < MIN_PAGES) return []
    const key = pathKey(page.url)
    // A form's confirmation page is reached by submitting, not by a link.
    if (key === '/' || isPost(page) || ARCHIVE.test(key) || isThankYouUrl(page.url) || page.robots?.index === false) return []
    if (inbound(site).get(key)?.size) return []
    return [finding(this, page, {
      selector: null,
      found: `none of the ${site.pages.length - 1} other pages link to ${key}`,
      expected: 'a link from the menu, footer or related pages',
    })]
  },
}
