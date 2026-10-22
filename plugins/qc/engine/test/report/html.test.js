import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../../src/report/html.js'
import { SNAPSHOT_TTL_DAYS, STALENESS_WARNING_DAYS } from '../../src/lib/snapshot-ttl.js'

const findings = [
  { rule: 'E4', title: 'tel: format', severity: 'major', engine: 'static', confidence: 'high',
    page: 'https://ex.com/a', selector: 'a.phone', found: 'tel:855-607-8758',
    expected: 'tel:+18556078758', breakpoint: null },
  { rule: 'I1', title: 'H1 count', severity: 'critical', engine: 'static', confidence: 'high',
    page: 'https://ex.com/b', selector: 'body', found: 'H1 not found', expected: 'exactly one H1',
    breakpoint: null },
]

const html = renderReport({
  host: 'ex.com', env: 'dev', envReason: 'host name', pages: 12, findings,
  diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0.2, source: 'sitemap',
})

test('renders a complete document', () => {
  assert.match(html, /<!doctype html>/i)
  assert.match(html, /<\/html>/i)
})

test('shows the verdict', () => {
  assert.match(html, /Fail/)
})

test('groups by rule and shows the count', () => {
  assert.match(html, /E4/)
  assert.match(html, /tel: format/)
  assert.match(html, /tel:\+18556078758/)
})

test('escapes user content', () => {
  const evil = renderReport({
    host: 'ex.com', env: 'dev', envReason: '', pages: 1, snapshotAgeDays: 0, source: 'sitemap',
    findings: [{ rule: 'X', title: 'T', severity: 'minor', engine: 'static', confidence: 'high',
      page: 'https://ex.com/a', selector: 's', found: '<script>alert(1)</script>', expected: '',
      breakpoint: null }],
    diff: { fixed: [], remaining: [], added: [] },
  })
  assert.doesNotMatch(evil, /<script>alert\(1\)<\/script>/)
  assert.match(evil, /&lt;script&gt;/)
})

test('makes no external requests', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i)
  assert.doesNotMatch(html, /<link[^>]+href="https?:/i)
})

test('states the environment', () => {
  assert.match(html, /dev/)
})

// ---------------------------------------------------------------------------
// Judgement call 1: escaping is the security boundary. Every interpolated
// field is attacker-influenced (crawled page content or user-supplied host),
// so every field must be escaped, not just `found`. Test each field alone
// with a distinct payload shape, and confirm the payload cannot break out of
// its surrounding HTML context (style block, attribute, or script).
// ---------------------------------------------------------------------------

const baseFinding = {
  rule: 'X', title: 'T', severity: 'minor', engine: 'static', confidence: 'high',
  page: 'https://ex.com/a', selector: 's', found: 'f', expected: 'e', breakpoint: null,
}

function reportWith(overrides) {
  return renderReport({
    host: 'ex.com', env: 'dev', envReason: '', pages: 1, snapshotAgeDays: 0, source: 'sitemap',
    findings: [{ ...baseFinding, ...overrides }],
    diff: { fixed: [], remaining: [], added: [] },
  })
}

test('escapes a </style> payload in found without closing the style block early', () => {
  const payload = '</style><script>alert("found")</script>'
  const out = reportWith({ found: payload })
  assert.doesNotMatch(out, /<\/style><script>/)
  assert.match(out, /&lt;\/style&gt;&lt;script&gt;/)
})

