import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../../src/report/html.js'

const f = (o) => ({
  rule: 'C1', title: 'Horizontal document scroll', severity: 'critical', engine: 'browser',
  confidence: 'high', page: 'https://ex.com/a', breakpoint: 360, selector: 'html',
  found: 'document width 3000px at viewport 360px', expected: 'document no wider than the viewport', ...o,
})

const base = {
  host: 'ex.com', env: 'prod', envReason: 'live host', pages: 10,
  diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 0, source: 'sitemap',
}

test('renders the breakpoint of a browser finding', () => {
  const html = renderReport({ ...base, findings: [f()] })
  assert.match(html, /360/)
})

test('states browser coverage in the header', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: { pagesDone: 7, pagesTotal: 10, widths: [360, 768, 1024, 1440] },
  })
  assert.match(html, /7/)
  assert.match(html, /10/)
})

test('warns when the browser pass covered only part of the site', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: { pagesDone: 3, pagesTotal: 10, widths: [360] },
  })
  assert.match(html, /not checked|partial/i)
})

test('embeds a screenshot when the finding carries one', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg=='
  const html = renderReport({ ...base, findings: [f({ shotDataUri: `data:image/png;base64,${png}` })] })
  assert.match(html, /<img[^>]+data:image\/png;base64/)
})

test('makes no external request even with a screenshot', () => {
  const html = renderReport({
    ...base, findings: [f({ shotDataUri: 'data:image/png;base64,AAA' })],
  })
  assert.doesNotMatch(html, /<img[^>]+src="https?:/i)
  assert.doesNotMatch(html, /<script[^>]+src=/i)
})

test('a browser finding with no breakpoint does not print "null"', () => {
  const html = renderReport({ ...base, findings: [f({ breakpoint: null })] })
  assert.doesNotMatch(html, />\s*null\s*</)
})

// ---------------------------------------------------------------------------
// Judgement call: a static-only report (qc browse never ran for this host)
// must say so plainly, not just omit the coverage line -- indistinguishable
// silence would read as "visual checks passed" to anyone skimming the
// header. This is the direct counterpart of the "warns when partial" test
// above: `browserCoverage` absent entirely (not `{pagesDone: 0, ...}`) is
// how cli.js signals "never ran", per its own module comment.
// ---------------------------------------------------------------------------

test('states plainly that the browser pass never ran when browserCoverage is absent', () => {
  const html = renderReport({ ...base, findings: [] })
  assert.match(html, /did not run/i)
})

test('a complete browser pass (pagesDone === pagesTotal) shows no partial warning', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: { pagesDone: 10, pagesTotal: 10, widths: [360] },
  })
  assert.doesNotMatch(html, /partial/i)
})

// ---------------------------------------------------------------------------
// The spec requires the report header to carry the count AND the list of
// pages that would not open, and to list the widths the breakpoint budget
// excluded. Neither reached the report: `browserCoverage` carried only
// {pagesDone, pagesTotal, widths}, so a reader saw "7 of 31" with no way to
// tell a failed page from a not-yet-attempted one, and `dropped` reached
// browse's stdout and the snapshot meta and then stopped.
// ---------------------------------------------------------------------------

test('the header states how many pages would not open, and names them', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: {
      pagesDone: 7, pagesTotal: 10, widths: [360, 1440],
      pagesFailed: 2,
      failedUrls: [
        { url: 'https://ex.com/about', error: 'Timeout 45000ms exceeded' },
        { url: 'https://ex.com/services', error: 'net::ERR_CONNECTION_REFUSED' },
      ],
    },
  })
  assert.match(html, /did not open/i, 'the count of failed pages is stated')
  assert.match(html, /https:\/\/ex\.com\/about/, 'the failed page is named')
  assert.match(html, /https:\/\/ex\.com\/services/)
  assert.match(html, /Timeout 45000ms exceeded/, 'with the reason it failed')
})

test('a pass with no failed pages says nothing about failures', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: { pagesDone: 10, pagesTotal: 10, widths: [360], pagesFailed: 0, failedUrls: [] },
  })
  assert.doesNotMatch(html, /did not open/i)
})

test('the header lists the widths the breakpoint budget excluded', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: {
      pagesDone: 10, pagesTotal: 10,
      widths: [360, 640, 641, 766, 767, 768, 1023, 1024, 1025, 1440],
      droppedWidths: [639, 1199, 1200],
    },
  })
  assert.match(html, /excluded widths/i, 'excluded widths are named as such')
  assert.match(html, /1200/, 'and the actual widths are listed, not just counted')
  assert.match(html, /639/)
})

