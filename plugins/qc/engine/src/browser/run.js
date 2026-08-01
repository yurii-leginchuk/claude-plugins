// plugins/qc/engine/src/browser/run.js
//
// The page loop that drives every page of a browser-pass run at every
// breakpoint width: launches one browser, walks the page list, records one
// result row per page (success or failure) via the crawl store, and enforces
// the failure policy the spec calls for -- 45s per page with one retry, and
// an automatic stop after 10 consecutive failures so a dead staging host
// costs at most ten wasted attempts instead of one per remaining page.
//
// Browser reuse (the concern Task 1 left behind: a fresh Chromium per
// fixture cost ~1s, dominated by launch): this module launches exactly one
// Chromium instance for the whole pass and closes it once, in a `finally`
// so a mid-pass throw still cleans it up. Within that one browser, each
// SITE PAGE gets its own fresh `newPage()` (a new BrowserContext + Page),
// not a single page reused across the whole run. That costs a little more
// than reusing one page, but a fresh context per page is what makes the
// "console state must not leak between pages" requirement (see below)
// structurally true rather than dependent on preparePage() correctly
// resetting everything -- there is no shared state to leak in the first
// place. A page IS reused across the several widths of the SAME url (one
// `newPage()` per url, one `preparePage()` call per width), matching how
// launch.js's preparePage() is designed: it resets `window.__qcConsole`
// and re-registers its console/pageerror/request listeners on every call,
// so re-navigating the same page to the same url for a new width is safe.
import { launchBrowser, preparePage, PAGE_TIMEOUT_MS } from './launch.js'
import { buildBundle } from './bundle.js'
import { proveRegions, regionOf } from './regions.js'
import {
  appendBrowserResult, loadBrowserResults, clearBrowserResults, loadSnapshot,
} from '../crawl/store.js'

export const MAX_CONSECUTIVE_FAILURES = 10

const errorText = (e) => {
  const m = (e && e.message) ? e.message : String(e)
  return m.slice(0, 200)
}

// Judgement call (region tagging): proveRegions() (src/browser/regions.js)
// proves which Elementor container *ids* are shared across the site; a
// browser finding carries a CSS-ish `selector` string built by
// helpers.selector() inside the page, not a container id -- there is no DOM
// to walk from one to the other outside a live page. Task 6 left this exact
// boundary as "Task 7's job": walk up from the matched element to the
// nearest ancestor carrying an `elementor-<id>` class and attach it as
// `finding.containerId` before calling regionOf().
//
// That walk happens here, in-page, as a SEPARATE page.evaluate() call after
// a rule bundle has already produced its findings -- not by changing the
// rule contract or buildBundle()'s serialisation. Nothing is spliced into
// the bundle string and no rule file changes, so Task 1's execution-based
// contract test (which runs the bundle and would fail loudly on any rule
// that can't survive serialisation) is untouched and still passes.
//
// This is necessarily a best-effort re-query: helpers.selector() truncates
// class lists and ancestry to keep the string short and readable for a
// report, so it is not guaranteed to be unique. document.querySelector()
// takes the first match, which is the same tolerance the report already
// has elsewhere for `selector` being a display string, not a precise
// locator. A selector that fails to parse or match is left untagged
// (containerId absent) rather than throwing.
async function attachContainerIds(page, findings) {
  if (!findings.length) return findings
  return page.evaluate((items) => {
    function containerIdOf(selector) {
      if (!selector) return null
      let el
      try {
        el = document.querySelector(selector)
      } catch {
        return null
      }
      let cur = el
      while (cur && cur.nodeType === 1) {
        const classes = cur.classList ? Array.from(cur.classList) : []
        for (const c of classes) {
          const m = /^elementor-(\d+)$/.exec(c)
          if (m) return m[1]
        }
        cur = cur.parentElement
      }
      return null
    }
    return items.map((f) => {
      const id = containerIdOf(f.selector)
      return id ? { ...f, containerId: id } : f
    })
  }, findings)
}

// Attempts one full pass over `widths` for a single url on a fresh page.
//
// Judgement call (a page that loads but whose measurement fails at ONE
// width only): the FIRST width is treated as "did the page open at all" --
// if preparePage/evaluate throws there, the whole attempt fails and the
// caller's retry policy applies, because a timeout on the very first
// navigation is indistinguishable from a dead server without trying again
// (the failure mode two of three real staging hosts actually hit). Any
// LATER width that throws -- the page has already proven it opens -- is
// recorded as a per-width failure (`widthsFailed`) and does NOT abort the
// page or count toward the consecutive-failure counter: the page is done,
// just with an honestly incomplete measurement at that one width. This
// keeps "checked unsuccessfully" (a dead page, retried, still empty) and
// "checked but partial" (a live page, one width glitched) as two distinct,
// separately-reported outcomes instead of collapsing a minor gap into a
// full-page failure that would trigger a wasted retry, or hiding it inside
// a silently-incomplete success.
async function attemptPage({ newPage, url, widths, timeout, bundle, regions }) {
  let page
  try {
    page = await newPage()
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }

  const findings = []
  const widthsFailed = []
  try {
    for (let i = 0; i < widths.length; i++) {
      const width = widths[i]
      try {
        await preparePage(page, { width, url, timeout })
        await page.evaluate(bundle)
        const got = await page.evaluate(
          (ctx) => window.__qc.run(ctx), { url, breakpoint: width }
        )
        const tagged = await attachContainerIds(page, got)
        for (const f of tagged) {
          f.region = regionOf(f, regions)
          findings.push(f)
        }
      } catch (e) {
        if (i === 0) return { ok: false, error: errorText(e) }
        widthsFailed.push({ width, error: errorText(e) })
      }
    }
  } finally {
    await page.close().catch(() => {})
  }
  return { ok: true, findings, widthsFailed }
}

