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
// Ceiling on the retry backoff so a caller raising `retries` cannot produce
// an unbounded sleep between attempts.
const RETRY_BACKOFF_CAP_MS = 5000

// The engine's standard per-attempt network timeout. Exported so any other
// module that makes its own bare `fetch()` call outside of fetchOne/fetchAll
// (e.g. sheet.js downloading a binary workbook, which cannot go through
// fetchOne because that reads bodies as text) can bind it under the same
// politeness contract instead of inventing a second timeout value.
export const DEFAULT_TIMEOUT_MS = 20000

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const backoff = (attempt) => Math.min(400 * (attempt + 1), RETRY_BACKOFF_CAP_MS)
const isThrottleStatus = (status) => status === 429 || status === 503

// FetchResult additionally carries `throttled: boolean` -- true if *any*
// attempt (not just the final one) observed a 429/503, even if a later
// retry succeeded. fetchAll keys the site-wide back-off on this field
// rather than on the final status: fetchOne's own retry logic can turn a
// 503 into a 200 before fetchAll ever sees the final result, and a
// politeness signal that gets silently retried away is exactly the kind of
// transient overload the back-off exists to catch.
export async function fetchOne(url, { timeout = DEFAULT_TIMEOUT_MS, retries = 2, method = 'GET' } = {}) {
  let lastError = null
  let throttled = false
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(url, {
        method, redirect: 'follow', signal: ac.signal,
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      })
      if (isThrottleStatus(res.status)) throttled = true
      const retryable = res.status >= 500 || res.status === 429
      if (retryable && attempt < retries) {
        // Drain the body before retrying so the stream isn't left half-read.
        if (res.body) { try { await res.body.cancel() } catch { /* ignore */ } }
        await sleep(backoff(attempt))
        continue
      }
      const headers = Object.fromEntries(res.headers.entries())
      const body = method === 'HEAD' ? '' : await res.text()
      return {
        url, finalUrl: res.url || url, status: res.status, ok: res.ok,
        headers, body, error: null, redirects: (res.url && res.url !== url) ? 1 : 0,
        throttled,
      }
    } catch (e) {
      lastError = e
      if (attempt < retries) await sleep(backoff(attempt))
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    url, finalUrl: url, status: 0, ok: false, headers: {}, body: '',
    error: lastError ? lastError.message : 'unknown error', redirects: 0,
    throttled,
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
          // Keyed on `throttled`, not `res.status`: fetchOne may have
          // retried a 429/503 away into a final 200, and that must still
          // count -- a signal that clears on retry is still a signal.
          // Never raise the limit back up, and never exceed the configured
          // concurrency even if it was already below the throttle floor.
          if (res.throttled) {
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
