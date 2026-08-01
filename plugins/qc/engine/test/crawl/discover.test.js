import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { discoverPages, MAX_SITEMAP_DOCS } from '../../src/crawl/discover.js'

const res = (body, status = 200) => ({ status, ok: status < 400, body, headers: {}, error: null, finalUrl: '' })

test('reads a sitemap index and its child sitemaps', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('User-agent: *\nSitemap: https://ex.com/sitemap_index.xml'),
    'https://ex.com/sitemap_index.xml': res(
      `<sitemapindex><sitemap><loc>https://ex.com/page-sitemap.xml</loc></sitemap></sitemapindex>`),
    'https://ex.com/page-sitemap.xml': res(
      `<urlset><url><loc>https://ex.com/a</loc></url><url><loc>https://ex.com/b</loc></url></urlset>`),
  }
  const out = await discoverPages('https://ex.com', {
    fetchImpl: async (u) => routes[u] || res('', 404),
  })
  assert.equal(out.source, 'sitemap')
  assert.deepEqual(out.urls.sort(), ['https://ex.com/a', 'https://ex.com/b'])
})

test('falls back to a same-host crawl when no sitemap exists', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('', 404),
    'https://ex.com/sitemap_index.xml': res('', 404),
    'https://ex.com/sitemap.xml': res('', 404),
    'https://ex.com/': res('<a href="/a">A</a><a href="https://out.com/x">out</a>'),
    'https://ex.com/a': res('<a href="/b">B</a>'),
    'https://ex.com/b': res('<a href="/">home</a>'),
  }
  const out = await discoverPages('https://ex.com/', {
    fetchImpl: async (u) => routes[u] || res('', 404),
  })
  assert.equal(out.source, 'crawl')
  assert.ok(out.urls.includes('https://ex.com/a'))
  assert.ok(out.urls.includes('https://ex.com/b'))
  assert.ok(!out.urls.some(u => u.includes('out.com')))
  // A robots.txt 404 and default candidates all 404ing is "no sitemap
  // exists", not "the sitemap was broken" -- the diagnostic must say so.
  assert.equal(out.sitemapStatus, 'not_found')
})

test('honours maxPages on the sitemap route', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('Sitemap: https://ex.com/s.xml'),
    'https://ex.com/s.xml': res(`<urlset>${Array.from({ length: 50 }, (_, i) => `<url><loc>https://ex.com/p${i}</loc></url>`).join('')}</urlset>`),
  }
  const out = await discoverPages('https://ex.com', { maxPages: 10, fetchImpl: async (u) => routes[u] || res('', 404) })
  assert.equal(out.urls.length, 10)
})

// --- Judgement call 1: sitemap recursion must terminate --------------------
//
// A sitemap index that references itself (directly, or via a cycle) must not
// loop forever. The implementation must dedupe visited sitemap URLs. This
// test also proves the self-reference doesn't prevent a *sibling* child
// sitemap in the same index from being processed correctly -- a naive "bail
// out entirely on any repeat" implementation could hide that bug.
test('a self-referencing sitemap index terminates and still reads its sibling child', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('Sitemap: https://ex.com/sitemap_index.xml'),
    'https://ex.com/sitemap_index.xml': res(
      `<sitemapindex>` +
      `<sitemap><loc>https://ex.com/sitemap_index.xml</loc></sitemap>` + // self-reference
      `<sitemap><loc>https://ex.com/page-sitemap.xml</loc></sitemap>` +
      `</sitemapindex>`),
    'https://ex.com/page-sitemap.xml': res(
      `<urlset><url><loc>https://ex.com/a</loc></url></urlset>`),
  }
  const TIMEOUT_MS = 3000
  const run = discoverPages('https://ex.com', { fetchImpl: async (u) => routes[u] || res('', 404) })
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('discoverPages did not terminate within ' + TIMEOUT_MS + 'ms -- likely an infinite sitemap-index loop')), TIMEOUT_MS))
  const out = await Promise.race([run, timeout])
  assert.equal(out.source, 'sitemap')
  assert.deepEqual(out.urls, ['https://ex.com/a'])
})

