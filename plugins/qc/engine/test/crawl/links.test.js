// plugins/qc/engine/test/crawl/links.test.js
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { checkLinks } from '../../src/crawl/links.js'

let server, base
let hits

before(async () => {
  server = createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1
    if (req.url === '/ok') { res.writeHead(200); return res.end('ok') }
    if (req.url === '/missing') { res.writeHead(404); return res.end('nope') }
    if (req.url === '/shared') { res.writeHead(200); return res.end('shared') }
    if (req.url === '/unique1') { res.writeHead(200); return res.end('u1') }
    if (req.url === '/unique2') { res.writeHead(200); return res.end('u2') }
    if (req.url === '/redirect-ok') { res.writeHead(301, { location: '/ok' }); return res.end() }
    if (req.url === '/redirect-404') { res.writeHead(301, { location: '/missing' }); return res.end() }
    res.writeHead(404); res.end('unhandled')
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

beforeEach(() => { hits = {} })

// --- Judgement call 1: no duplicate fetches, and non-fetchable hrefs are skipped ---

test('checkLinks requests each unique URL at most once, across pages, links and favicons', async () => {
  const pages = [
    {
      url: `${base}/page-a`,
      links: [
        { raw: `${base}/shared`, href: `${base}/shared`, internal: true, selector: 'a' },
        { raw: `${base}/unique1`, href: `${base}/unique1`, internal: true, selector: 'a' },
        // Non-fetchable hrefs: the parser already nulled these out. checkLinks
        // must filter on `href` being null rather than re-parsing `raw`.
        { raw: 'mailto:a@ex.com', href: null, internal: false, selector: 'a' },
        { raw: 'tel:+15551234567', href: null, internal: false, selector: 'a' },
        { raw: 'javascript:void(0)', href: null, internal: false, selector: 'a' },
        { raw: '#top', href: null, internal: true, selector: 'a' },
      ],
      favicons: [{ href: `${base}/shared`, rel: 'icon' }], // same URL as a link above
    },
    {
      url: `${base}/page-b`,
      // Same /shared URL linked again from a second page.
      links: [{ raw: `${base}/shared`, href: `${base}/shared`, internal: true, selector: 'a' }],
      favicons: [{ href: `${base}/unique2`, rel: 'apple-touch-icon' }],
    },
  ]

  const result = await checkLinks(pages, { concurrency: 4 })

  assert.equal(result.size, 3, 'expected exactly the three distinct fetchable URLs')
  assert.ok(result.has(`${base}/shared`))
  assert.ok(result.has(`${base}/unique1`))
  assert.ok(result.has(`${base}/unique2`))

  // The real proof: the server itself only ever saw one request per path,
  // even though /shared was referenced three times (two links + one favicon)
  // across two pages.
  assert.equal(hits['/shared'], 1, 'expected /shared to be requested exactly once')
  assert.equal(hits['/unique1'], 1)
  assert.equal(hits['/unique2'], 1)
  assert.equal(hits['/mailto:a@ex.com'], undefined)
})

// --- Judgement call 3: redirect chains ---

test('checkLinks reports a healthy status for a link that redirects to a working page', async () => {
  const pages = [{ url: `${base}/p`, links: [{ href: `${base}/redirect-ok`, internal: true, selector: 'a' }], favicons: [] }]
  const result = await checkLinks(pages, { concurrency: 2 })
  const r = result.get(`${base}/redirect-ok`)
  assert.equal(r.status, 200, 'fetch follows the redirect and reports the final status')
  assert.equal(r.ok, true)
})

test('checkLinks reports a broken status for a link that redirects into a 404', async () => {
  const pages = [{ url: `${base}/p`, links: [{ href: `${base}/redirect-404`, internal: true, selector: 'a' }], favicons: [] }]
  const result = await checkLinks(pages, { concurrency: 2 })
  const r = result.get(`${base}/redirect-404`)
  assert.equal(r.status, 404, 'a redirect into a dead page must not be reported as healthy')
  assert.equal(r.ok, false)
})

// --- Tolerance ---

test('checkLinks tolerates pages with no links or favicons arrays at all', async () => {
  const pages = [{ url: `${base}/p` }, { url: `${base}/q`, links: undefined, favicons: undefined }]
  const result = await checkLinks(pages, {})
  assert.equal(result.size, 0)
})

test('checkLinks returns an empty map for an empty page set', async () => {
  const result = await checkLinks([], {})
  assert.equal(result.size, 0)
})