test('escapes a "><script> payload in expected', () => {
  const payload = '"><script>alert("expected")</script>'
  const out = reportWith({ expected: payload })
  assert.doesNotMatch(out, /"><script>alert\("expected"\)<\/script>/)
  assert.match(out, /&quot;&gt;&lt;script&gt;/)
})

test('escapes a </style> payload in page (rendered in the page index too)', () => {
  const payload = 'https://ex.com/</style><script>alert("page")</script>'
  const out = reportWith({ page: payload })
  assert.doesNotMatch(out, /<\/style><script>alert\("page"\)/)
  assert.match(out, /&lt;\/style&gt;&lt;script&gt;/)
})

test('escapes a "><img onerror payload in selector', () => {
  const payload = '"><img src=x onerror=alert("selector")>'
  const out = reportWith({ selector: payload })
  assert.doesNotMatch(out, /"><img src=x onerror=alert/)
  assert.match(out, /&quot;&gt;&lt;img/)
})

test('escapes a "><script> payload in region', () => {
  const payload = '"><script>alert("region")</script>'
  const out = reportWith({ region: payload })
  assert.doesNotMatch(out, /"><script>alert\("region"\)<\/script>/)
  assert.match(out, /&quot;&gt;&lt;script&gt;/)
})

test('a javascript: URL rendered as text is never emitted as a live href', () => {
  const payload = 'javascript:alert(document.cookie)'
  const out = reportWith({ found: payload })
  assert.doesNotMatch(out, /href="javascript:/i)
  assert.match(out, /javascript:alert\(document\.cookie\)/) // present as inert text
})

test('escapes a script payload in host, including inside <title>', () => {
  const out = renderReport({
    host: '<script>alert("host")</script>', env: 'dev', envReason: '', pages: 1,
    snapshotAgeDays: 0, source: 'sitemap', findings: [], diff: { fixed: [], remaining: [], added: [] },
  })
  assert.doesNotMatch(out, /<script>alert\("host"\)<\/script>/)
  assert.match(out, /&lt;script&gt;alert\(&quot;host&quot;\)&lt;\/script&gt;/)
})

test('escapes an attribute-breakout payload in host inside the title attribute-like context', () => {
  const out = renderReport({
    host: '"><script>alert("host2")</script>', env: 'dev', envReason: '', pages: 1,
    snapshotAgeDays: 0, source: 'sitemap', findings: [], diff: { fixed: [], remaining: [], added: [] },
  })
  assert.doesNotMatch(out, /"><script>alert\("host2"\)<\/script>/)
  assert.match(out, /&quot;&gt;&lt;script&gt;/)
})

// ---------------------------------------------------------------------------
// Judgement call 2: the report must stay usable at real scale. One portfolio
// site has 1500+ pages, and a rule like E4 can legitimately fire on every
// page. Verify a realistic worst case renders to a reasonable byte size, and
// that truncation (page lists capped at 200, page index capped at 500) is
// visible to the reader rather than silent.
// ---------------------------------------------------------------------------

function buildScaleFindings(count, pageCount, ruleCount) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      rule: `R${i % ruleCount}`, title: `Rule ${i % ruleCount}`, severity: 'minor',
      engine: 'static', confidence: 'high', page: `https://big-portfolio.example.com/page-${i % pageCount}`,
      selector: `.item-${i % 7}`, found: `value-${i % 40}`, expected: 'expected value', breakpoint: null,
    })
  }
  return out
}

test('renders a realistic worst case (3000 findings, 1500 pages) to a reasonable byte size', () => {
  const scale = buildScaleFindings(3000, 1500, 30)
  const out = renderReport({
    host: 'big-portfolio.example.com', env: 'prod', envReason: '', pages: 1500, findings: scale,
    diff: { fixed: [], remaining: [], added: scale }, snapshotAgeDays: 1, source: 'sitemap',
  })
  const bytes = Buffer.byteLength(out, 'utf8')
  // Chosen cap: a single self-contained HTML file should stay well under 2 MB
  // so a browser opens it instantly with no perceptible lag.
  assert.ok(bytes < 2 * 1024 * 1024, `expected < 2MB, got ${bytes} bytes`)
})

test('truncates a rule group page list at 200 and says so visibly', () => {
  const findings = []
  for (let i = 0; i < 250; i++) {
    findings.push({
      rule: 'E4', title: 'tel: format', severity: 'major', engine: 'static', confidence: 'high',
      page: `https://ex.com/page-${i}`, selector: 'a.phone', found: 'tel:855-607-8758',
      expected: 'tel:+18556078758', breakpoint: null,
    })
  }
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 250, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 1, source: 'sitemap',
  })
  // Scope the count to the rule group's own <ul class="pages"> list — the
  // same pages also appear (uncapped separately) in the page index table below.
  const listSegment = out.match(/<ul class="pages">([\s\S]*?)<\/ul>/)[1]
  const shown = [...listSegment.matchAll(/<li>/g)]
  assert.ok(shown.length <= 200, `page list should be capped at 200, saw ${shown.length}`)
  assert.match(out, /and 50 more/) // visible truncation notice for the remaining 50 pages
})