// A mutual cycle (A references B, B references A) is the same hazard one
// hop further away and must terminate too.
test('a mutually-referencing pair of sitemap indexes terminates', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('Sitemap: https://ex.com/index-a.xml'),
    'https://ex.com/index-a.xml': res(
      `<sitemapindex><sitemap><loc>https://ex.com/index-b.xml</loc></sitemap></sitemapindex>`),
    'https://ex.com/index-b.xml': res(
      `<sitemapindex>` +
      `<sitemap><loc>https://ex.com/index-a.xml</loc></sitemap>` +
      `<sitemap><loc>https://ex.com/page-sitemap.xml</loc></sitemap>` +
      `</sitemapindex>`),
    'https://ex.com/page-sitemap.xml': res(
      `<urlset><url><loc>https://ex.com/only</loc></url></urlset>`),
  }
  const TIMEOUT_MS = 3000
  const run = discoverPages('https://ex.com', { fetchImpl: async (u) => routes[u] || res('', 404) })
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('discoverPages did not terminate -- mutual sitemap-index cycle')), TIMEOUT_MS))
  const out = await Promise.race([run, timeout])
  assert.equal(out.source, 'sitemap')
  assert.deepEqual(out.urls, ['https://ex.com/only'])
})

// The `seen` set only catches EXACT URL repeats. It does nothing against an
// index chain whose child <loc> is a brand-new, never-before-seen URL every
// hop -- e.g. a generator, or a misconfigured multisite/sitemap plugin
// emitting `?n=1`, `?n=2`, .... Reproduces the reviewer's finding: without an
// independent per-run document cap, this shape fetches forever (and, with a
// real `Set`, eventually throws `RangeError: Set maximum size exceeded`).
// maxPages does not help either, since it only bounds *collected page URLs*
// and a pathological index chain never reaches a leaf <urlset> to collect
// any.
test('a sitemap-index chain with an ever-distinct child URL each hop terminates via the document cap', async () => {
  const childUrl = (n) => `https://ex.com/gen.xml?n=${n}`
  let genFetches = 0
  const fetchImpl = async (u) => {
    if (u === 'https://ex.com/robots.txt') return res(`Sitemap: ${childUrl(0)}`)
    const m = /\?n=(\d+)$/.exec(u)
    if (m) {
      genFetches++
      const n = Number(m[1])
      // Every hop references a URL that has never been seen before -- the
      // seen-set dedupe never fires.
      return res(`<sitemapindex><sitemap><loc>${childUrl(n + 1)}</loc></sitemap></sitemapindex>`)
    }
    return res('', 404) // crawl-fallback probes (homepage, default candidates) all miss
  }

  const TIMEOUT_MS = 5000
  const run = discoverPages('https://ex.com', { fetchImpl })
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`discoverPages did not terminate within ${TIMEOUT_MS}ms -- ` +
      'unbounded sitemap-index chain with ever-distinct child URLs')), TIMEOUT_MS))
  const out = await Promise.race([run, timeout])

  // The chain never reaches a leaf <urlset>, so no page URLs are ever found
  // and discovery correctly falls back to crawling (which also finds
  // nothing here, since no crawl routes are configured).
  assert.equal(out.source, 'crawl')
  assert.deepEqual(out.urls, [])
  // The cap must have actually engaged -- exactly MAX_SITEMAP_DOCS documents
  // fetched, not "eventually gave up after some unbounded number".
  assert.equal(genFetches, MAX_SITEMAP_DOCS, 'must fetch exactly the capped number of sitemap documents, no more')
  // Hitting the cap with zero URLs found is a real failure (data was
  // deliberately abandoned, not "no sitemap"), so it must report 'error'.
  assert.equal(out.sitemapStatus, 'error')
})

// --- Mixed success/failure: sitemapStatus must express partial results ----
test('a sitemap index with one broken child and one working child reports partial success, not ok', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('Sitemap: https://ex.com/sitemap_index.xml'),
    'https://ex.com/sitemap_index.xml': res(
      `<sitemapindex>` +
      `<sitemap><loc>https://ex.com/broken-sitemap.xml</loc></sitemap>` +
      `<sitemap><loc>https://ex.com/page-sitemap.xml</loc></sitemap>` +
      `</sitemapindex>`),
    'https://ex.com/broken-sitemap.xml': res('Internal Server Error', 500),
    'https://ex.com/page-sitemap.xml': res(
      `<urlset><url><loc>https://ex.com/a</loc></url></urlset>`),
  }
  const out = await discoverPages('https://ex.com', {
    fetchImpl: async (u) => routes[u] || res('', 404),
  })
  assert.equal(out.source, 'sitemap')
  // The working sibling's data must still be preserved...
  assert.deepEqual(out.urls, ['https://ex.com/a'])
  // ...but the caller must be told the data may be incomplete, not that
  // everything loaded fine -- that's the whole point of tracking this field.
  assert.equal(out.sitemapStatus, 'partial')
})