export async function runBrowserPass({ host, pages, widths, opts = {} }) {
  const {
    force = false,
    maxPages = Infinity,
    timeout = PAGE_TIMEOUT_MS,
    headed = false,
    onProgress = null,
    extraRules = [],
    // resolveBreakpoints (src/browser/breakpoints.js) is the caller's tool,
    // not this module's: whoever assembles `widths` (a future cli.js wiring
    // task) runs resolveBreakpoints against the site's own CSS first and
    // passes the resulting widths straight in, alongside whatever it
    // dropped for reporting parity. `dropped` is threaded through here only
    // so the Summary always carries the field the interface promises.
    dropped = [],
    // Lets a test (or a future caller that already has a regions Map, e.g.
    // computed once for a whole audit rather than once per browser pass)
    // supply regions directly instead of having this module derive them
    // from a stored snapshot.
    regions: regionsOverride = null,
  } = opts

  if (force) clearBrowserResults(host)
  const already = new Set(loadBrowserResults(host).map(r => r.url))
  const todo = pages.filter(u => !already.has(u)).slice(0, maxPages)

  const summary = {
    pagesTotal: pages.length, pagesDone: 0, pagesFailed: 0, pagesPartial: 0,
    failedUrls: [], partialUrls: [], findings: [], widths, dropped, stoppedEarly: false,
  }
  if (!todo.length) return summary

  // Regions are proved from the host's static-crawl snapshot -- the parsed
  // Elementor container data (elementor.containerIds/locationsById) lives
  // there, not in the browser pass's own url list. A host with no static
  // snapshot yet (e.g. a browser-only run) simply proves no regions; every
  // finding then stays page-scoped, the same safe default proveRegions([])
  // already gives.
  let regions = regionsOverride
  if (!regions) {
    const snap = loadSnapshot(host)
    regions = proveRegions(snap ? snap.pages : [])
  }

  const bundle = await buildBundle({ extraRules })
  const { browser, newPage } = await launchBrowser({ headed })
  let consecutive = 0

  try {
    for (let i = 0; i < todo.length; i++) {
      const url = todo[i]
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        // The server is almost certainly down; continuing costs 45s+ per
        // remaining page for nothing. Stop and say so, rather than let a
        // human discover it 300 timeouts later.
        summary.stoppedEarly = true
        break
      }

      let result = await attemptPage({ newPage, url, widths, timeout, bundle, regions })
      if (!result.ok) {
        // Failure policy: 45s per page, one retry. A dead-on-arrival
        // response and a fluke (a slow cold start, a transient DNS hiccup)
        // are indistinguishable without trying again.
        result = await attemptPage({ newPage, url, widths, timeout, bundle, regions })
      }

      let row
      if (result.ok) {
        consecutive = 0
        summary.pagesDone++
        row = { url, widths, findings: result.findings, error: null, widthsFailed: result.widthsFailed }
        if (result.widthsFailed.length) {
          summary.pagesPartial++
          summary.partialUrls.push({ url, widthsFailed: result.widthsFailed })
        }
      } else {
        // A page that will not open is recorded with its reason and an
        // empty findings list, and counts as checked unsuccessfully -- NOT
        // skipped. It still gets a row, so `already` (above) sees it on the
        // next run and a rerun without --force does not retry it forever,
        // and it shows up in `failedUrls` instead of silently vanishing
        // from coverage.
        consecutive++
        summary.pagesFailed++
        summary.failedUrls.push({ url, error: result.error })
        row = { url, widths, findings: [], error: result.error }
      }

      appendBrowserResult(host, row)
      summary.findings.push(...row.findings)

      // Progress reporting: once per PAGE (not per width -- with up to 10
      // widths that would be an order of magnitude noisier than a human
      // watching a long run needs), after that page's outcome is already
      // final and persisted. Reports enough for a human to tell the run is
      // alive and roughly how far along it is: which url just finished,
      // position within this run's queue, and the running done/failed
      // split -- not just a bare counter, since "alive" and "healthy" are
      // different questions on a run hitting a flaky host.
      if (onProgress) {
        onProgress({
          url, index: i + 1, total: todo.length,
          pagesDone: summary.pagesDone, pagesFailed: summary.pagesFailed,
          stoppedEarly: summary.stoppedEarly,
        })
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }

  return summary
}
