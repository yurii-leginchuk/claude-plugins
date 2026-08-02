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
import { captureDefect } from './screenshot.js'
import { defectIdentity } from '../report/json.js'
import {
  appendBrowserResult, latestBrowserResultsByUrl, clearBrowserResults, loadSnapshot,
} from '../crawl/store.js'

export const MAX_CONSECUTIVE_FAILURES = 10

const errorText = (e) => {
  const m = (e && e.message) ? e.message : String(e)
  return m.slice(0, 200)
}

// Region tagging (revised after review -- see below): proveRegions()
// (src/browser/regions.js) proves which Elementor container *ids* are
// shared across the site; regionOf() looks up a finding's already-set
// `containerId` against that proof. This module no longer discovers
// containerId itself.
//
// An earlier version of this file re-derived containerId AFTER the fact, by
// re-querying `document.querySelector(finding.selector)` and walking up
// from whatever that returned. That is unsound: `selector` (built by
// helpers.selector() in _helpers.js) is a short DISPLAY string -- it
// truncates class lists and only climbs one ancestor level -- so two
// elements in different containers routinely produce the identical string
// (e.g. a header nav link and a footer nav link both rendering as
// "div > a.soc"). querySelector() always returns the FIRST match, so a
// finding provoked on the SECOND (or any later) occurrence was silently
// re-attributed to the FIRST occurrence's container -- a footer defect
// filed under "header" with no error, no warning, nothing in the output to
// suggest it happened. Caught by the Task 7 review via exactly that
// collision fixture; pinned by the "collision" test in run.test.js.
//
// Fixed at the source instead: every rule (src/rules/browser/*) now calls
// `ctx.helpers.containerId(el)` -- the SAME climb-to-nearest-`elementor-<id>`
// walk, but run WHILE THE RULE STILL HOLDS THE ACTUAL ELEMENT, not a lossy
// string reconstruction of it -- and sets `containerId` on the finding
// directly, alongside `selector`. This module's only remaining job is the
// lookup: read the containerId each finding already carries and resolve it
// against the proved-shared set.
//
// Adding a helper to _helpers.js does not touch buildBundle()'s
// serialisation contract or the rule files' `check()` bodies' overall
// shape -- Task 1's execution-based contract test (which runs the bundle
// end-to-end) confirms this; it stayed green through this change.

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
async function attemptPage({ newPage, url, widths, timeout, bundle, regions, host, capturedIdentities }) {
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
        // Each finding already carries its own containerId (set by the rule
        // itself, in-page, while it still held the element -- see the
        // module comment above). This is a pure lookup, nothing more.
        for (const f of got) {
          f.region = regionOf(f, regions)

          // Screenshot capture (Task 8): the page is already open at this
          // width, right here, right after this width's rules finished
          // running in their own single page.evaluate() call -- so a crop's
          // highlight can never be visible to a rule still mid-measurement
          // on this page/width; there is no rule left to run before this
          // page moves on to preparePage()'s next full navigation.
          //
          // Cost (judgement call 2): capturing every occurrence of every
          // finding could mean hundreds of near-duplicate screenshots on a
          // real site. `capturedIdentities` is scoped to the WHOLE pass (see
          // runBrowserPass below), so a defect is CAPTURED at most once --
          // the first time its identity is seen, at whichever width and
          // page that happens to be -- never again for the rest of the run.
          // A defect whose `found` text is width-invariant collapses to one
          // shot at its first width; one whose text embeds the viewport
          // (e.g. C2) gets a distinct identity, and so a distinct shot, per
          // width -- that difference is a property of defectIdentity(), not
          // special-cased here. See screenshot.js's shotPath() for the
          // separate, disk-level dedup that makes a RERUN of the same
          // defect reuse the existing file instead of re-capturing it.
          //
          // The gap this leaves (review, task 8): for a width-invariant
          // identity, the crop always comes from whichever width the
          // identity was FIRST seen at -- widths are processed ascending, so
          // usually the smallest one -- even when the defect looks worse at
          // a later width. Silently showing an unlabelled crop would let a
          // reader mistake "the evidence" for "the worst case". `shotWidth`
          // records which width the crop actually came from, right next to
          // `shot`, so a report can say "снимок с 360px" and a reader who
          // knows the defect also occurs at 1440 can go look themselves,
          // rather than trusting an unlabelled image.
          //
          // Backfill (review, task 8): capturing is bounded to once per
          // identity, but every OTHER finding sharing that identity still
          // gets `.shot`/`.shotWidth` copied from the one capture attempt --
          // free, since it is a Map lookup, not a second page interaction.
          // This is what keeps rollUp()'s per-identity `example` (json.js;
          // "the first finding seen for this identity") carrying the crop
          // regardless of which occurrence it happens to land on, without
          // rollUp() having to know anything about screenshots at all -- see
          // the "example carries the crop" tests in run.test.js.
          const identity = defectIdentity(f)
          if (capturedIdentities.has(identity)) {
            const entry = capturedIdentities.get(identity)
            if (entry.shot) {
              f.shot = entry.shot
              f.shotWidth = entry.width
            }
          } else {
            let shot = null
            try {
              shot = await captureDefect(page, f, host)
            } catch {
              // A capture must never fail the page/pass -- see screenshot.js;
              // this catch is belt-and-braces on top of that module's own
              // internal handling.
            }
            capturedIdentities.set(identity, { shot, width })
            if (shot) {
              f.shot = shot
              f.shotWidth = width
            }
          }

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
    // Test-only injection point (same pattern as cli.js's `fetchImpl`): lets
    // a test stand in a fake browser factory to simulate a mid-pass crash
    // and its recovery without needing a REAL Chromium process to die on
    // command. Every normal caller gets the real launchBrowser (imported
    // above) by not passing this at all.
    launchBrowserImpl = launchBrowser,
  } = opts

  if (force) clearBrowserResults(host)
  // "Already done" means "opened and measured", not "has a row". A page that
  // would not open gets a row too -- deliberately, so it shows up in coverage
  // and in failedUrls instead of vanishing -- but the spec calls that
  // "checked UNSUCCESSFULLY" precisely so a plain rerun retries it and
  // --force is not needed. Counting error rows as done made a failed page
  // permanently done: the only way back was --force, which throws away every
  // successful page's results to start over from page one. Worse, the report
  // told the reader the run was resumable, which was true for a
  // never-attempted page and false for a failed one. Rows are read as
  // latest-per-url (see store.js) because a retried page legitimately leaves
  // both its failure and its retry outcome in the append-only log.
  const already = new Set(
    [...latestBrowserResultsByUrl(host).values()].filter(r => !r.error).map(r => r.url)
  )
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
  // `browser`/`newPage` are reassigned (not `const`) -- see the
  // isConnected() recovery check inside the loop below, added after a live
  // run against cleaningny.com (task 11) showed the browser process itself
  // can die partway through a real pass.
  let { browser, newPage } = await launchBrowserImpl({ headed })
  let consecutive = 0
  // Bounds screenshot capture to at most one ATTEMPT per distinct defect for
  // the whole pass, while still letting every later occurrence of the same
  // identity pick up the result for free: identity -> { shot, width }, where
  // `shot` is the file path (or null if that one attempt failed) and `width`
  // is the breakpoint the attempt was made at -- see the capture site in
  // attemptPage() above.
  const capturedIdentities = new Map()

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

      // The whole pass shares ONE Chromium instance across every page (see
      // this module's header comment) for the launch-cost win that gives --
      // but a long enough real run can outlive the process itself. Measured
      // live (task 11, cleaningny.com, 10 pages x 10 widths): the browser
      // died partway through page 8, and every subsequent newPage() call
      // failed with the SAME generic "Target page, context or browser has
      // been closed" error -- indistinguishable at a glance from the page
      // itself being broken. Nothing here used to relaunch a dead browser,
      // so a crash midway through a real 300-page run would have doomed
      // every remaining page -- and, at the time, permanently: an error row
      // counted as done, so the only way back was --force, which discards
      // every already-collected result to start completely over. A failed
      // page is retryable now (see `already` above), but that is a safety
      // net, not a reason to burn a whole pass first. Checking connectivity
      // right before each attempt turns "the browser process crashed once"
      // into "one wasted iteration, then a fresh browser carries the rest of
      // the pass."
      if (!browser.isConnected()) {
        await browser.close().catch(() => {})
        try {
          ;({ browser, newPage } = await launchBrowserImpl({ headed }))
        } catch (e) {
          // The environment cannot launch a browser right now (e.g.
          // genuinely out of memory) -- record THIS page as failed with the
          // relaunch's own error and move on, rather than let the loop spin
          // attempting a relaunch on every remaining page. This still counts
          // toward `consecutive`, so MAX_CONSECUTIVE_FAILURES above bounds
          // how long a truly broken environment is allowed to burn through
          // the remaining page list.
          consecutive++
          summary.pagesFailed++
          const error = errorText(e)
          summary.failedUrls.push({ url, error })
          appendBrowserResult(host, { url, widths, findings: [], error })
          continue
        }
      }

      const pageArgs = { newPage, url, widths, timeout, bundle, regions, host, capturedIdentities }
      let result = await attemptPage(pageArgs)
      if (!result.ok) {
        // Failure policy: 45s per page, one retry. A dead-on-arrival
        // response and a fluke (a slow cold start, a transient DNS hiccup)
        // are indistinguishable without trying again.
        result = await attemptPage(pageArgs)
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
        // skipped. The row is what puts it in `failedUrls` and in the
        // report's coverage header instead of letting it silently vanish;
        // it deliberately does NOT mark the page done, so a plain rerun
        // retries it (see `already` above).
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
