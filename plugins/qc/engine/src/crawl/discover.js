// Page discovery: sitemap-first, same-host crawl as fallback.
//
// robots.txt is read ONLY to find `Sitemap:` directives that point us at the
// site's sitemap(s). It is NEVER used to decide what this tool is allowed to
// fetch. Staging sites in this portfolio routinely ship a robots.txt that
// disallows everything (a leftover "block search engines until launch"
// reflex left in place), and that must not stop discovery. This tool audits
// sites the operator has permission to audit; `Disallow` is a
// search-engine-etiquette signal aimed at crawlers indexing the public web,
// not an access-control mechanism, and it is deliberately not honoured here.
// Do not "fix" this to respect Disallow.

import { fetchOne } from './fetch.js'
import { normalizeUrl, sameHost } from '../lib/url.js'

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1])
const isIndex = (xml) => /<sitemapindex/i.test(xml)
const looksLikeSitemap = (xml) => /<(urlset|sitemapindex)/i.test(xml)

// Extensions the crawl fallback must never follow: media, documents, and
// other non-page assets a WordPress theme routinely links to directly (hero
// images, downloadable brochures, stylesheets, webfonts...). Following them
// would waste a large slice of the maxPages/maxDepth budget fetching a
// multi-megabyte file for zero "page" value. Matched against the URL's
// pathname only (query strings ignored), case-insensitively.
const ASSET_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.pdf', '.zip', '.css',
  '.js', '.xml', '.ico', '.woff', '.woff2', '.mp4', '.mp3',
])

function isAssetUrl(u) {
  let path
  try {
    path = new URL(u).pathname.toLowerCase()
  } catch {
    return false
  }
  const dot = path.lastIndexOf('.')
  return dot !== -1 && ASSET_EXTENSIONS.has(path.slice(dot))
}

// Walks robots.txt -> declared (or default) sitemap candidates -> recursively
// through any sitemap indexes -> leaf urlsets, collecting page URLs.
//
// Returns { urls, status } rather than a bare array so the caller can tell
// *why* it came back empty, instead of an empty sitemap route silently
// looking identical to "no sitemap was ever configured":
//   - 'ok'        urls.length > 0 -- at least one sitemap parsed and yielded
//                 URLs. (discoverPages only reports source: 'sitemap' in
//                 this case.)
//   - 'not_found' every candidate came back a plain 404 -- there genuinely
//                 is no sitemap at any of the URLs we tried.
//   - 'error'     nothing usable was found, but at least one candidate
//                 existed and failed in a way that is NOT "doesn't exist":
//                 a non-404 HTTP failure, a network error (status 0), or a
//                 200 response whose body isn't valid sitemap/index XML.
//                 That last case is what a gzip-compressed .xml.gz body
//                 looks like after fetchOne's text() decoding has already
//                 mangled it (see the module-level gzip note in the task
//                 report) -- it must not be confused with "no sitemap".
async function fromSitemaps(siteUrl, get, maxPages) {
  const robots = await get(new URL('/robots.txt', siteUrl).toString())
  const declared = robots.ok
    ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1])
    : []
  const candidates = declared.length ? declared : [
    new URL('/sitemap_index.xml', siteUrl).toString(),
    new URL('/sitemap.xml', siteUrl).toString(),
  ]

  // Tracks every sitemap/index URL we've already fetched, so an index that
  // references itself (or two indexes that reference each other) can't loop
  // forever: once a URL has been visited, re-queuing it is a no-op.
  const seen = new Set()
  const urls = new Set()
  const queue = [...candidates]
  let sawError = false

  while (queue.length && urls.size < maxPages) {
    const sm = queue.shift()
    if (seen.has(sm)) continue
    seen.add(sm)
    const res = await get(sm)
    if (!res.ok) {
      if (res.status !== 404) sawError = true
      continue
    }
    if (!looksLikeSitemap(res.body)) {
      // A 200 that isn't parseable urlset/sitemapindex XML is a real
      // failure signal, not nothing -- e.g. a raw-binary gzip body. Skip it
      // without crashing, but remember that this candidate existed and was
      // broken rather than simply absent.
      sawError = true
      continue
    }
    if (isIndex(res.body)) {
      queue.push(...locs(res.body))
    } else {
      for (const loc of locs(res.body)) {
        const n = normalizeUrl(loc)
        if (n && sameHost(n, siteUrl)) urls.add(n)
        if (urls.size >= maxPages) break
      }
    }
  }

  const status = urls.size > 0 ? 'ok' : (sawError ? 'error' : 'not_found')
  return { urls: [...urls].slice(0, maxPages), status }
}

async function byCrawling(siteUrl, get, maxPages, maxDepth) {
  const start = normalizeUrl(siteUrl)
  const seen = new Set([start])
  const out = []
  let frontier = [[start, 0]]

  while (frontier.length && out.length < maxPages) {
    const next = []
    for (const [url, depth] of frontier) {
      if (out.length >= maxPages) break
      const res = await get(url)
      if (!res.ok) continue
      out.push(url)
      if (depth >= maxDepth) continue
      for (const m of res.body.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
        const n = normalizeUrl(m[1], url)
        if (!n || seen.has(n) || !sameHost(n, siteUrl) || isAssetUrl(n)) continue
        seen.add(n)
        next.push([n, depth + 1])
      }
    }
    frontier = next
  }
  return out
}

export async function discoverPages(siteUrl, { maxPages = 2000, maxDepth = 3, fetchImpl } = {}) {
  const get = fetchImpl || ((u) => fetchOne(u))
  const fromMap = await fromSitemaps(siteUrl, get, maxPages)
  if (fromMap.urls.length) {
    return { urls: fromMap.urls, source: 'sitemap', sitemapStatus: fromMap.status }
  }
  return {
    urls: await byCrawling(siteUrl, get, maxPages, maxDepth),
    source: 'crawl',
    sitemapStatus: fromMap.status,
  }
}