test('no dropped widths means no note about them', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: { pagesDone: 10, pagesTotal: 10, widths: [360], droppedWidths: [] },
  })
  assert.doesNotMatch(html, /excluded widths/i)
})

test('a failed url and its error are escaped like everything else', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: {
      pagesDone: 1, pagesTotal: 2, widths: [360], pagesFailed: 1,
      failedUrls: [{ url: 'https://ex.com/<script>alert(1)</script>', error: '<img onerror=x>' }],
    },
  })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.doesNotMatch(html, /<img onerror=x>/)
  assert.match(html, /&lt;script&gt;/)
})

// ---------------------------------------------------------------------------
// Judgement call: a defect identity that recurs at more than one breakpoint
// collapses to one row (same identity), but which widths it was actually
// seen at is real diagnostic information -- "looks broken at 360 and 768,
// fine at 1440" tells a developer something a single unlabelled breakpoint
// cannot. Two occurrences of the SAME identity (same rule/selector/found),
// one at 360 and one at 768, plus a control row that occurs only at 1440 --
// the row for the recurring identity must show both widths and must not
// show 1440, which belongs to the other, unrelated defect.
// ---------------------------------------------------------------------------

test('a defect seen at more than one breakpoint lists every width it occurred at, on one row', () => {
  const recurring360 = f({ page: 'https://ex.com/a', breakpoint: 360 })
  const recurring768 = f({ page: 'https://ex.com/b', breakpoint: 768 })
  const other1440 = f({
    page: 'https://ex.com/c', breakpoint: 1440, selector: '.only-at-1440',
    found: 'another, unrelated defect',
  })
  const html = renderReport({ ...base, findings: [recurring360, recurring768, other1440] })

  // Exactly one <details class="rule"> row for C1 (the recurring identity
  // and the unrelated one share the same rule, so this also proves the two
  // findings collapsed into one row rather than rendering two).
  const rows = [...html.matchAll(/<details class="rule">[\s\S]*?<\/details>/g)]
  const c1Row = rows.find(m => m[0].includes('>C1<'))
  assert.ok(c1Row, 'expected a C1 rule row')

  // The recurring identity's own breakpoints line lists both widths it
  // actually occurred at, sorted, aggregated across BOTH its occurrences --
  // not just whichever single finding rollUp happened to keep as `example`.
  assert.match(c1Row[0], /breakpoints: <code>360, 768<\/code>/)
  // The unrelated defect (a different identity, different selector) lists
  // only its own width -- 1440 is never folded into the recurring row.
  assert.match(c1Row[0], /breakpoints: <code>1440<\/code>/)
})

// ---------------------------------------------------------------------------
// Judgement call: the size budget with images. renderReport publishes as a
// sandboxed Artifact where every image must be inlined, and the existing
// byte cap (see PUBLISH_BYTE_LIMIT / the "realistic worst case" test in
// html.test.js) is not a separate allowance for screenshots -- it is the
// SAME budget. When screenshots alone would blow it, critical evidence is
// kept and lower-severity screenshots are dropped -- visibly, never
// silently -- while every defect's own text (found/expected/selector/pages)
// stays intact regardless.
// ---------------------------------------------------------------------------

function buildShotFindings({ count, severity, fillChar, bytesPerShot }) {
  const payload = fillChar.repeat(bytesPerShot)
  return Array.from({ length: count }, (_, i) => f({
    page: `https://big.example.com/${severity}-${i}`,
    selector: `.${severity}-${i}`,
    found: `defect #${i} severity ${severity}`,
    severity,
    shotDataUri: `data:image/png;base64,${payload}#${severity}${i}`,
  }))
}

