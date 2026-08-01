import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../../src/report/html.js'

const findings = [
  { rule: 'E4', title: 'Формат tel:', severity: 'major', engine: 'static', confidence: 'high',
    page: 'https://ex.com/a', selector: 'a.phone', found: 'tel:855-607-8758',
    expected: 'tel:+18556078758', breakpoint: null },
  { rule: 'I1', title: 'Количество H1', severity: 'critical', engine: 'static', confidence: 'high',
    page: 'https://ex.com/b', selector: 'body', found: 'H1 не найден', expected: 'ровно один H1',
    breakpoint: null },
]

const html = renderReport({
  host: 'ex.com', env: 'dev', envReason: 'имя хоста', pages: 12, findings,
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
  assert.match(html, /Формат tel:/)
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
      rule: `R${i % ruleCount}`, title: `Правило ${i % ruleCount}`, severity: 'minor',
      engine: 'static', confidence: 'high', page: `https://big-portfolio.example.com/page-${i % pageCount}`,
      selector: `.item-${i % 7}`, found: `значение-${i % 40}`, expected: 'ожидаемое значение', breakpoint: null,
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
      rule: 'E4', title: 'Формат tel:', severity: 'major', engine: 'static', confidence: 'high',
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
  const shown = [...listSegment.matchAll(/https:\/\/ex\.com\/page-\d+/g)]
  assert.ok(shown.length <= 200, `page list should be capped at 200, saw ${shown.length}`)
  assert.match(out, /ещё 50/) // visible truncation notice for the remaining 50 pages
})

test('truncates the page index at 500 and says so visibly', () => {
  const findings = []
  for (let i = 0; i < 600; i++) {
    findings.push({
      rule: 'E4', title: 'Формат tel:', severity: 'major', engine: 'static', confidence: 'high',
      page: `https://ex.com/idx-${i}`, selector: 'a.phone', found: `tel:855-607-87${i}`,
      expected: 'tel:+18556078758', breakpoint: null,
    })
  }
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 600, findings,
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  })
  const shownInIndex = [...out.matchAll(/https:\/\/ex\.com\/idx-\d+/g)]
  // Each unique page can also appear inside the rule-group page list (capped
  // separately at 200), so the total mentions can exceed 500 but the page
  // index table itself must stop at 500 rows and say so.
  assert.match(out, /ещё 100/) // 600 unique pages - 500 shown = 100 not shown
  assert.ok(shownInIndex.length > 0)
})

// ---------------------------------------------------------------------------
// Judgement call 3: heuristic findings must be visually and textually
// unmistakable as unconfirmed — their own section, excluded from the verdict
// and from the severity tiles.
// ---------------------------------------------------------------------------

test('a heuristic-only findings list renders Pass but still shows the heuristic section', () => {
  const findings = [
    { rule: 'H1', title: 'Подозрительный текст', severity: 'critical', engine: 'heuristic',
      confidence: 'heuristic', page: 'https://ex.com/a', selector: 'p', found: 'странный текст',
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
  assert.match(out, /эвристи/i) // Russian copy calling out unconfirmed heuristics
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
  assert.match(out, /не найдено/i)
  assert.match(out, /<!doctype html>/i)
})

test('a missing diff object renders without throwing and shows zero new/fixed', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 5, findings: [],
    snapshotAgeDays: 1, source: 'sitemap',
    // diff intentionally omitted
  })
  assert.match(out, /<!doctype html>/i)
  assert.match(out, /<b>0<\/b>\s*<span>новых<\/span>/)
  assert.match(out, /<b>0<\/b>\s*<span>починено<\/span>/)
})

test('snapshotAgeDays of 0 renders as fresh, not as "0 дн." or NaN', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 5, findings: [],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.doesNotMatch(out, /NaN/)
  assert.doesNotMatch(out, /0 дн\./)
  assert.match(out, /свеж/i)
})

test('env "unknown" renders sensibly', () => {
  const out = renderReport({
    host: 'ex.com', env: 'unknown', envReason: 'не удалось определить', pages: 5, findings: [],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  })
  assert.match(out, /unknown/)
  assert.match(out, /не удалось определить/)
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
    findings: [{ rule: 'I1', title: 'Количество H1', severity: 'critical', engine: 'static',
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
    findings: [{ rule: 'E4', title: 'Формат tel:', severity: 'major', engine: 'static',
      confidence: 'high', page: 'https://ex.com/a', selector: 'a.phone', found: 'f', expected: 'e',
      breakpoint: null }],
    diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 1, source: 'sitemap',
  })
  assert.match(out, /class="verdict v-Needs">Needs fixes<\/span>/)
  assert.doesNotMatch(out, /class="verdict v-Fail">Fail<\/span>/)
  assert.doesNotMatch(out, /class="verdict v-Pass">Pass<\/span>/)
})
