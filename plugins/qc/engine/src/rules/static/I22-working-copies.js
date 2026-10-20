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
  title: 'Опубликованы рабочие копии страниц',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const out = []
    const severity = site?.env === 'dev' ? 'minor' : 'major'
    const known = new Set((site?.pages || []).map(p => pathKey(p.url)))
    for (const l of page.links || []) {
      if (!l.internal || !l.href || !COPY.test(lastSlug(l.href))) continue
      out.push(finding(this, page, {
        link: l, severity, found: `ссылка на рабочую копию ${pathKey(l.href)}`,
        expected: 'ссылка на основную страницу',
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
          found: `опубликована рабочая копия ${key}${c.title ? ` («${String(c.title).replace(/<[^>]+>/g, '').slice(0, 60)}»)` : ''}${c.inSitemap ? ' — она в sitemap' : ', её нет в sitemap, но она открыта и индексируется'}`,
          expected: 'снять с публикации (черновик/приватная) или 301 на основную страницу',
        }))
      }
    }
    return out
  },
}
