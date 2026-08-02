import { rollUp, verdict, countDistinct, defectIdentity } from './json.js'

// Escaping is the security boundary of this module: every interpolated value
// originates from a crawled third-party page (found/expected/page/selector)
// or from user input (host), so every interpolation goes through esc() with
// no exceptions. This also neutralizes '</style>' sequences, since escaped
// '<' can never close the surrounding <style> tag early.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const CHIP = { critical: 'crit', major: 'maj', minor: 'min', note: 'note' }
const LABEL = { critical: 'Critical', major: 'Major', minor: 'Minor', note: 'Note' }

const PAGE_LIST_CAP = 200
const PAGE_INDEX_CAP = 500
// Distinct defects rendered inside one rule+severity group. A rule like E1
// can legitimately produce hundreds of distinct broken links; past this many
// the group stops being readable, so the rest is truncated -- visibly, with
// the exact number withheld, never silently.
const DEFECT_CAP = 100

// A single self-contained HTML file is published as a sandboxed Artifact
// where every external request is blocked -- every screenshot has to be an
// inlined base64 data URI, and a handful of those add up fast (a data URI
// runs ~33% larger than the PNG it encodes). This is the SAME cap the
// pre-existing "realistic worst case" byte-size test in html.test.js checks
// findings/pages against; screenshots are measured against it too, not a
// second, separate budget, so the two concerns (many findings, many crops)
// compete for the same publish-size headroom rather than each getting their
// own allowance and silently doubling the real total.
const PUBLISH_BYTE_LIMIT = 2 * 1024 * 1024

// When the assembled document is still over budget, screenshots are dropped
// -- never the defect text itself, which is the part a developer actually
// needs to act on. Dropped in this order: note, then minor, then major, and
// -- as a genuine last resort, only reached once every lower tier is already
// gone -- critical too. An earlier version of this exempted critical
// entirely, on the theory that it is normally the smallest bucket. Real
// scale broke that assumption: a struggling multi-hundred-page site with
// dozens of distinct critical visual bugs per rule produced a 5.1MB report
// (2.5x over budget) with every screenshot critical, so nothing was ever
// eligible to drop and the document shipped oversized with no warning at
// all (see the "still over budget even after dropping everything droppable"
// note below, which exists precisely to make that impossible now). A report
// that is complete in text and short on pictures is far better than one
// that cannot be published.
const SHOT_DROP_ORDER = { note: 0, minor: 1, major: 2, critical: 3 }

const CSS = `
:root{--bg:#fff;--fg:#12151a;--mut:#5d6672;--line:#e4e7ec;--card:#f7f8fa;
--crit:#c0243a;--maj:#b7621b;--min:#5a6674;--note:#5d6672}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e8eaed;--mut:#9aa3ad;
--line:#242a31;--card:#161a20;--crit:#ff6b81;--maj:#e0954a;--min:#9aa3ad}}
:root[data-theme=dark]{--bg:#0f1216;--fg:#e8eaed;--mut:#9aa3ad;--line:#242a31;--card:#161a20;
--crit:#ff6b81;--maj:#e0954a;--min:#9aa3ad}
:root[data-theme=light]{--bg:#fff;--fg:#12151a;--mut:#5d6672;--line:#e4e7ec;--card:#f7f8fa;
--crit:#c0243a;--maj:#b7621b;--min:#5a6674}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 12px}
.sub{color:var(--mut);font-size:13px;margin-bottom:24px}
.verdict{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:600;
border:1px solid var(--line)}
.v-Fail{color:var(--crit)}.v-Needs{color:var(--maj)}.v-Pass{color:#2e7d4f}
.tiles{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 8px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:96px}
.tile b{display:block;font-size:20px}.tile span{color:var(--mut);font-size:12px}
.tile.wide{min-width:200px}.tile.wide b{font-size:18px}
.rule{border:1px solid var(--line);border-radius:10px;margin:10px 0;background:var(--card)}
.rule>summary{cursor:pointer;padding:12px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.chip{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
padding:2px 8px;border-radius:6px;border:1px solid currentColor}
.chip.crit{color:var(--crit)}.chip.maj{color:var(--maj)}.chip.min{color:var(--min)}.chip.note{color:var(--note)}
.cnt{margin-left:auto;color:var(--mut);font-size:13px}
.body{padding:0 14px 14px;font-size:14px}
.defect{padding:10px 0;border-top:1px solid var(--line)}
.defect:first-child{border-top:0;padding-top:0}
.kv{margin:8px 0}.kv code{background:var(--bg);border:1px solid var(--line);
border-radius:5px;padding:1px 6px;font-size:13px;word-break:break-all}
ul.pages{margin:8px 0 0;padding-left:18px;color:var(--mut);font-size:13px}
ul.pages li{word-break:break-all}
.note-box{border-left:3px solid var(--maj);padding:8px 12px;background:var(--card);
border-radius:0 8px 8px 0;font-size:13px;color:var(--mut);margin:12px 0}
.heuristic{border-left-color:var(--min)}
table{width:100%;border-collapse:collapse;font-size:13px}
.scroll{overflow-x:auto}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
`