// --- Judgement call 2: maxPages must bound the crawl fallback too ----------
test('maxPages bounds the crawl fallback, not only the sitemap route', async () => {
  // No sitemap anywhere -> forces the crawl fallback. Build a page graph
  // with far more reachable pages (25) than maxPages (5), each page linking
  // to the next few so the frontier stays wide.
  const PAGE_COUNT = 25
  const MAX_PAGES = 5
  const routes = {
    'https://ex.com/robots.txt': res('', 404),
    'https://ex.com/sitemap_index.xml': res('', 404),
    'https://ex.com/sitemap.xml': res('', 404),
  }
  for (let i = 0; i < PAGE_COUNT; i++) {
    const links = [i + 1, i + 2, i + 3]
      .filter(n => n < PAGE_COUNT)
      .map(n => `<a href="/p${n}">next</a>`)
      .join('')
    routes[`https://ex.com/p${i}`] = res(links)
  }
  routes['https://ex.com/'] = res('<a href="/p0">start</a>')

  const out = await discoverPages('https://ex.com/', {
    maxPages: MAX_PAGES,
    fetchImpl: async (u) => routes[u] || res('', 404),
  })
  assert.equal(out.source, 'crawl')
  assert.equal(out.urls.length, MAX_PAGES, 'crawl must stop exactly at maxPages, not exceed or fall short')
  assert.ok(out.urls.length <= MAX_PAGES)
})

// --- Judgement call 3: the crawl fallback must not follow asset links ------
test('the crawl fallback skips asset links (images, PDFs, stylesheets, ...) and never fetches them', async () => {
  const calls = []
  const routes = {
    'https://ex.com/robots.txt': res('', 404),
    'https://ex.com/sitemap_index.xml': res('', 404),
    'https://ex.com/sitemap.xml': res('', 404),
    'https://ex.com/': res(
      '<a href="/a">A</a>' +
      '<a href="/brochure.PDF">brochure (uppercase ext)</a>' + // case-insensitive
      '<a href="/hero.jpg">hero</a>' +
      '<a href="/style.css?v=2">stylesheet with query string</a>' +
      '<a href="/app.js">script</a>' +
      '<a href="/font.woff2">font</a>'),
    'https://ex.com/a': res('<p>a page</p>'),
    // Deliberately no route for the asset URLs -- if the crawler ever
    // fetches one, it falls through to the generic 404 stub below, but we
    // also assert directly on `calls` so a bug can't hide behind a lucky 404.
  }
  const out = await discoverPages('https://ex.com/', {
    fetchImpl: async (u) => {
      calls.push(u)
      return routes[u] || res('', 404)
    },
  })
  assert.equal(out.source, 'crawl')
  assert.ok(out.urls.includes('https://ex.com/a'))
  for (const asset of ['brochure.PDF', 'hero.jpg', 'style.css', 'app.js', 'font.woff2']) {
    assert.ok(!out.urls.some(u => u.includes(asset)), `${asset} must not appear in discovered pages`)
    assert.ok(!calls.some(u => u.includes(asset)), `${asset} must never be fetched at all (wastes the crawl budget)`)
  }
})

