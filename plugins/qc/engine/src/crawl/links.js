// Resolves the network status of every link and favicon referenced across a
// crawled site, once per unique URL, so rules (E1, I13, ...) can look status
// up from `site.linkStatus` instead of re-fetching anything themselves.
import { fetchAll } from './fetch.js'

export async function checkLinks(pages, opts = {}) {
  const targets = new Set()
  for (const p of pages) {
    // `href` is null for mailto:, tel:, javascript: and fragment-only hrefs
    // (the parser already normalized those away) -- filtering on it, rather
    // than re-parsing `raw`, is what keeps those out of the fetch queue.
    for (const l of p.links || []) if (l.href) targets.add(l.href)
    for (const f of p.favicons || []) if (f.href) targets.add(f.href)
  }
  // `targets` is a Set, and fetchAll itself also de-dupes its input, so every
  // unique URL -- however many pages link to it -- is requested at most once
  // across the whole run regardless of how large the page set is.

  // HEAD first; many WordPress hosts answer 405, so retry those with GET.
  // Some hosts also answer 403 to HEAD (bot-defense rules that only allow
  // GET) or fail outright (status 0, e.g. a host that refuses HEAD at the
  // TCP/TLS level) -- both are retried with GET for the same reason.
  const head = await fetchAll([...targets], { ...opts, method: 'HEAD' })
  const needGet = [...head.entries()]
    .filter(([, r]) => r.status === 405 || r.status === 0 || r.status === 403)
    .map(([u]) => u)
  const get = needGet.length ? await fetchAll(needGet, { ...opts, method: 'GET' }) : new Map()

  const out = new Map()
  for (const [url, r] of head) {
    const best = get.get(url) || r
    out.set(url, { status: best.status, ok: best.ok, error: best.error })
  }
  return out
}
