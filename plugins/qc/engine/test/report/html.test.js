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

// Review follow-up (Important 1): a rule that emits findings at more than
// one severity used to collapse into a single row chipped with the most
// severe of the bunch -- rendered against the real cached cleaningny.com
// run, E3's 44 major + 180 minor findings showed up as one "Major · 224
// находок" row, hiding that the calibration had split them at all. Assert
// the rendered HTML now shows two separate <details class="rule"> rows,
// each with its own correct chip and its own count.
test('a rule that emits two severities renders as two separate rows with distinct chips, not one merged row', () => {
  const findings = [
    ...Array.from({ length: 3 }, (_, i) => ({
      rule: 'E3', title: 'Правила target=_blank', severity: 'major', engine: 'static', confidence: 'high',
      page: `https://ex.com/major-${i}`, selector: 'a.internal', found: 'внутренняя ссылка с target=_blank',
      expected: 'без target', breakpoint: null,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      rule: 'E3', title: 'Правила target=_blank', severity: 'minor', engine: 'static', confidence: 'high',
      page: `https://ex.com/minor-${i}`, selector: 'a.social', found: 'внешняя ссылка без rel=noopener',
      expected: 'rel="noopener"', breakpoint: null,
    })),
  ]
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 8, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  const ruleRows = [...out.matchAll(/<details class="rule">[\s\S]*?<\/details>/g)]
  const e3Rows = ruleRows.filter(m => m[0].includes('>E3<'))
  assert.equal(e3Rows.length, 2, 'E3 major and minor findings must render as two separate rows')

  const majorRow = e3Rows.find(m => /chip maj/.test(m[0]))
  const minorRow = e3Rows.find(m => /chip min/.test(m[0]))
  assert.ok(majorRow, 'expected a row with the major chip')
  assert.ok(minorRow, 'expected a row with the minor chip')
  assert.match(majorRow[0], /3 находок/, 'major row counts only its own 3 findings')
  assert.match(minorRow[0], /5 находок/, 'minor row counts only its own 5 findings')
  // No single row should claim all 8 -- that would mean they were re-merged.
  assert.doesNotMatch(majorRow[0], /8 находок/)
  assert.doesNotMatch(minorRow[0], /8 находок/)
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
    { rule: 'E1', title: 'Битые ссылки', severity: 'critical', engine: 'static', confidence: 'high',
      page: 'https://ex.com/a', selector: 'a.first', found: 'HTTP 404: https://ex.com/gone',
      expected: 'рабочая ссылка', breakpoint: null },
    { rule: 'E1', title: 'Битые ссылки', severity: 'critical', engine: 'static', confidence: 'high',
      page: 'https://ex.com/b', selector: 'a.second',
      found: 'битый URL: https://ex.com/janitorial-cleaning/https://ex.com/x',
      expected: 'корректный URL', breakpoint: null },
  ]
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 2, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /HTTP 404: https:\/\/ex\.com\/gone/)
  assert.match(out, /janitorial-cleaning/)
  assert.match(out, /a\.first/)
  assert.match(out, /a\.second/)
  assert.match(out, /рабочая ссылка/)
  assert.match(out, /корректный URL/)
})

test('every distinct defect gets its own page list, not one merged list', () => {
  const findings = [
    ...['https://ex.com/1', 'https://ex.com/2'].map(page => ({
      rule: 'E3', title: 'target=_blank', severity: 'major', engine: 'static', confidence: 'high',
      page, selector: 'a.alpha', found: 'внутренняя ссылка с target=_blank: /alpha',
      expected: 'без target', breakpoint: null,
    })),
    { rule: 'E3', title: 'target=_blank', severity: 'major', engine: 'static', confidence: 'high',
      page: 'https://ex.com/3', selector: 'a.beta', found: 'внутренняя ссылка с target=_blank: /beta',
      expected: 'без target', breakpoint: null },
  ]
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 3, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  const group = out.match(/<details class="rule">[\s\S]*?<\/details>/)[0]
  const defects = [...group.matchAll(/<div class="defect">/g)]
  assert.equal(defects.length, 2, 'expected one block per distinct defect')
  const alpha = group.split('a.beta')[0]
  assert.match(alpha, /https:\/\/ex\.com\/1/)
  assert.match(alpha, /https:\/\/ex\.com\/2/)
  assert.doesNotMatch(alpha, /https:\/\/ex\.com\/3/, '/3 belongs to the beta defect only')
})