// One distinct defect (rule + selector + normalized `found`, per
// defectIdentity) with its own found/expected/selector and its own collapsed
// list of the pages it occurs on.
//
// `ctx` carries the two pieces of browser-pass information that live outside
// rollUp()'s own output (json.js is not modified by this task): `breakpoints`
// -- every width, across every occurrence of this identity, not just the one
// `example` finding rollUp happened to keep -- and `suppressedShots`, the set
// of identities whose screenshot the size budget below decided to drop.
// Screenshot fields (`shotDataUri`/`shotWidth`) themselves DO come straight
// off `d.example`: run.js backfills them onto every occurrence of an
// identity, so the arbitrary "first occurrence" rollUp keeps always carries
// them when any occurrence does.
function renderDefect(d, ctx = {}) {
  const { breakpointsByIdentity = new Map(), suppressedShots = new Set(), candidates = null, severity } = ctx
  const shownPages = d.pages.slice(0, PAGE_LIST_CAP)
  const hiddenCount = d.pages.length - shownPages.length

  // Judgement call: a defect that recurs at more than one breakpoint (the
  // identity collapses them into one row, same as it already collapses
  // pages) must still say which widths it was actually seen at -- "360 and
  // 768 but not 1440" is exactly the kind of thing a developer needs and
  // that was previously only recoverable by grepping the raw findings.
  // Sorted ascending and de-duplicated (a Set, keyed by defectIdentity())
  // rather than read off one example, so every width the identity occurred
  // at is represented, not just whichever occurrence rollUp kept.
  const bps = breakpointsByIdentity.get(d.identity)
  const breakpointsHtml = bps && bps.size
    ? `<div class="kv">брейкпоинты: <code>${[...bps].sort((a, b) => a - b).map(esc).join(', ')}</code></div>`
    : ''

  // A `region` is a proved-shared container (regions.js, Tasks 6-7 -- header,
  // footer, a repeated widget) attached to a finding as a LABEL, not just an
  // extra key that happens to widen defectIdentity(). json.js's own comment
  // calls it out explicitly: "this is the footer, fix it once." Rendering it
  // is the whole payoff of that mechanism actually reaching a human reader --
  // without it, a defect repeated across every page's shared header shows up
  // as nothing more than a long, undifferentiated page list, and the reader
  // has no way to tell "one shared component, fix once" from "N unrelated
  // instances of the same mistake, fix N times" without already knowing the
  // site's template structure. Every occurrence of one identity carries the
  // SAME region (it is part of the identity key), so `d.example.region` is
  // authoritative here, same as the screenshot fields below.
  const region = d.example?.region ?? null
  const regionHtml = region
    ? `<div class="kv">регион: <code>${esc(region)}</code> — общий для всех вхождений ниже, исправить нужно один раз</div>`
    : ''

  // Review fix: `shotDataUri` reaches this function from `d.example`, which
  // for a report built directly against hand-supplied findings (as this
  // module's own test suite does, and as any future caller is free to do --
  // renderReport is a public, filesystem-free API, not something only
  // cli.js's own inlineScreenshots() ever feeds) could be ANY string, not
  // necessarily one cli.js actually produced. This report's whole premise
  // is "no external requests" (it is published as a sandboxed Artifact where
  // those are blocked outright); an `<img src>` pointed at a live
  // `https://` URL would be escaped (no injection) but would still be a
  // real external reference sitting in a document that promises there are
  // none. Only a genuine embedded `data:image/...` URI is accepted --
  // anything else (an http(s) URL, a bare string, a non-string) is treated
  // exactly like "no screenshot for this defect" and silently omitted, same
  // as any finding that never had one.
  const shotDataUri = (typeof d.example?.shotDataUri === 'string' && d.example.shotDataUri.startsWith('data:image/'))
    ? d.example.shotDataUri
    : null
  const shotWidth = d.example?.shotWidth ?? null
  if (shotDataUri && candidates) {
    // First pass only (candidates is null on the second, decided pass): a
    // shot is a drop candidate exactly when it is not already known-critical
    // -- see SHOT_DROP_ORDER and the size-budget pass in renderReport.
    candidates.push({ identity: d.identity, severity, bytes: Buffer.byteLength(shotDataUri, 'utf8') })
  }
  const suppressed = shotDataUri && suppressedShots.has(d.identity)
  const shotHtml = shotDataUri
    ? (suppressed
        ? `<div class="kv sub">скриншот скрыт — отчёт превысил лимит размера (см. предупреждение выше)</div>`
        : `<div class="kv"><img src="${esc(shotDataUri)}" alt="" style="max-width:100%">` +
          (shotWidth != null ? `<div class="sub">снимок сделан при ширине ${esc(shotWidth)}px</div>` : '') +
          `</div>`)
    : ''

  return `
      <div class="defect">
        <div class="kv">найдено: <code>${esc(d.found)}</code></div>
        ${d.expected ? `<div class="kv">ожидается: <code>${esc(d.expected)}</code></div>` : ''}
        <div class="kv">селектор: <code>${esc(d.selector)}</code></div>
        ${breakpointsHtml}
        ${regionHtml}
        ${shotHtml}
        <ul class="pages">${shownPages.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
        ${hiddenCount > 0 ? `<p class="kv">…и ещё ${hiddenCount} страниц не показано (ограничение списка)</p>` : ''}
      </div>`
}

