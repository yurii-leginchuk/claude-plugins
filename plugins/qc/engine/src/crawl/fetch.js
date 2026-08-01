// Polite concurrent HTTP fetcher. Every crawl in this engine goes through
// fetchOne/fetchAll so that concurrency, timeouts, retries, and the 429/503
// back-off are enforced in exactly one place.
//
// Politeness contract (see project Global Constraint):
//   - concurrency default 6
//   - timeout 20s per attempt
//   - 2 retries on network error and 5xx
//   - auto-drop to concurrency 2 on any 429 or 503, for the rest of the run

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 qc-engine'

const THROTTLE_CONCURRENCY = 2

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export async function fetchOne(url, { timeout = 20000, retries = 2, method = 'GET' } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(url, {
        method, redirect: 'follow', signal: ac.signal,
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      })
      const retryable = res.status >= 500 || res.status === 429
      if (retryable && attempt < retries) {
        await sleep(400 * (attempt + 1))
        continue
      }
      const headers = Object.fromEntries(res.headers.entries())
      const body = method === 'HEAD' ? '' : await res.text()
      return {
        url, finalUrl: res.url || url, status: res.status, ok: res.ok,
        headers, body, error: null, redirects: (res.url && res.url !== url) ? 1 : 0,
      }
    } catch (e) {
      lastError = e
      if (attempt < retries) await sleep(400 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    url, finalUrl: url, status: 0, ok: false, headers: {}, body: '',
    error: lastError ? lastError.message : 'unknown error', redirects: 0,
  }
}

// Runs `fetchOne` over every unique URL, bounded by a concurrency limit that
// can shrink mid-run.
//
// The brief's reference implementation spawned a fixed pool of
// `Math.min(active, total)` workers up front and then tried to shrink the
// pool by reassigning the `active` variable from inside a worker on a
// 429/503. Because the worker count was already captured into a fixed-length
// array before that assignment could ever run, the reassignment was a no-op:
// concurrency never actually dropped. That silently violated this project's
// crawl-politeness constraint, so it is not reproduced here.
//
// Instead, this is a dynamic-limit semaphore: a single scheduler owns a
// mutable `limit` and an `inFlight` counter, and only starts a new fetch when
// `inFlight < limit`. Every request that finishes re-checks the (possibly
// now-lower) limit before deciding whether to launch another. This means:
//   - requests already in flight when the limit drops are left to finish
//     naturally (nothing is aborted, so nothing is lost or duplicated), and
//   - no *new* request is ever started once the reduced limit is in effect,
//     so observed concurrency genuinely caps at THROTTLE_CONCURRENCY (2).
export async function fetchAll(urls, opts = {}) {
  const { concurrency = 6, onProgress } = opts
  const queue = [...new Set(urls)]
  const out = new Map()
  const total = queue.length

  if (total === 0) return out

  let limit = Math.max(1, concurrency)
  let done = 0
  let inFlight = 0
  let nextIndex = 0

  return new Promise((resolve) => {
    function pump() {
      // Launch as many new requests as the current limit allows.
      while (inFlight < limit && nextIndex < queue.length) {
        const url = queue[nextIndex++]
        inFlight++
        fetchOne(url, opts).then((res) => {
          // Back off site-wide the moment the server complains about load.
          // Never raise the limit back up, and never exceed the configured
          // concurrency even if it was already below the throttle floor.
          if (res.status === 429 || res.status === 503) {
            limit = Math.min(limit, THROTTLE_CONCURRENCY)
          }
          out.set(url, res)
          done++
          inFlight--
          if (onProgress) onProgress(done, total)
          if (done >= total) {
            resolve(out)
          } else {
            pump()
          }
        })
      }
    }

    pump()
  })
}
