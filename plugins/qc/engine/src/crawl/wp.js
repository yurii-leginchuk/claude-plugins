// Every published page and post WordPress itself lists (wp-json/wp/v2), not
// only the sitemap's. A working copy («services/x-dev», «about-copy») is
// usually left out of the sitemap and linked from nowhere, so a crawl never
// sees it -- yet it is public, indexable and found by search. I22 reads this.
//
// A site with the REST API closed (security plugin, non-WordPress) yields
// null, which I22 reads as "not known", never as "nothing published".
import { fetchOne } from './fetch.js'

const PER_PAGE = 100
const MAX_PAGES = 5
// Builder and system types are not pages anyone visits.
const SKIP = /^(attachment|nav_menu_item|wp_|elementor_|jet-|e-floating|ct_template|oxy_)/

export async function listWpContent(origin, { fetchImpl = fetchOne } = {}) {
  const out = []
  let reached = false
  // Custom post types too («locations», «services»): a copy hides there as well.
  let types = ['pages', 'posts']
  try {
    const res = await fetchImpl(`${origin}/?rest_route=/wp/v2/types`, { retries: 1 })
    const all = res && res.ok ? JSON.parse(res.body) : null
    if (all && typeof all === 'object') {
      const custom = Object.entries(all).filter(([slug, t]) => !SKIP.test(slug) && t?.rest_base && t.rest_namespace === 'wp/v2'
        && !/[()?]/.test(t.rest_base)).map(([, t]) => t.rest_base)
      types = [...new Set([...types, ...custom])]
    }
  } catch { /* the defaults */ }
  for (const type of types) {
    for (let n = 1; n <= MAX_PAGES; n++) {
      // ?rest_route= rather than /wp-json/: a trailing-slash redirect on the
      // pretty path drops the query string (cleaningny.com does), silently
      // returning WordPress's default first 10 items.
      const url = `${origin}/?rest_route=/wp/v2/${type}&per_page=${PER_PAGE}&page=${n}&_fields=link,slug,title`
      let res
      try { res = await fetchImpl(url, { retries: 1 }) } catch { break }
      if (!res || !res.ok) break
      let rows
      try { rows = JSON.parse(res.body) } catch { break }
      if (!Array.isArray(rows)) break
      reached = true
      for (const r of rows) {
        if (r && r.link) out.push({ url: r.link, slug: r.slug || '', title: r.title?.rendered || '', type })
      }
      const total = Number(res.headers?.['x-wp-totalpages'] || 1)
      if (rows.length < PER_PAGE || n >= total) break
    }
  }
  return reached ? out : null
}