// A rule+severity+confidence group renders EVERY distinct defect it holds,
// not just one example. Rendering `g.example` alone was how the report came
// to describe 10 of the run's 25 distinct defects while its tiles counted all
// 25 -- eight different broken links collapsed into whichever one happened to
// be seen first.
function renderGroup(g, ctx = {}) {
  const defects = g.identities?.length
    ? g.identities
    : [{ found: g.example.found, expected: g.example.expected, selector: g.example.selector, pages: g.pages, example: g.example }]
  const shown = defects.slice(0, DEFECT_CAP)
  const hiddenDefects = defects.length - shown.length
  return `
  <details class="rule">
    <summary>
      <span class="chip ${CHIP[g.severity] ?? 'note'}">${esc(LABEL[g.severity] ?? g.severity)}</span>
      <b>${esc(g.rule)}</b> · ${esc(g.title)}
      <span class="cnt">${defects.length} дефектов · ${g.pages.length} страниц · ${g.count} находок</span>
    </summary>
    <div class="body">
      ${shown.map(d => renderDefect(d, { ...ctx, severity: g.severity })).join('')}
      ${hiddenDefects > 0 ? `<p class="kv">…и ещё ${hiddenDefects} дефектов не показано (ограничение списка)</p>` : ''}
    </div>
  </details>`
}

