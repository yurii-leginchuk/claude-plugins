import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'
import { isPost as isPostPage } from '../../lib/kinds.js'

// Taxonomy K14: "the post is not in the listing", "wrong order" -- 18
// defects. The blog page (WordPress body class `blog`) must show the newest
// posts first. Posts are recognised as in lib/kinds.js and dated by
// article:published_time / JSON-LD datePublished.
//
// Checked on the listing page:
//   the newest posts (up to CHECK_NEWEST) must be linked from it -- a post
//     left in draft-then-published, excluded by a category filter, or a
//     listing widget with a stale query;
//   the posts it shows must run newest to oldest (heuristic: sticky posts
//     legitimately break the order).
// A listing that links none of the crawled posts is loaded by JavaScript or
// filtered on purpose, and is left alone.
const CHECK_NEWEST = 3

// A post this rule can date: the shared definition plus a publish date.
const isPost = (p) => isPostPage(p) && Boolean(p.published)
const isListing = (p) => /(^|\s)blog(\s|$)/.test(p.bodyClass || '') && !/\bpaged\b/.test(p.bodyClass || '')
const time = (p) => Date.parse(p.published) || 0

export default {
  id: 'K14',
  title: 'Blog listing: missing posts and order',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    if (!isListing(page) || !site?.pages) return []
    const posts = site.pages.filter(isPost).sort((a, b) => time(b) - time(a))
    if (!posts.length) return []
    const byPath = new Map(posts.map(p => [pathKey(p.url), p]))
    const order = []
    for (const l of page.links || []) {
      if (!l.internal || !l.href || l.region !== 'main') continue
      const p = byPath.get(pathKey(l.href))
      if (p && !order.includes(p)) order.push(p)
    }
    if (!order.length) return []

    const out = []
    for (const p of posts.slice(0, Math.min(CHECK_NEWEST, order.length))) {
      if (order.includes(p)) continue
      out.push(finding(this, page, {
        selector: null,
        found: `recent post is missing from the listing: “${p.title || p.url}” (${p.published.slice(0, 10)})`,
        expected: 'newest posts first in the listing',
      }))
    }
    for (let i = 1; i < order.length; i++) {
      if (time(order[i]) <= time(order[i - 1])) continue
      out.push(finding(this, page, {
        selector: null, severity: 'minor', confidence: 'heuristic',
        found: `posts are not in date order: “${order[i].title}” (${order[i].published.slice(0, 10)}) after “${order[i - 1].title}” (${order[i - 1].published.slice(0, 10)})`,
        expected: 'newest to oldest',
      }))
      break
    }
    return out
  },
}