// Review follow-up (Important 1): a rule that emits findings at more than
// one severity used to collapse into a single row chipped with the most
// severe of the bunch -- rendered against the real cached cleaningny.com
// run, E3's 44 major + 180 minor findings showed up as one "Major · 224
// findings" row, hiding that the calibration had split them at all. Assert
// the rendered HTML now shows two separate <details class="rule"> rows,
// each with its own correct chip and its own count.
test('a rule that emits two severities renders under both severities, each with its own count', () => {
  const findings = [
    ...Array.from({ length: 3 }, (_, i) => ({
      rule: 'E3', title: 'target=_blank rules', severity: 'major', engine: 'static', confidence: 'high',
      page: `https://ex.com/major-${i}`, selector: 'a.internal', found: 'internal link with target=_blank',
      expected: 'no target', breakpoint: null,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      rule: 'E3', title: 'target=_blank rules', severity: 'minor', engine: 'static', confidence: 'high',
      page: `https://ex.com/minor-${i}`, selector: 'a.social', found: 'external link without rel=noopener',
      expected: 'rel="noopener"', breakpoint: null,
    })),
  ]
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 8, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  const sections = [...out.matchAll(/<section class="sev">[\s\S]*?<\/section>/g)].map(m => m[0])
  const major = sections.find(x => /chip maj">Major/.test(x))
  const minor = sections.find(x => /chip min">Minor/.test(x))
  assert.match(major, /E3 · target=_blank rules<\/b><span class="cnt">1 problem · 3 pages/)
  assert.match(minor, /E3 · target=_blank rules<\/b><span class="cnt">1 problem · 5 pages/)
})

test('a heuristic-only findings list renders Pass but still shows the heuristic section', () => {
  const findings = [
    { rule: 'H1', title: 'Suspicious text', severity: 'critical', engine: 'heuristic',
      confidence: 'heuristic', page: 'https://ex.com/a', selector: 'p', found: 'odd text',
      expected: '', breakpoint: null },
  ]
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 1, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 1, source: 'sitemap',
  })
  // Match the rendered verdict text itself, not the always-present CSS class
  // name "v-Fail" / "v-Pass" that lives in the <style> block regardless of verdict.
  assert.match(out, /class="verdict v-Pass">Pass<\/span>/)
  assert.doesNotMatch(out, /class="verdict v-Fail">Fail<\/span>/)
  assert.match(out, /H1/)
  assert.match(out, /unconfirmed heuristics/i) // copy calling out unconfirmed heuristics
  // The critical severity tile must not count the heuristic finding.
  assert.match(out, /<b>0<\/b>\s*<span>Critical<\/span>/)
})

// ---------------------------------------------------------------------------
// Judgement call 4: empty and degenerate states must render sensibly, not
// crash or produce an empty shell.
// ---------------------------------------------------------------------------

test('zero findings renders a clear "nothing found" report, not an empty shell', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 5, findings: [],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  })
  assert.match(out, /Pass/)
  assert.match(out, /no violations found/i)
  assert.match(out, /<!doctype html>/i)
})

test('a missing diff object renders without throwing and shows zero new/fixed', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 5, findings: [],
    snapshotAgeDays: 1, source: 'sitemap',
    // diff intentionally omitted
  })
  assert.match(out, /<!doctype html>/i)
  assert.match(out, /<b>0<\/b> new/)
  assert.match(out, /<b>0<\/b> fixed/)
})

test('snapshotAgeDays of 0 renders as fresh, not as "0 days" or NaN', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 5, findings: [],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.doesNotMatch(out, /NaN/)
  assert.doesNotMatch(out, /0 days/)
  assert.match(out, /fresh/i)
})

// The staleness banner debt: `loadFreshSnapshot` in cli.js only ever hands
// renderReport a `snapshotAgeDays` strictly LESS than SNAPSHOT_TTL_MS -- a
// snapshot at or past the TTL is refused before it gets this far. A banner
// threshold equal to (or above) the TTL is therefore unreachable no matter
// what number it names; the fix is a threshold strictly below the TTL, and
// this pins that property directly, not just today's chosen value.
test('the staleness warning threshold sits strictly below the reuse TTL (so it is reachable at all)', () => {
  assert.ok(
    STALENESS_WARNING_DAYS < SNAPSHOT_TTL_DAYS,
    `banner threshold (${STALENESS_WARNING_DAYS}d) must be below the reuse TTL (${SNAPSHOT_TTL_DAYS}d) or it can never fire`
  )
})