export function renderReport({
  host, env, envReason, pages, findings, diff, snapshotAgeDays, source, sitemapStatus,
  browserCoverage,
}) {
  // Fail fast on malformed findings, matching the array contract rollUp/diffRuns
  // already enforce (src/report/json.js). Coercing bad input to [] here would
  // turn a caller bug or corrupted findings.json into a confident, professional
  // "Pass" report — the worst possible failure mode for a QC tool, because it
  // is indistinguishable from a genuinely clean site. A thrown TypeError is
  // impossible to miss; a false all-clear is not. No HTML is produced below
  // this check when findings is unusable.
  if (!Array.isArray(findings)) {
    const received = findings === null ? 'null' : findings === undefined ? 'undefined' : typeof findings
    throw new TypeError(`renderReport requires findings to be an array, got ${received}`)
  }
  const list = findings
  const solid = list.filter(f => f.confidence !== 'heuristic')
  const groups = rollUp(solid)
  const heur = rollUp(list.filter(f => f.confidence === 'heuristic'))
  const v = verdict(list)
  const vClass = v === 'Fail' ? 'v-Fail' : v === 'Pass' ? 'v-Pass' : 'v-Needs'
  const by = (s) => solid.filter(f => f.severity === s).length

  const uniquePages = [...new Set(list.map(f => f.page))]
  const shownPages = uniquePages.slice(0, PAGE_INDEX_CAP)
  const hiddenPageCount = uniquePages.length - shownPages.length

  const ageLabel = snapshotAgeDays < 1
    ? 'свежий'
    : `${Number(snapshotAgeDays).toFixed(0)} дн.`

  // The severity tiles count raw occurrences, which is what made the report
  // lead with "Major 56" -- the exact number this engine's distinct/occurrence
  // split exists to stop anyone quoting. `distinct` was computed in cli.js and
  // never rendered, so the word never appeared in the HTML at all. It leads the
  // tile row now, with occurrences kept beside it as blast radius.
  const distinct = countDistinct(solid)
  const distinctTotal = distinct.critical + distinct.major + distinct.minor + distinct.note
  const occurrenceTotal = solid.length

  // A run built from a partial or broken sitemap used to look identical to a
  // clean one: same header, same page count, nothing saying the page list
  // itself may be short. `ok` (and a null status, meaning the page list did
  // not come from a sitemap at all) says nothing; anything else does.
  const sitemapWarning = sitemapStatus && sitemapStatus !== 'ok'

  // Every occurrence of an identity carries its own `breakpoint` (browser
  // findings only -- static findings always have breakpoint: null, which is
  // simply skipped here). Aggregated across ALL occurrences of an identity,
  // not read off rollUp's single `example`, so a defect seen at both 360 and
  // 768 renders both, even though rollUp kept only one of those findings as
  // its representative example.
  const breakpointsByIdentity = new Map()
  for (const f of list) {
    if (f.breakpoint === null || f.breakpoint === undefined) continue
    const id = defectIdentity(f)
    if (!breakpointsByIdentity.has(id)) breakpointsByIdentity.set(id, new Set())
    breakpointsByIdentity.get(id).add(f.breakpoint)
  }

  // Judgement call: a static-only run (`qc audit` with `qc browse` never run
  // for this host) must not look like a run that checked visual/interactive
  // behaviour and found nothing -- that is indistinguishable, to a reader,
  // from a genuinely clean visual pass. `browserCoverage` is undefined in
  // exactly that case (cli.js only supplies it when browser.jsonl exists),
  // so the header states plainly that no browser pass ran at all, rather
  // than silently omitting any mention of it.
  //
  // When it IS present, partial coverage (pagesDone < pagesTotal) gets its
  // own visible warning -- a browser pass that covered 40 of 348 pages must
  // never look complete just because SOME findings are shown.
  let browserCoverageHtml
  if (!browserCoverage) {
    browserCoverageHtml = `<div class="note-box">Браузерная проверка не выполнялась — этот отчёт основан только на статическом анализе HTML. Визуальные и интерактивные дефекты (переполнение, наложения элементов, hover/focus, ошибки консоли, скриншоты) не проверялись. Запустите <code>qc browse ${esc(host)}</code>, чтобы дополнить отчёт.</div>`
  } else {
    const pagesDone = Number(browserCoverage.pagesDone) || 0
    const pagesTotal = Number(browserCoverage.pagesTotal) || 0
    const widths = Array.isArray(browserCoverage.widths) ? browserCoverage.widths : []
    const complete = pagesTotal > 0 && pagesDone >= pagesTotal
    browserCoverageHtml = `<p class="sub">браузерная проверка: ${esc(pagesDone)} из ${esc(pagesTotal)} страниц` +
      (widths.length ? ` · ширины: ${widths.map(esc).join(', ')}` : '') + `</p>` +
      (!complete
        ? `<div class="note-box">Браузерная проверка выполнена частично: проверено ${esc(pagesDone)} из ${esc(pagesTotal)} страниц, остальные ещё не проверены. Визуальные дефекты на непроверенных страницах могли остаться незамеченными. Запустите <code>qc browse ${esc(host)}</code> ещё раз, чтобы продолжить — прогон возобновляемый и не начинает заново уже проверенные страницы.</div>`
        : '')
  }

  // Screenshots are checked against the SAME publish-size budget as
  // everything else (see PUBLISH_BYTE_LIMIT above), not a separate one --
  // built by rendering the full document once, and only if that comes in
  // over budget, deciding which screenshots to drop and rendering a second,
  // final time. The common case (no screenshots, or few enough to fit) pays
  // for exactly one render.
  //
  // `oversizeBytes`, when given, forces an UNCONDITIONAL "this document is
  // still over the publish budget" note -- independent of whether anything
  // was actually suppressed. Review fix: the note used to only render when
  // `suppressedShots.size > 0`, so a document with nothing eligible to drop
  // (every screenshot critical, before critical became a droppable last
  // resort -- or, still possible today, a document whose TEXT alone exceeds
  // the budget with no screenshots involved at all) shipped over budget with
  // no warning anywhere. This note is deliberately a separate condition from
  // the "N screenshots dropped" one below -- either can be true without the
  // other (dropping can succeed and clear the budget with no oversize note
  // needed; or nothing may be droppable/enough may not have been droppable
  // and the oversize note is the only one that fires).
  function build(suppressedShots, { oversizeBytes } = {}) {
    const candidates = suppressedShots ? null : []
    const ctx = { breakpointsByIdentity, suppressedShots: suppressedShots ?? new Set(), candidates }
    const groupsHtml = groups.length
      ? groups.map(g => renderGroup(g, ctx)).join('')
      : '<p class="sub">Нарушений не найдено — сайт прошёл проверку без замечаний.</p>'
    const heurHtml = heur.length
      ? `<h2>Требует взгляда (неподтверждённые эвристики)</h2>
<div class="note-box heuristic">Ниже — находки эвристических правил: возможны ложные срабатывания, они <b>не учитываются</b> в вердикте и в плитках серьёзности выше. Проверьте вручную перед тем, как заводить задачу.</div>
${heur.map(g => renderGroup(g, ctx)).join('')}`
      : ''

    const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QC ${esc(host)}</title><style>${CSS}</style></head><body><div class="wrap">
<h1>QC · ${esc(host)}</h1>
<p class="sub">среда: <b>${esc(env)}</b>${envReason ? ` (${esc(envReason)})` : ''} ·
страниц: ${esc(pages)} · источник списка: ${esc(source)} ·
снапшот: ${ageLabel}</p>
<p><span class="verdict ${vClass}">${esc(v)}</span></p>
${snapshotAgeDays > 7 ? `<div class="note-box">Снапшот старше 7 дней — данные могли устареть. Перезапустите с <code>--fresh</code>.</div>` : ''}
${sitemapWarning ? `<div class="note-box">Sitemap: <b>${esc(sitemapStatus)}</b> — список страниц мог оказаться неполным, часть страниц сайта в отчёт не попала.</div>` : ''}
${browserCoverageHtml}
${suppressedShots && suppressedShots.size ? `<div class="note-box">Часть скриншотов скрыта, чтобы уместиться в лимит размера публикации: ${esc(suppressedShots.size)} скриншот(ов) не показано (порядок удаления: сначала note, затем minor, major и, при необходимости, critical). Сами дефекты и их описания — found/expected/селектор/страницы — остаются ниже полностью, скрыты только изображения.</div>` : ''}
${oversizeBytes != null ? `<div class="note-box">Отчёт превышает рекомендуемый лимит размера публикации (~${esc((oversizeBytes / (1024 * 1024)).toFixed(1))} МБ из ${esc(PUBLISH_BYTE_LIMIT / (1024 * 1024))} МБ), даже после того как были скрыты все скриншоты, которые можно было скрыть. Публикация как Artifact может не сработать из-за размера файла. Сами находки в этом файле не пострадали — это предупреждение о размере, не о содержимом.</div>` : ''}
<div class="tiles">
  <div class="tile wide"><b>${distinctTotal} дефектов</b><span>${occurrenceTotal} вхождений на ${uniquePages.length} страницах</span></div>
  <div class="tile"><b>${by('critical')}</b><span>Critical</span></div>
  <div class="tile"><b>${by('major')}</b><span>Major</span></div>
  <div class="tile"><b>${by('minor')}</b><span>Minor</span></div>
  <div class="tile"><b>${diff?.added?.length ?? 0}</b><span>новых</span></div>
  <div class="tile"><b>${diff?.fixed?.length ?? 0}</b><span>починено</span></div>
  <div class="tile"><b>${diff?.remaining?.length ?? 0}</b><span>осталось</span></div>
</div>
<p class="sub">Дефектов по серьёзности: ${distinct.critical} critical · ${distinct.major} major · ${distinct.minor} minor · ${distinct.note} note — это число реальных задач на исправление.
Плитки Critical/Major/Minor выше считают вхождения (одна правка может закрыть сразу несколько).</p>
<h2>Находки по правилам</h2>
${groupsHtml}
${heurHtml}
<h2>Страницы</h2>
${uniquePages.length ? `<div class="scroll"><table><tr><th>Страница</th><th>Находок</th></tr>
${shownPages.map(p =>
  `<tr><td>${esc(p)}</td><td>${list.filter(f => f.page === p).length}</td></tr>`).join('')}
</table></div>
${hiddenPageCount > 0 ? `<p class="kv">…и ещё ${hiddenPageCount} страниц не показано (ограничение индекса)</p>` : ''}` : '<p class="sub">Нет страниц с находками.</p>'}
</div></body></html>`
    return { html, candidates }
  }

  const first = build(null)
  if (Buffer.byteLength(first.html, 'utf8') <= PUBLISH_BYTE_LIMIT) return first.html

  // Over budget: decide which screenshots to drop, lowest severity first,
  // with critical only as a last resort (see SHOT_DROP_ORDER's own comment
  // for why critical is droppable at all now). Among candidates that share a
  // tier, drop the biggest images first, since that recovers the most bytes
  // per screenshot dropped. `bytesOver` is tracked against the FIRST
  // render's size -- an approximation (the second render's non-image markup
  // differs slightly, e.g. the "hidden" placeholder text and the new
  // warning banners), deliberately conservative in the safe direction: it
  // keeps dropping until it is confident of clearing the limit rather than
  // stopping right at the edge and risking a second render that is still
  // over.
  const droppable = first.candidates
    .filter(c => SHOT_DROP_ORDER[c.severity] !== undefined)
    .sort((a, b) => (SHOT_DROP_ORDER[a.severity] - SHOT_DROP_ORDER[b.severity]) || (b.bytes - a.bytes))

  const suppressed = new Set()
  let bytesOver = Buffer.byteLength(first.html, 'utf8') - PUBLISH_BYTE_LIMIT
  for (const c of droppable) {
    if (bytesOver <= 0) break
    suppressed.add(c.identity)
    bytesOver -= c.bytes
  }

  const second = build(suppressed)
  const secondBytes = Buffer.byteLength(second.html, 'utf8')
  if (secondBytes <= PUBLISH_BYTE_LIMIT) return second.html

  // Review fix: even after dropping every screenshot this document had
  // anything to drop (every candidate, including critical, may already be
  // in `suppressed` -- or there may have been no screenshots at all, and the
  // findings' own text is simply too large), the document can still be over
  // budget. That must never ship silently: a third, final render bakes an
  // unconditional oversize note into the SAME place a reader already checks
  // for size-related warnings, using `secondBytes` (measured just before
  // this call) as the number to report -- the note's own few hundred bytes
  // shift the true final size negligibly relative to a multi-megabyte
  // overage, so it is close enough to be useful without needing a fourth
  // render to chase an exact figure.
  const third = build(suppressed, { oversizeBytes: secondBytes })
  return third.html
}
