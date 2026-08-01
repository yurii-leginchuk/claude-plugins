import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBrowserPass } from '../../src/browser/run.js'
import { saveSnapshot, loadBrowserResults } from '../../src/crawl/store.js'
import { serveContent } from './harness.js'

let server, base, cache
const OK = `<!doctype html><html><head><title>t</title></head><body><main><h1>ok</h1></main></body></html>`
const ERR = `<!doctype html><html><head><title>err</title></head><body><main><h1>err</h1></main>
<script>throw new Error('boom from run.test.js')</script></body></html>`

// Counts hits on /flaky so the SECOND navigation to the same url (the second
// of two widths run against one page) fails while the first succeeds --
// simulating "the page opened fine, but measurement failed at one width
// only" (judgement call 2) without relying on a rule crash, which bundle.js
// already isolates on its own and would never reach attemptPage's catch.
let flakyHits = 0

before(async () => {
  cache = mkdtempSync(join(tmpdir(), 'qc-browse-'))
  process.env.QC_CACHE_DIR = cache
  server = createServer((req, res) => {
    // Strip the query string before matching: the "ten consecutive
    // failures" test below needs 25 DISTINCT dead urls (so `already`-based
    // dedup can't mask the count), which means query strings, which means
    // a literal `req.url === '/dead'` check (as an earlier draft of this
    // suite used) never matches and every "dead" request would actually
    // succeed -- silently defeating the whole test. Matching on the path
    // alone is what a real "the page is unreachable" server would look like
    // to any of these URLs regardless of query.
    const path = req.url.split('?')[0]
    if (path === '/dead') { res.destroy(); return }
    if (path === '/err') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(ERR); return
    }
    if (path === '/flaky') {
      flakyHits++
      if (flakyHits > 1) { res.destroy(); return }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(OK); return
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(OK)
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); rmSync(cache, { recursive: true, force: true }) })

// --- Brief's baseline tests (verbatim intent; server bug fixed above) -----

test('runs every page and records one result per page', async () => {
  const s = await runBrowserPass({
    host: 'run-a', pages: [`${base}/1`, `${base}/2`], widths: [1440],
  })
  assert.equal(s.pagesTotal, 2)
  assert.equal(s.pagesDone, 2)
  assert.equal(s.pagesFailed, 0)
  const rows = loadBrowserResults('run-a')
  assert.equal(rows.length, 2, 'one stored row per page')
  assert.equal(rows[0].error, null)
})

test('a second run does no work and reports it', async () => {
  const s = await runBrowserPass({
    host: 'run-a', pages: [`${base}/1`, `${base}/2`], widths: [1440],
  })
  assert.equal(s.pagesDone, 0, 'already-checked pages must not be redone')
  assert.equal(s.pagesTotal, 2, 'pagesTotal still reflects the full requested list')
})

test('--force redoes everything', async () => {
  const s = await runBrowserPass({
    host: 'run-a', pages: [`${base}/1`], widths: [1440], opts: { force: true },
  })
  assert.equal(s.pagesDone, 1)
})

test('a page that will not load is recorded as failed, not skipped', async () => {
  const s = await runBrowserPass({
    host: 'run-b', pages: [`${base}/dead`, `${base}/1`], widths: [1440],
    opts: { timeout: 4000 },
  })
  assert.equal(s.pagesFailed, 1)
  assert.equal(s.failedUrls.length, 1)
  assert.match(s.failedUrls[0].url, /dead/)
  assert.ok(s.failedUrls[0].error, 'the failure reason is recorded, not just the fact of failure')
  assert.ok(s.pagesDone >= 1, 'the healthy page must still be checked')

  // "Checked unsuccessfully, not skipped": the dead page gets a real row
  // with an empty findings list, so coverage and a future rerun can both
  // see it, instead of it just vanishing from the output.
  const rows = loadBrowserResults('run-b')
  const deadRow = rows.find(r => r.url.includes('dead'))
  assert.ok(deadRow, 'the dead page has a stored row')
  assert.deepEqual(deadRow.findings, [])
  assert.ok(deadRow.error, 'the row records why it failed')
})

const MAX_CONSECUTIVE_FAILURES_HINT = 10

test('stops itself after ten consecutive failures', async () => {
  const dead = Array.from({ length: 25 }, (_, i) => `${base}/dead?i=${i}`)
  const s = await runBrowserPass({
    host: 'run-c', pages: dead, widths: [1440], opts: { timeout: 2000 },
  })
  assert.equal(s.stoppedEarly, true)
  assert.ok(s.pagesFailed <= 12, `expected an early stop, got ${s.pagesFailed} failures`)
  assert.ok(s.pagesFailed >= MAX_CONSECUTIVE_FAILURES_HINT, 'must actually have tried ten pages before stopping')
})

test('an interrupted pass leaves a usable partial result', async () => {
  const s = await runBrowserPass({
    host: 'run-d', pages: [`${base}/1`, `${base}/2`, `${base}/3`], widths: [1440],
    opts: { maxPages: 2 },
  })
  assert.equal(s.pagesDone, 2)
  assert.equal(s.pagesTotal, 3)

  // The interruption must leave usable data on disk, not just a summary
  // object that vanishes when the process exits: a caller re-running the
  // same pass later resumes from here rather than starting over, and can
  // tell page 3 was never attempted at all (absent, not present-but-empty).
  const rows = loadBrowserResults('run-d')
  assert.equal(rows.length, 2)
  const coveredUrls = rows.map(r => r.url)
  assert.ok(!coveredUrls.some(u => u.endsWith('/3')), 'page 3 was never attempted, so it has no row')
})

// --- Judgement call: browser reuse across pages -----------------------------
//
// Not directly observable from the Summary alone, but the whole point of
// reusing one browser is that a multi-page, multi-width run doesn't pay a
// fresh Chromium launch per page. This pins the OBSERVABLE consequence: a
// run over several pages at several widths completes well under what N
// separate cold launches would cost. See the report for the actual
// before/after measurement; this is a smoke-level regression guard, not the
// benchmark itself (CI machines vary too much for a tight bound).
test('a multi-page multi-width run completes without a per-page browser launch', async () => {
  const pages = [`${base}/w1`, `${base}/w2`, `${base}/w3`]
  const widths = [360, 768, 1024, 1440]
  const t0 = Date.now()
  const s = await runBrowserPass({ host: 'run-perf', pages, widths })
  const elapsed = Date.now() - t0
  assert.equal(s.pagesDone, 3)
  // A single Chromium launch is the dominant one-time cost (~1s, per Task
  // 1's measurement); 3 pages x 4 widths of local, instant-responding
  // fixtures should not come anywhere near 3 launches' worth of overhead.
  // Generous bound to stay stable on a loaded CI box.
  assert.ok(elapsed < 20_000, `expected well under 20s for 3 pages x 4 widths, got ${elapsed}ms`)
})

// --- Judgement call: console state must not leak between pages -------------
//
// X1 reads window.__qcConsole, which preparePage() reseeds on every
// navigation. This pins the actual behaviour end to end through
// runBrowserPass, not just preparePage in isolation: a page with a real
// console/script error must show X1 findings on ITS OWN row, and a
// following clean page must show none, even though a shared browser drives
// both (only fresh contexts/pages differ page to page here).
test('a console error on one page does not leak into the next page\'s findings', async () => {
  const s = await runBrowserPass({
    host: 'run-console', pages: [`${base}/err`, `${base}/clean`], widths: [1440],
  })
  assert.equal(s.pagesDone, 2)

  const rows = loadBrowserResults('run-console')
  const errRow = rows.find(r => r.url.endsWith('/err'))
  const cleanRow = rows.find(r => r.url.endsWith('/clean'))

  const errX1 = errRow.findings.filter(f => f.rule === 'X1')
  const cleanX1 = cleanRow.findings.filter(f => f.rule === 'X1')

  assert.ok(errX1.length >= 1, 'the page with the real error reports an X1 finding')
  assert.match(errX1[0].found, /boom from run\.test\.js/)
  assert.equal(cleanX1.length, 0, 'the clean page must not inherit the previous page\'s console errors')
})

// --- Judgement call: a page that opens but fails to measure at one width ---
//
// Decision: such a page counts as DONE (it opened; most of it is real
// data), not failed and not silently perfect. The gap is reported honestly
// via widthsFailed on its row and via pagesPartial/partialUrls on the
// Summary, and it does NOT consume a consecutive-failure slot or trigger a
// retry of the widths that already worked.
test('a page that measures fine at one width and fails at another counts as done, honestly', async () => {
  const s = await runBrowserPass({
    host: 'run-flaky', pages: [`${base}/flaky`], widths: [1440, 1441],
  })
  assert.equal(s.pagesDone, 1, 'the page opened, so it is done, not failed')
  assert.equal(s.pagesFailed, 0)
  assert.equal(s.pagesPartial, 1, 'the gap at one width is surfaced, not hidden')
  assert.equal(s.partialUrls.length, 1)
  assert.equal(s.partialUrls[0].widthsFailed.length, 1)
  assert.equal(s.partialUrls[0].widthsFailed[0].width, 1441)

  const rows = loadBrowserResults('run-flaky')
  assert.equal(rows[0].error, null, 'a partial page is not a page-level error')
  assert.equal(rows[0].widthsFailed.length, 1)
})

// --- Judgement call: progress reporting -------------------------------------
//
// Decision: onProgress fires once per PAGE (not once per width -- that
// would be an order of magnitude noisier on a real run with up to 10
// widths), after that page's row is already persisted, carrying enough for
// a human watching a long run to tell it's alive AND roughly how healthy it
// is: which url just finished, position in the queue, and the running
// done/failed split.
test('onProgress reports once per page with enough to judge liveness and health', async () => {
  const calls = []
  const s = await runBrowserPass({
    host: 'run-progress', pages: [`${base}/p1`, `${base}/p2`, `${base}/p3`], widths: [1440],
    opts: { onProgress: (info) => calls.push(info) },
  })
  assert.equal(calls.length, 3, 'exactly one progress call per page, not per width')
  assert.deepEqual(calls.map(c => c.index), [1, 2, 3])
  assert.ok(calls.every(c => c.total === 3))
  assert.equal(calls[2].pagesDone, s.pagesDone)
  assert.equal(calls[2].pagesFailed, s.pagesFailed)
  assert.ok(calls[0].url.endsWith('/p1'), 'each call names the page it just finished')
})

// --- Judgement call: region tagging ------------------------------------------
//
// Decision (revised after review -- see task-7-report.md's appended fix
// section for the full account): proveRegions() proves shared container ids
// from the site's static-crawl snapshot; a finding gets its containerId set
// BY THE RULE ITSELF, in-page, via `ctx.helpers.containerId(el)`, while the
// rule still holds the real element -- not re-derived afterwards from
// `selector` (a lossy display string). run.js only does the final lookup
// (regionOf). Every extraRules probe below therefore calls
// `ctx.helpers.containerId(el)` itself, mirroring exactly what all nine
// production rules (src/rules/browser/*) now do.
test('a finding inside a proven-shared Elementor container is tagged with its region', async () => {
  const html = `<!doctype html><html><head><title>region</title></head><body>
    <div class="elementor elementor-777 elementor-location-footer">
      <a class="probe" href="#">social</a>
    </div>
  </body></html>`
  const { base: contentBase, close } = await serveContent(html)

  const probeRule = {
    id: 'ZZ_PROBE',
    check: function (ctx) {
      var out = []
      var els = document.querySelectorAll('.probe')
      for (var i = 0; i < els.length; i++) {
        out.push({
          rule: 'ZZ_PROBE', title: 'probe', severity: 'note', confidence: 'high',
          engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
          selector: ctx.helpers.selector(els[i]), containerId: ctx.helpers.containerId(els[i]),
          found: 'probe', expected: null,
        })
      }
      return out
    },
  }

  // proveRegions needs the container seen on >= 2 pages (its own sharing
  // threshold) to count as a region at all -- see regions.js. The host's
  // static snapshot is what supplies that proof; the browser pass itself
  // only visits one live url.
  const elementorPage = (url) => ({
    url,
    elementor: {
      containerIds: ['777'], locations: ['footer'],
      locationsById: { 777: 'footer' }, postCssIds: [], skeleton: '',
    },
  })
  saveSnapshot('run-region', {
    meta: { host: 'run-region' },
    pages: [elementorPage('https://run-region.example/a'), elementorPage('https://run-region.example/b')],
    links: [],
  })

  try {
    const s = await runBrowserPass({
      host: 'run-region', pages: [`${contentBase}/`], widths: [1440],
      opts: { extraRules: [probeRule] },
    })
    assert.equal(s.pagesDone, 1)
    const probe = s.findings.find(f => f.rule === 'ZZ_PROBE')
    assert.ok(probe, 'the injected rule produced a finding')
    assert.equal(probe.containerId, '777', 'the rule found its own enclosing elementor container')
    assert.equal(probe.region, 'footer', 'the container was proven shared, so it resolves to its region name')
  } finally {
    close()
  }
})

test('a finding outside any Elementor container carries no region', async () => {
  const html = `<!doctype html><html><head><title>no-region</title></head><body>
    <a class="probe" href="#">bare</a>
  </body></html>`
  const { base: contentBase, close } = await serveContent(html)
  const probeRule = {
    id: 'ZZ_PROBE2',
    check: function (ctx) {
      var el = document.querySelector('.probe')
      return el ? [{
        rule: 'ZZ_PROBE2', title: 'probe', severity: 'note', confidence: 'high',
        engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
        selector: ctx.helpers.selector(el), containerId: ctx.helpers.containerId(el),
        found: 'probe', expected: null,
      }] : []
    },
  }
  try {
    const s = await runBrowserPass({
      host: 'run-no-region', pages: [`${contentBase}/`], widths: [1440],
      opts: { extraRules: [probeRule] },
    })
    const probe = s.findings.find(f => f.rule === 'ZZ_PROBE2')
    assert.ok(probe)
    assert.equal(probe.containerId, null)
    assert.equal(probe.region, undefined)
  } finally {
    close()
  }
})

// --- Regression: the selector-collision bug the Task 7 review caught -------
//
// helpers.selector()'s parent portion uses only the tag name, never the
// class -- so two structurally-identical elements sitting in DIFFERENT
// Elementor containers (a header link and a footer link both rendering as
// "div > a.probe") produce the IDENTICAL selector string. The fixed
// implementation is immune to this by construction: containerId comes from
// the element the rule actually matched, never from re-querying the DOM
// with that (possibly ambiguous) string. This is pinned directly: two
// `.probe` elements with identical markup, one inside a proven "header"
// container and one inside a proven "footer" container; the finding is
// provoked on the LATER (footer) element, and must be tagged with ITS OWN
// container, not the first DOM match for the shared selector string.
//
// Confirmed this fails against the pre-fix implementation (querySelector
// re-derivation in run.js's old attachContainerIds): querySelector(
// "div > a.probe") always returns the FIRST match (the header instance)
// regardless of which element actually produced the finding, so the old
// code reported containerId: '100' / region: 'header' here -- silently
// mis-attributing a footer defect to the header, with nothing in the
// output to reveal it happened. See task-7-report.md for the exact
// reproduction output.
test('a finding on the SECOND of two selector-identical elements is tagged with its own container, not the first match\'s', async () => {
  const html = `<!doctype html><html><head><title>collision</title></head><body>
    <div class="elementor elementor-100 elementor-location-header">
      <div><a class="probe" href="#">x</a></div>
    </div>
    <div class="elementor elementor-200 elementor-location-footer">
      <div><a class="probe" href="#">x</a></div>
    </div>
  </body></html>`
  const { base: contentBase, close } = await serveContent(html)

  const probeRule = {
    id: 'ZZ_COLLISION',
    check: function (ctx) {
      var els = document.querySelectorAll('.probe')
      var el = els[els.length - 1] // the footer instance -- the finding is provoked HERE
      if (!el) return []
      return [{
        rule: 'ZZ_COLLISION', title: 'collision probe', severity: 'note', confidence: 'high',
        engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
        selector: ctx.helpers.selector(el), containerId: ctx.helpers.containerId(el),
        found: 'probe', expected: null,
      }]
    },
  }

  const elementorPage = (url) => ({
    url,
    elementor: {
      containerIds: ['100', '200'], locations: ['header', 'footer'],
      locationsById: { 100: 'header', 200: 'footer' }, postCssIds: [], skeleton: '',
    },
  })
  saveSnapshot('run-collision', {
    meta: { host: 'run-collision' },
    pages: [elementorPage('https://run-collision.example/a'), elementorPage('https://run-collision.example/b')],
    links: [],
  })

  try {
    const s = await runBrowserPass({
      host: 'run-collision', pages: [`${contentBase}/`], widths: [1440],
      opts: { extraRules: [probeRule] },
    })
    const probe = s.findings.find(f => f.rule === 'ZZ_COLLISION')
    assert.ok(probe, 'the injected rule produced a finding')
    assert.equal(probe.selector, 'div > a.probe', 'sanity check: the collision is real -- both instances share this selector')
    assert.equal(probe.containerId, '200', 'must be tagged with the FOOTER container, where the finding actually occurred')
    assert.equal(probe.region, 'footer', 'must resolve to footer, not header')
  } finally {
    close()
  }
})