test('a snapshot near the TTL (but still within it, i.e. still reused) renders the staleness banner', () => {
  // "Near the TTL" -- the exact scenario a reused snapshot can actually be
  // in, since cli.js never reuses one AT or past the TTL. Halfway between
  // the warning threshold and the TTL itself.
  const nearTtlAge = (STALENESS_WARNING_DAYS + SNAPSHOT_TTL_DAYS) / 2
  assert.ok(nearTtlAge < SNAPSHOT_TTL_DAYS, 'sanity: this age must still be inside the reuse window')
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 5, findings: [],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: nearTtlAge, source: 'sitemap',
  })
  assert.match(out, /The snapshot is more than .* days old/, 'a snapshot this old must render the staleness banner')
  assert.match(out, /--fresh/)
})

test('a snapshot well within the warning threshold does NOT render the staleness banner', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 5, findings: [],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  })
  assert.doesNotMatch(out, /The snapshot is more than/)
})

test('env "unknown" renders sensibly', () => {
  const out = renderReport({
    host: 'ex.com', env: 'unknown', envReason: 'could not be determined', pages: 5, findings: [],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  })
  assert.match(out, /unknown/)
  assert.match(out, /could not be determined/)
  assert.doesNotMatch(out, /undefined/)
})

// ---------------------------------------------------------------------------
// Follow-up from review: malformed `findings` must fail loud, not render a
// false "Pass". Coercing bad input to [] would turn a caller bug or a
// corrupted findings.json into a confident, professional "clean site" report
// — indistinguishable from a genuine result. renderReport now throws a
// TypeError before producing any HTML, matching the fail-fast contract
// rollUp/diffRuns already enforce in json.js. No output is ever returned in
// these cases, so a rendered "Pass" verdict is categorically impossible —
// asserted below as well, for belt-and-suspenders coverage.
// ---------------------------------------------------------------------------

function baseReportArgs(findings) {
  return {
    host: 'ex.com', env: 'prod', envReason: '', pages: 1, findings,
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  }
}

test('findings undefined throws instead of silently rendering a false Pass', () => {
  assert.throws(() => renderReport(baseReportArgs(undefined)), TypeError)
})

test('findings null throws instead of silently rendering a false Pass', () => {
  assert.throws(() => renderReport(baseReportArgs(null)), TypeError)
})

test('findings as a string throws instead of silently rendering a false Pass', () => {
  assert.throws(() => renderReport(baseReportArgs('not an array')), TypeError)
})

test('findings as a plain object throws instead of silently rendering a false Pass', () => {
  assert.throws(() => renderReport(baseReportArgs({ rule: 'E4' })), TypeError)
})

test('none of the malformed-findings cases ever produce the word Pass as rendered output', () => {
  for (const bad of [undefined, null, 'not an array', {}, 42]) {
    let out
    try {
      out = renderReport(baseReportArgs(bad))
    } catch {
      out = undefined // expected: renderReport throws and returns nothing
    }
    assert.equal(out, undefined, `renderReport(findings=${String(bad)}) should not return HTML`)
  }
})

// ---------------------------------------------------------------------------
// Follow-up from review: the brief's own verdict test only proves the word
// "Fail" appears somewhere (satisfied trivially by the always-present CSS
// class ".v-Fail{"). Close the gap for Fail and "Needs fixes" the same way
// the Pass case was already scoped — match the rendered verdict element.
// ---------------------------------------------------------------------------

test('renders a precisely-scoped Fail verdict, not just the CSS class name', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 1,
    findings: [{ rule: 'I1', title: 'H1 count', severity: 'critical', engine: 'static',
      confidence: 'high', page: 'https://ex.com/a', selector: 'body', found: 'f', expected: 'e',
      breakpoint: null }],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  })
  assert.match(out, /class="verdict v-Fail">Fail<\/span>/)
  assert.doesNotMatch(out, /class="verdict v-Pass">Pass<\/span>/)
  assert.doesNotMatch(out, /class="verdict v-Needs">Needs fixes<\/span>/)
})

test('renders a precisely-scoped Needs fixes verdict, not just the CSS class name', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 1,
    findings: [{ rule: 'E4', title: 'tel: format', severity: 'major', engine: 'static',
      confidence: 'high', page: 'https://ex.com/a', selector: 'a.phone', found: 'f', expected: 'e',
      breakpoint: null }],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  })
  assert.match(out, /class="verdict v-Needs">Needs fixes<\/span>/)
  assert.doesNotMatch(out, /class="verdict v-Fail">Fail<\/span>/)
  assert.doesNotMatch(out, /class="verdict v-Pass">Pass<\/span>/)
})

