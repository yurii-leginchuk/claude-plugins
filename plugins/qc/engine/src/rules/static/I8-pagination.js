import { finding } from '../index.js'

// Pagination expressed as a path segment (/page/2/) vs. as a query parameter
// (?paged=2). Both are recognised as pagination; which one is used is itself
// part of what this rule reports (see the query-parameter clause below).
const PAGED_PATH = /\/page\/(\d+)\/?$/i
const PAGED_QUERY = /[?&]paged?=(\d+)/i

export default {
  id: 'I8',
  title: 'Pagination: indexing and page number',
  severity: 'major',
  engine: 'static',
  // I8 deliberately says NOTHING about canonical. It used to flag
  // `canonical !== page.url` on paginated URLs, which is a strict subset of
  // what I5 flags unconditionally on every page -- so every I8 finding was a
  // second report of an I5 defect under a different rule id, inflating both
  // `counts` and `distinct` in two severity buckets at once. I5 owns
  // canonical; I8 owns what is specific to pagination.
  //
  // A page this rule has nothing to say about emits nothing at all, including
  // page 1 of a series (an ordinary page).
  check(page, _site) {
    const path = PAGED_PATH.exec(page.url)
    const query = PAGED_QUERY.exec(page.url)
    if (!path && !query) return []

    const out = []
    const pageNumber = Number((path || query)[1])

    // Taxonomy I8, "page number missing from the URL": on WordPress the page
    // number belongs in the path (/blog/page/2/). A `?paged=N` query
    // parameter means pretty pagination permalinks are not in effect, which
    // leaves the same listing reachable under two URL shapes. Directly
    // observed from the URL, so high confidence -- but a URL-shape issue, not
    // a broken page, so minor.
    if (query && !path) {
      out.push(finding(this, page, {
        severity: 'minor',
        selector: 'url',
        found: `page number in a query parameter: ${page.url}`,
        expected: 'page number as a path segment, e.g. /blog/page/2/',
      }))
    }

    // Taxonomy I8, "pages are not indexed". Page 1 is an ordinary page and
    // is not this rule's business; pages 2+ are the ones whose robots
    // directives decide whether the deeper items in a listing stay reachable.
    if (pageNumber >= 2) {
      const robots = page.robots || {}
      if (robots.index === false) {
        out.push(finding(this, page, {
          selector: 'meta[name=robots]',
          found: `pagination page ${pageNumber} is closed to indexing: ${robots.raw || 'noindex'}`,
          expected: 'index, follow',
        }))
      }
      if (robots.follow === false) {
        // nofollow on a paginated listing cuts the crawl path to everything
        // listed on pages 2+, even when the page itself is indexable.
        out.push(finding(this, page, {
          selector: 'meta[name=robots]',
          found: `pagination page ${pageNumber} is closed to link crawling: ${robots.raw || 'nofollow'}`,
          expected: 'index, follow',
        }))
      }
    }

    return out
  },
}