test('a realistic run (60 distinct defects, each with a screenshot) stays comfortably under the publish budget', () => {
  // ~15KB per cropped-and-highlighted PNG, base64-inflated -- a plausible
  // real crop size (see screenshot.js: a padded element crop, not a
  // full-page shot). 60 distinct defects is the brief's own stated scale.
  const findings = [
    ...buildShotFindings({ count: 15, severity: 'critical', fillChar: 'C', bytesPerShot: 15000 }),
    ...buildShotFindings({ count: 20, severity: 'major', fillChar: 'M', bytesPerShot: 15000 }),
    ...buildShotFindings({ count: 15, severity: 'minor', fillChar: 'N', bytesPerShot: 15000 }),
    ...buildShotFindings({ count: 10, severity: 'note', fillChar: 'O', bytesPerShot: 15000 }),
  ]
  const html = renderReport({ ...base, findings })
  const bytes = Buffer.byteLength(html, 'utf8')
  assert.ok(bytes < 2 * 1024 * 1024, `expected < 2MB at realistic scale, got ${bytes} bytes`)
  // Nothing needed dropping at this scale -- every screenshot present.
  assert.doesNotMatch(html, /size limit/i)
  assert.equal([...html.matchAll(/<img /g)].length, 60)
})

test('when screenshots alone exceed the budget, note screenshots are dropped before critical, when that alone is enough', () => {
  const findings = [
    ...buildShotFindings({ count: 5, severity: 'critical', fillChar: 'C', bytesPerShot: 20000 }),
    ...buildShotFindings({ count: 60, severity: 'note', fillChar: 'O', bytesPerShot: 60000 }),
  ]
  const html = renderReport({ ...base, findings })
  const bytes = Buffer.byteLength(html, 'utf8')

  // The drop must actually have happened (the input is ~3.7MB of raw
  // screenshot payload alone) and must be stated visibly, not silently.
  assert.match(html, /size limit/i)
  assert.ok(bytes < 2.2 * 1024 * 1024, `expected the drop to bring the document back near budget, got ${bytes} bytes`)

  // All 5 critical screenshots survive -- dropping the note tier alone
  // already clears the budget here, so critical (the last resort) is never
  // touched. This is priority ordering, not an absolute "critical is never
  // dropped" rule -- see the next test for the last-resort case.
  for (let i = 0; i < 5; i++) assert.match(html, new RegExp(`#critical${i}"`))
  // At least one note screenshot was dropped (the whole point of the test).
  const noteImgs = [...html.matchAll(/#note\d+"/g)].length
  assert.ok(noteImgs < 60, `expected some note screenshots dropped, saw all ${noteImgs}`)
  // The defect's own text survives even for a dropped screenshot -- only
  // the image itself is suppressed, never the finding it belongs to.
  assert.match(html, /defect #0 severity note/)
  // Clearing the budget via dropping means no "still oversized" note is
  // needed -- that note is reserved for when dropping wasn't enough.
  assert.doesNotMatch(html, /over the recommended publish size limit/i)
})

// ---------------------------------------------------------------------------
// Review fix: an earlier version of this budget exempted `critical`
// screenshots entirely. Real scale broke that -- a struggling multi-hundred
// page site with dozens of distinct CRITICAL visual bugs per rule produced a
// report where every single screenshot was critical, so nothing was ever
// eligible to drop, and a 5.1MB document (2.5x over budget) shipped with
// zero screenshots dropped and no warning anywhere. Critical is now
// droppable too, strictly as a last resort (only reached once note/minor/
// major are exhausted) -- reproduced here with an all-critical findings set
// that has nothing else to fall back on.
// ---------------------------------------------------------------------------

test('drops critical screenshots as a genuine last resort when nothing else is left to drop', () => {
  const findings = buildShotFindings({ count: 50, severity: 'critical', fillChar: 'C', bytesPerShot: 60000 })
  const html = renderReport({ ...base, findings })
  const bytes = Buffer.byteLength(html, 'utf8')

  // ~3MB of all-critical screenshot payload: dropping must have happened
  // (there is nothing else to drop) and the result must fit back under
  // budget.
  assert.ok(bytes <= 2 * 1024 * 1024, `expected dropping critical as a last resort to clear the budget, got ${bytes} bytes`)
  assert.match(html, /size limit/i)
  assert.match(html, /critical/, 'the drop notice should name critical among the tiers it may reach')

  const remainingImgs = [...html.matchAll(/#critical\d+"/g)].length
  assert.ok(remainingImgs < 50, `expected at least one critical screenshot dropped, saw all ${remainingImgs}`)
  // Every defect's text -- even the ones whose screenshot got dropped --
  // stays in the document; only images were sacrificed.
  for (let i = 0; i < 50; i++) assert.match(html, new RegExp(`defect #${i} severity critical`))
})

// ---------------------------------------------------------------------------
// Review fix: the "still over budget" note must render even when NOTHING
// was droppable at all -- e.g. no screenshots in the document whatsoever,
// and the findings' own text is simply too large. The old code only ever
// rendered a size-related note when `suppressedShots.size > 0`, so this
// case shipped an oversized document with total silence about it.
// ---------------------------------------------------------------------------

test('states the document is over budget even when there was nothing to drop (no screenshots at all)', () => {
  const bigText = 'A'.repeat(40000)
  const findings = Array.from({ length: 60 }, (_, i) => f({
    page: `https://big.example.com/${i}`, selector: `.big-${i}`,
    found: `MARKER-${i}-${bigText}`, shotDataUri: undefined,
  }))
  const html = renderReport({ ...base, findings })
  const bytes = Buffer.byteLength(html, 'utf8')
  assert.ok(bytes > 2 * 1024 * 1024, `test setup should exceed the budget from text alone, got ${bytes} bytes`)

  assert.match(html, /over the recommended publish size limit/i)
  // Nothing was suppressed -- there were no screenshots to suppress -- so
  // the "N screenshots hidden" note must NOT also claim a drop happened.
  assert.doesNotMatch(html, /Some screenshots are hidden/i)
  // The content itself is untouched -- every defect's text is still there.
  assert.match(html, /MARKER-0-/)
  assert.match(html, /MARKER-59-/)
})

// ---------------------------------------------------------------------------
// Review fix: `shotDataUri` reaches renderReport straight from caller-
// supplied findings (this test file calls it directly, same as any future
// caller could). A live external URL, though harmless as injection (it's
// escaped), would still be a real external reference in a document whose
// whole premise is "no external requests" once published as a sandboxed
// Artifact. Only a genuine `data:image/...` URI may become an <img src>.
// ---------------------------------------------------------------------------

test('a non-data-uri shotDataUri (an external URL) is never rendered as an <img>', () => {
  const html = renderReport({ ...base, findings: [f({ shotDataUri: 'https://evil.example.com/x.png' })] })
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /src="https:\/\/evil\.example\.com/i)
})

// ---------------------------------------------------------------------------
// Minor, but the payoff of Tasks 6-7's region-proving work: a defect that
// carries a proved-shared `region` (regions.js) must say so in the report,
// making the "fix once" reading explicit rather than leaving the reader to
// infer it from a long page list.
// ---------------------------------------------------------------------------

test('renders the region as an explicit "fix once" note when the finding carries one', () => {
  const html = renderReport({ ...base, findings: [f({ region: 'footer' })] })
  assert.match(html, /region: <code>footer<\/code>/)
  assert.match(html, /fix it once/i)
})

test('a defect with no region renders no region line at all', () => {
  const html = renderReport({ ...base, findings: [f()] })
  assert.doesNotMatch(html, /region:/)
})

// On the only real site this has run against, every region label read
// "region: 3381" rather than "footer" -- the snapshot predated
// `locationsById`, no name was available, and the bare container id flowed
// into the name slot and rendered as though it were one. An unnamed region is
// labelled as the container id it is, and says the name is missing.
test('an unnamed region is labelled as a container id, not passed off as a name', () => {
  const html = renderReport({ ...base, findings: [f({ region: '#3381' })] })
  assert.doesNotMatch(html, /region: <code>#?3381<\/code>/,
    'a bare id must not sit where a name goes')
  assert.match(html, /container/i, 'it is named as a container')
  assert.match(html, /3381/, 'the id itself is still shown')
  assert.match(html, /could not be determined/i, 'and the missing name is stated')
  assert.match(html, /fix it once/i, 'the fix-once reading survives')
})

test('stale browser rows are called out as stale, not as a partial pass to resume', () => {
  const html = renderReport({
    host: 'ex.com', env: 'prod', envReason: 'x', pages: 3, findings: [], diff: { added: [], fixed: [], remaining: [] },
    snapshotAgeDays: 0, source: 'sitemap', sitemapStatus: 'ok',
    browserCoverage: { stalePages: 2, pagesDone: 0, pagesTotal: 3, pagesFailed: 0, failedUrls: [], widths: [], droppedWidths: [] },
  })
  assert.match(html, /The browser pass is out of date for 2 pages:/)
  assert.doesNotMatch(html, /is partial/)
})

test('the visual block shows every page at every width, defects or not, with a lightbox', () => {
  const html = renderReport({
    ...base, findings: [],
    visual: [{ url: 'https://ex.com/clean/', type: 'service', title: 'Clean', shots: [{ width: 360, src: 'visual/a.jpg' }, { width: 1440, src: 'visual/b.jpg', cut: true }] },
      { url: 'https://ex.com/', type: 'home', shots: [{ width: 360, src: 'visual/c.webp' }] }],
  })
  assert.match(html, /<details class="rule vis" id="qc-visual">/, 'the block folds')
  assert.ok(html.indexOf('data-type="home"') < html.indexOf('data-type="service"'), 'groups follow the page-type order')
  assert.match(html, /<b>Services<\/b><span class="cnt">1 pages<\/span>/)
  assert.match(html, /id="qc-page-find"/)
  assert.match(html, /data-find="https:\/\/ex\.com\/clean\/ clean"/)
  assert.match(html, /https:\/\/ex\.com\/clean\//)
  assert.match(html, /data-full="visual\/a\.jpg"/)
  assert.match(html, /<div class="shot-view" tabindex="0" role="region"[^>]*><img loading="lazy" src="visual\/a\.jpg"/, 'a scrollable window, not a cropped thumbnail')
  assert.match(html, /1440 px \(cut\)/)
  assert.match(html, /id="qc-lb"/)
})

test('without page screenshots or a menu check the report says so', () => {
  const html = renderReport({ ...base, findings: [] })
  assert.match(html, /No page screenshots/)
  assert.match(html, /Not checked by hand: Mobile menu, Popups, Forms, FAQ and accordions, Keyboard focus, Contradictions in the text/)
})

test("Claude's menu defects render in the menu block and count toward the verdict", () => {
  const d = {
    rule: 'D2', title: 'Mobile and desktop menus differ', severity: 'major', confidence: 'high', engine: 'claude', check: 'menu',
    page: 'https://ex.com/', breakpoint: 360, selector: null, found: 'no “Blog” item', expected: 'the same set of links',
  }
  const html = renderReport({
    ...base, findings: [d],
    manualChecks: [{ check: 'menu', page: 'https://ex.com/', width: 360, status: 'defect', checked: 'opens, full width', shots: ['visual/menu-0-0.png'] },
      { check: 'menu', page: 'https://ex.com/', width: 768, status: 'ok', checked: 'all fine', shots: [] }],
  })
  assert.doesNotMatch(html, /verdict v-Pass/, 'a menu defect counts')
  assert.match(html, /no “Blog” item/)
  assert.match(html, /data-full="visual\/menu-0-0\.png"/)
  assert.match(html, /<span class="chip ok">ok<\/span>/)
  assert.doesNotMatch(html.split('Claude’s manual checks')[0], /no “Blog” item/, 'not repeated in the static groups')
  assert.match(html, /Not checked by hand: Popups/)
})

test('every page, path and URL the report names is a link', () => {
  const html = renderReport({
    ...base, findings: [{ ...f(), engine: 'static', rule: 'E13', confidence: 'high', severity: 'major', selector: 'body', page: 'https://ex.com/a/',
      found: 'path /services/x/ is typed as text, as on [Brooklyn](https://ex.com/locations/brooklyn/) and https://ex.com/b/.' }],
  })
  assert.match(html, /<a href="https:\/\/ex\.com\/services\/x\/" target="_blank" rel="noopener">\/services\/x\/<\/a>/)
  assert.match(html, /<a href="https:\/\/ex\.com\/locations\/brooklyn\/"[^>]*>Brooklyn<\/a>/)
  assert.match(html, /<a href="https:\/\/ex\.com\/b\/"[^>]*>https:\/\/ex\.com\/b\/<\/a>\./, 'trailing punctuation stays outside the link')
  assert.match(html, /<li><a href="https:\/\/ex\.com\/a\/"/, 'the page list links its pages')
  assert.doesNotMatch(renderReport({ ...base, findings: [{ ...f(), found: '[x](javascript:alert(1))' }] }), /href="javascript/)
})

test('the header names the domain and the date of the QC', () => {
  const html = renderReport({ ...base, findings: [], ranAt: Date.UTC(2026, 9, 20, 12) })
  assert.match(html, /<h1>QC · ex\.com · 20\.10\.2026<\/h1>/)
  assert.match(html, /<title>QC ex\.com 20\.10\.2026<\/title>/)
})