// ---------------------------------------------------------------------------
// Review follow-up (Critical 1): renderGroup rendered one found/expected/
// selector per rule+severity group, taken from g.example. Against the real
// cached cleaningny.com run that described 10 of the 25 distinct solid
// defects while the tiles counted all 25 -- the eight distinct E3 majors are
// eight different links, and one of the two Criticals (a malformed
// `janitorial-cleaning/https://…` link) appeared nowhere in the document.
// ---------------------------------------------------------------------------

test('two different found values under one rule+severity both reach the HTML', () => {
  const findings = [
    { rule: 'E1', title: 'Broken links', severity: 'critical', engine: 'static', confidence: 'high',
      page: 'https://ex.com/a', selector: 'a.first', found: 'HTTP 404: https://ex.com/gone',
      expected: 'a working link', breakpoint: null },
    { rule: 'E1', title: 'Broken links', severity: 'critical', engine: 'static', confidence: 'high',
      page: 'https://ex.com/b', selector: 'a.second',
      found: 'broken URL: https://ex.com/janitorial-cleaning/https://ex.com/x',
      expected: 'a valid URL', breakpoint: null },
  ]
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 2, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out.replace(/<[^>]+>/g, ''), /HTTP 404: https:\/\/ex\.com\/gone/)
  assert.match(out, /janitorial-cleaning/)
  assert.match(out, /a\.first/)
  assert.match(out, /a\.second/)
  assert.match(out, /a working link/)
  assert.match(out, /a valid URL/)
})

test('every distinct defect gets its own page list, not one merged list', () => {
  const findings = [
    ...['https://ex.com/1', 'https://ex.com/2'].map(page => ({
      rule: 'E3', title: 'target=_blank', severity: 'major', engine: 'static', confidence: 'high',
      page, selector: 'a.alpha', found: 'internal link with target=_blank: /alpha',
      expected: 'no target', breakpoint: null,
    })),
    { rule: 'E3', title: 'target=_blank', severity: 'major', engine: 'static', confidence: 'high',
      page: 'https://ex.com/3', selector: 'a.beta', found: 'internal link with target=_blank: /beta',
      expected: 'no target', breakpoint: null },
  ]
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 3, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  const group = out.match(/<details class="rule group"[\s\S]*?<\/div><\/details>/)[0]
  const defects = [...group.matchAll(/<article class="defect"[ >]/g)]
  assert.equal(defects.length, 2, 'expected one block per distinct defect')
  const alpha = group.split('<article').find(c => c.includes('a.alpha'))
  assert.match(alpha, /https:\/\/ex\.com\/1/)
  assert.match(alpha, /https:\/\/ex\.com\/2/)
  assert.doesNotMatch(alpha, /https:\/\/ex\.com\/3/, '/3 belongs to the beta defect only')
})

test('the group summary states how many distinct defects it holds', () => {
  const findings = Array.from({ length: 4 }, (_, i) => ({
    rule: 'E4', title: 'tel: format', severity: 'major', engine: 'static', confidence: 'high',
    page: `https://ex.com/p${i}`, selector: 'a.phone', found: `tel:855-607-875${i}`,
    expected: 'tel:+1855607875X', breakpoint: null,
  }))
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 4, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /E4 · tel: format<\/b><span class="cnt">4 problems · 4 pages/)
})

test('a group holding more distinct defects than the cap truncates visibly', () => {
  const findings = Array.from({ length: 130 }, (_, i) => ({
    rule: 'E1', title: 'Broken links', severity: 'critical', engine: 'static', confidence: 'high',
    page: 'https://ex.com/a', selector: `a.n${i}`, found: `HTTP 404: https://ex.com/gone-${i}`,
    expected: 'a working link', breakpoint: null,
  }))
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 1, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /and 30 more defects not shown/)
})

// ---------------------------------------------------------------------------
// Review follow-up (Important 8): the tiles led with raw occurrence counts --
// "Major 56", the exact number the distinct/occurrence split exists to stop
// anyone quoting -- and the word "distinct" (or any Russian equivalent) never
// appeared in the rendered HTML at all, even though cli.js computed it. A run
// built from a partial or broken sitemap looked identical to a clean one, and
// diff.remaining was computed and dropped.
// ---------------------------------------------------------------------------