// maxDepth is the crawl fallback's other independent bound (alongside
// maxPages) and was already implemented correctly, but had no test locking
// it in. A straight chain / -> p1 -> p2 -> p3 -> p4 with maxDepth: 2 must
// visit /, p1, p2 (depths 0, 1, 2) and never even fetch p3 or p4.
test('maxDepth bounds how many hops the crawl fallback follows', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('', 404),
    'https://ex.com/sitemap_index.xml': res('', 404),
    'https://ex.com/sitemap.xml': res('', 404),
    'https://ex.com/': res('<a href="/p1">1</a>'),
    'https://ex.com/p1': res('<a href="/p2">2</a>'),
    'https://ex.com/p2': res('<a href="/p3">3</a>'),
    'https://ex.com/p3': res('<a href="/p4">4</a>'),
    'https://ex.com/p4': res('<a href="/p5">5</a>'),
  }
  const calls = []
  const out = await discoverPages('https://ex.com/', {
    maxDepth: 2,
    fetchImpl: async (u) => {
      calls.push(u)
      return routes[u] || res('', 404)
    },
  })
  assert.equal(out.source, 'crawl')
  assert.deepEqual(out.urls.sort(), ['https://ex.com/', 'https://ex.com/p1', 'https://ex.com/p2'].sort())
  // p3 is beyond maxDepth from the start page, so it must never even be
  // fetched -- not just "excluded from the result".
  assert.ok(!calls.includes('https://ex.com/p3'))
  assert.ok(!calls.includes('https://ex.com/p4'))
})

// --- Judgement call 4: gzipped sitemaps must not crash discovery -----------
//
// Decision (see task report): NOT supported end-to-end. fetchOne (Task 9)
// exposes only already-UTF-8-decoded text (`res.text()`), and that decoding
// step is lossy for arbitrary binary -- there is no way to recover the
// original gzip bytes from it. This test proves the *required* fallback
// behaviour instead: a genuinely gzip-compressed body, put through the exact
// decode fetchOne itself performs, must not crash discovery and must not be
// silently misread as a valid (empty) sitemap -- it has to register as a
// real failure so the caller can tell the sitemap was broken, not absent.
test('a real gzip-compressed sitemap body does not crash discovery and is reported as broken, not silently empty', async () => {
  const rawXml = '<urlset><url><loc>https://ex.com/should-not-appear</loc></url></urlset>'
  const gzipped = zlib.gzipSync(Buffer.from(rawXml, 'utf8'))
  // This mirrors exactly what fetchOne does in production: Response.text()
  // decodes the raw bytes with a UTF-8 TextDecoder. For real gzip binary
  // this mangles the payload -- confirm that premise for real before relying
  // on it, rather than assuming it.
  const mangledBody = new TextDecoder('utf-8').decode(gzipped)
  assert.ok(!/<urlset/i.test(mangledBody), 'sanity check: the mangled body must not look like valid sitemap XML')

  const routes = {
    'https://ex.com/robots.txt': res('Sitemap: https://ex.com/sitemap.xml.gz'),
    'https://ex.com/sitemap.xml.gz': res(mangledBody, 200),
    // No other sitemap candidate and no crawl-fallback routes configured on
    // purpose: the homepage 404s too, so the crawl fallback legitimately
    // finds nothing -- the point of this test is solely "does not throw,
    // and correctly reports the sitemap as broken rather than absent".
  }
  const out = await discoverPages('https://ex.com', {
    fetchImpl: async (u) => routes[u] || res('', 404),
  })
  assert.equal(out.source, 'crawl') // sitemap yielded nothing usable, so it fell back
  assert.deepEqual(out.urls, [])
  assert.equal(out.sitemapStatus, 'error', 'a 200 response that is not parseable XML is "broken", not "no sitemap"')
})

// Same failure shape as the gzip test above, but with an ordinary plain-text
// body -- no compression involved at all. This is the more common real-world
// trigger: a WAF interstitial, a login wall, or a misconfigured server
// returning the site's normal HTML error page with an HTTP 200. Locks in
// that the malformed-XML detection is general-purpose, not a gzip-specific
// special case.
test('a plain (non-gzip) malformed sitemap body degrades to the error path, not a silent empty result', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('Sitemap: https://ex.com/sitemap.xml'),
    'https://ex.com/sitemap.xml': res('<html><body>Access Denied</body></html>', 200),
    'https://ex.com/': res(''), // crawl fallback legitimately finds nothing else either
  }
  const out = await discoverPages('https://ex.com', {
    fetchImpl: async (u) => routes[u] || res('', 404),
  })
  assert.equal(out.source, 'crawl')
  assert.deepEqual(out.urls, ['https://ex.com/'])
  assert.equal(out.sitemapStatus, 'error')
})
