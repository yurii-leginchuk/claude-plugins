// The live counterpart of a dev audit, for K13: the same pages fetched from
// production, plus the live pages the dev site does not serve at all. Only
// built when the run is a dev audit that knows its production host (--prod,
// or a sheet's Dev Link column) -- without that pairing there is nothing to
// compare against.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fetchAll } from './fetch.js'
import { discoverPages } from './discover.js'
import { snapshotDir } from './store.js'
import { parsePage, PARSE_VERSION } from '../parse/page.js'
import { SNAPSHOT_TTL_MS } from '../lib/snapshot-ttl.js'
import { pathKey } from '../lib/url.js'

const MAX_MISSING_CHECKS = 1000

function counterpart(devUrl, prodHost, pairs) {
  for (const [dev, live] of pairs || []) {
    if (pathKey(dev) === pathKey(devUrl)) return live
  }
  const u = new URL(devUrl)
  return `https://${prodHost}${u.pathname}${u.search}`
}

// `wholeSite`: the dev page list came from a sitemap or crawl, so "a live
// page with no dev page" can be checked. From a sheet the list is a chosen
// subset and every other live page would look missing.
export async function buildProdCompare({ pages, prodHost, pairs, wholeSite, concurrency, discover = discoverPages }) {
  const pairList = pages.map(p => ({ dev: p.url, prod: counterpart(p.url, prodHost, pairs) }))
  const fetched = await fetchAll([...new Set(pairList.map(x => x.prod))], { concurrency })
  const prodPages = []
  for (const x of pairList) {
    const res = fetched.get(x.prod)
    x.status = res?.status ?? 0
    if (res?.ok && res.body && !prodPages.some(p => p.url === x.prod)) {
      prodPages.push({ ...parsePage({ url: x.prod, html: res.body, status: res.status, headers: res.headers }), url: x.prod })
    }
  }

  const missing = []
  if (wholeSite && pages.length) {
    const devOrigin = new URL(pages[0].url).origin
    const have = new Set(pages.map(p => pathKey(p.url)))
    for (const x of pairList) have.add(pathKey(x.prod))
    let live = []
    try { live = (await discover(`https://${prodHost}/`)).urls } catch { live = [] }
    const todo = live.filter(u => !have.has(pathKey(u))).slice(0, MAX_MISSING_CHECKS)
    const devUrls = todo.map(u => `${devOrigin}${new URL(u).pathname}`)
    const heads = await fetchAll(devUrls, { concurrency, method: 'HEAD' })
    todo.forEach((u, i) => {
      const r = heads.get(devUrls[i])
      if (r && (r.status === 404 || r.status === 410)) missing.push({ prod: u, dev: devUrls[i], status: r.status })
    })
  }
  return { host: prodHost, wholeSite, pairs: pairList, pages: prodPages, missing }
}

const fileFor = (host) => join(snapshotDir(host), 'prod-compare.json')

export function loadProdCompare(host, prodHost) {
  const f = fileFor(host)
  if (!existsSync(f)) return null
  try {
    const data = JSON.parse(readFileSync(f, 'utf8'))
    if (data.host !== prodHost || data.parseVersion !== PARSE_VERSION || Date.now() - data.savedAt >= SNAPSHOT_TTL_MS) return null
    return data
  } catch { return null }
}

export function saveProdCompare(host, data) {
  mkdirSync(snapshotDir(host), { recursive: true })
  writeFileSync(fileFor(host), JSON.stringify({ ...data, parseVersion: PARSE_VERSION, savedAt: Date.now() }))
}
