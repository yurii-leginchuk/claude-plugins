import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'

// Taxonomy I14 «remove dev across site», the page itself: a working copy of
// a page («/locations/bronx-dev/», «about-copy», «services-old») left
// published. It is usually out of the sitemap and linked from nowhere, so
// the crawl never meets it -- WordPress's own list of published content
// (crawl/wp.js) does. Reported once, on the home page; a link to a copy is
// reported on the page that has it.
const COPY = /(?:^|[-_])(?:dev|test|testing|copy|old|backup|bak|staging|draft|temp|tmp|wip)(?:[-_]\d+)?$|^elementor-\d+$/i
// Archives are named after people and terms («/author/pa-dev/»), not copies.
const ARCHIVE = /^\/(?:author|tag|category)\//
const lastSlug = (url) => {
  try {
    const path = new URL(url).pathname
    return ARCHIVE.test(path) ? '' : path.split('/').filter(Boolean).pop() || ''
  } catch { return '' }
}

export default {
  id: 'I22',
  title: 'Working copies of pages are published',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const out = []
    const severity = site?.env === 'dev' ? 'minor' : 'major'
    const known = new Set((site?.pages || []).map(p => pathKey(p.url)))
    for (const l of page.links || []) {
      if (!l.internal || !l.href || !COPY.test(lastSlug(l.href))) continue
      out.push(finding(this, page, {
        link: l, severity, found: `link to a working copy ${pathKey(l.href)}`,
        expected: 'link to the main page',
      }))
    }
    const home = (site?.pages || []).find(p => pathKey(p.url) === '/') || site?.pages?.[0]
    if (home && home.url === page.url) {
      const copies = [...(site.pages || []).map(p => ({ url: p.url, title: p.title, inSitemap: true })),
        ...(site.wpContent || []).filter(w => !known.has(pathKey(w.url))).map(w => ({ url: w.url, title: w.title, inSitemap: false }))]
      const seen = new Set()
      for (const c of copies) {
        const key = pathKey(c.url)
        if (seen.has(key) || !COPY.test(lastSlug(c.url))) continue
        seen.add(key)
        out.push(finding(this, page, {
          selector: 'body', severity, zone: 'chrome',
          found: `published working copy ${key}${c.title ? ` (“${String(c.title).replace(/<[^>]+>/g, '').slice(0, 60)}”)` : ''}${c.inSitemap ? ', it is in the sitemap' : ', it is not in the sitemap, but it is open and indexable'}`,
          expected: 'unpublish (draft/private) or 301 to the main page',
        }))
      }
    }
    return out
  },
}