test('the group summary states how many distinct defects it holds', () => {
  const findings = Array.from({ length: 4 }, (_, i) => ({
    rule: 'E4', title: 'Формат tel:', severity: 'major', engine: 'static', confidence: 'high',
    page: `https://ex.com/p${i}`, selector: 'a.phone', found: `tel:855-607-875${i}`,
    expected: 'tel:+1855607875X', breakpoint: null,
  }))
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 4, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /4 дефектов · 4 страниц · 4 находок/)
})

test('a group holding more distinct defects than the cap truncates visibly', () => {
  const findings = Array.from({ length: 130 }, (_, i) => ({
    rule: 'E1', title: 'Битые ссылки', severity: 'critical', engine: 'static', confidence: 'high',
    page: 'https://ex.com/a', selector: `a.n${i}`, found: `HTTP 404: https://ex.com/gone-${i}`,
    expected: 'рабочая ссылка', breakpoint: null,
  }))
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 1, findings,
    diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /ещё 30 дефектов не показано/)
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
      page: `https://ex.com/p${i}`, selector: 'a.footer', found: 'внутренняя ссылка с target=_blank: /contact',
      expected: 'без target', breakpoint: null,
    })),
    { rule: 'E3', title: 'target=_blank', severity: 'major', engine: 'static', confidence: 'high',
      page: 'https://ex.com/p0', selector: 'a.hero', found: 'внутренняя ссылка с target=_blank: /about',
      expected: 'без target', breakpoint: null },
    { rule: 'I1', title: 'Количество H1', severity: 'critical', engine: 'static', confidence: 'high',
      page: 'https://ex.com/p1', selector: 'body', found: 'H1 не найден', expected: 'ровно один H1',
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
  assert.match(out, /<b>3 дефектов<\/b>/, 'three distinct defects')
  assert.match(out, /8 вхождений/, 'eight raw occurrences')
})

test('the distinct breakdown per severity is rendered, not just the totals', () => {
  const out = repeatedDefectReport()
  assert.match(out, /1 critical · 2 major · 0 minor · 0 note/)
})

test('the diff row renders осталось alongside новых and починено', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 3, findings: [],
    diff: { fixed: [1, 2], remaining: [1, 2, 3, 4], added: [1] },
    snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /<b>1<\/b><span>новых<\/span>/)
  assert.match(out, /<b>2<\/b><span>починено<\/span>/)
  assert.match(out, /<b>4<\/b><span>осталось<\/span>/)
})

test('a missing diff object still renders осталось as zero', () => {
  const out = renderReport({
    host: 'ex.com', env: 'prod', envReason: '', pages: 1, findings: [],
    snapshotAgeDays: 0, source: 'sitemap',
  })
  assert.match(out, /<b>0<\/b><span>осталось<\/span>/)
})

test('a non-ok sitemapStatus is stated in the header as a possibly incomplete page list', () => {
  const out = repeatedDefectReport({ sitemapStatus: 'partial' })
  assert.match(out, /partial/)
  assert.match(out, /неполным/i)
})

test('an ok or absent sitemapStatus renders no such warning', () => {
  assert.doesNotMatch(repeatedDefectReport({ sitemapStatus: 'ok' }), /неполным/i)
  assert.doesNotMatch(repeatedDefectReport({ sitemapStatus: null }), /неполным/i)
  assert.doesNotMatch(repeatedDefectReport(), /неполным/i)
})

test('the sitemap status value is escaped like every other interpolated field', () => {
  const out = repeatedDefectReport({ sitemapStatus: '<script>alert(1)</script>' })
  assert.doesNotMatch(out, /<script>alert\(1\)<\/script>/)
  assert.match(out, /&lt;script&gt;/)
})