function repeatedDefectReport(extra = {}) {
  // One template-level defect repeated on 6 pages plus two one-off defects:
  // 3 distinct defects, 8 occurrences.
  const findings = [
    ...Array.from({ length: 6 }, (_, i) => ({
      rule: 'E3', title: 'target=_blank', severity: 'major', engine: 'static', confidence: 'high',
      page: `https://ex.com/p${i}`, selector: 'a.footer', found: 'internal link with target=_blank: /contact',
      expected: 'no target', breakpoint: null,
    })),
    { rule: 'E3', title: 'target=_blank', severity: 'major', engine: 'static', confidence: 'high',
      page: 'https://ex.com/p0', selector: 'a.hero', found: 'internal link with target=_blank: /about',
      expected: 'no target', breakpoint: null },
    { rule: 'I1', title: 'H1 count', severity: 'critical', engine: 'static', confidence: 'high',
      page: 'https://ex.com/p1', selector: 'body', found: 'H1 not found', expected: 'exactly one H1',
      breakpoint: null },
  ]
  return renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 6, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
    ...extra,
  })
}

test('the report leads with distinct defects, with occurrences beside them', () => {
  const out = repeatedDefectReport()
  assert.match(out, /<b>3 problems<\/b>/, 'three distinct defects')
  assert.match(out, /8 occurrences/, 'eight raw occurrences')
})

test('the distinct breakdown per severity is rendered, not just the totals', () => {
  const out = repeatedDefectReport()
  assert.match(out, /<b>1<\/b><span>Critical<\/span><\/div><div class="tile sev-maj"><b>2<\/b><span>Major<\/span><\/div><div class="tile sev-min"><b>0<\/b><span>Minor/)
})

test('the diff row renders remaining alongside new and fixed', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 3, findings: [],
    diff: { fixed: [1, 2], remaining: [1, 2, 3, 4], added: [1] },
    snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /<b>1<\/b> new/)
  assert.match(out, /<b>2<\/b> fixed/)
  assert.match(out, /<b>4<\/b> remaining/)
})

test('a missing diff object still renders remaining as zero', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 1, findings: [],
    snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /<b>0<\/b> remaining/)
})

test('a non-ok sitemapStatus is stated in the header as a possibly incomplete page list', () => {
  const out = repeatedDefectReport({ sitemapStatus: 'partial' })
  assert.match(out, /partial/)
  assert.match(out, /incomplete/i)
})

test('an ok or absent sitemapStatus renders no such warning', () => {
  assert.doesNotMatch(repeatedDefectReport({ sitemapStatus: 'ok' }), /incomplete/i)
  assert.doesNotMatch(repeatedDefectReport({ sitemapStatus: null }), /incomplete/i)
  assert.doesNotMatch(repeatedDefectReport(), /incomplete/i)
})

test('the sitemap status value is escaped like every other interpolated field', () => {
  const out = repeatedDefectReport({ sitemapStatus: '<script>alert(1)</script>' })
  assert.doesNotMatch(out, /<script>alert\(1\)<\/script>/)
  assert.match(out, /&lt;script&gt;/)
})

test('two tabs: failed is open by default with the problems, passed lists rules with no problem as text', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 2, snapshotAgeDays: 0, source: 'sitemap',
    findings: [{ rule: 'E4', title: 'tel: format', severity: 'major', engine: 'static', confidence: 'high', page: 'https://ex.com/', selector: 'a.phone', found: 'tel:855', expected: 'tel:+1855', breakpoint: null }],
    rules: [{ id: 'E4', title: 'tel: format' }, { id: 'I6', title: 'Page title' }],
    manualChecks: [{ index: 0, check: 'journey', title: 'Call', steps: ['Tapped the phone'], page: 'https://ex.com/', width: 360, status: 'ok', shots: ['visual/j.png'] }],
  })
  assert.match(out, /data-tab="failed" aria-selected="true">Failed <span class="n">1<\/span>/)
  assert.match(out, /<section id="panel-passed" role="tabpanel" hidden>/)
  const passed = out.split('id="panel-passed"')[1]
  assert.match(passed, /<b>I6<\/b> Page title/)
  assert.doesNotMatch(passed, /<b>E4<\/b>/, 'a rule with a problem is not passed')
  assert.match(passed, /Call/)
  assert.doesNotMatch(out, /visual\/j\.png/, 'no pictures for what passed')
})
