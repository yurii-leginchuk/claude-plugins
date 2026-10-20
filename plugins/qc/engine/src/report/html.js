import { rollUp, verdict, countDistinct, defectIdentity } from './json.js'
import { STALENESS_WARNING_DAYS } from '../lib/snapshot-ttl.js'
import { UNNAMED_REGION_PREFIX } from '../browser/regions.js'

// Escaping is the security boundary of this module: every interpolated value
// originates from a crawled third-party page (found/expected/page/selector)
// or from user input (host), so every interpolation goes through esc() with
// no exceptions. This also neutralizes '</style>' sequences, since escaped
// '<' can never close the surrounding <style> tag early.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

// Every page, path or URL the report names is a link to it: «[Brooklyn](url)»
// written by Claude, a bare https:// URL, or a site path «/services/x/»
// (resolved against the audited site, set per render in renderReport).
let ORIGIN = null
const LINK = /\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'«»)\]]+)|(?<![\w./:-])(\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/){1,4})(?![\w-])/g
const anchor = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`
function rich(s) {
  const str = String(s ?? '')
  let out = ''
  let last = 0
  for (const m of str.matchAll(LINK)) {
    out += esc(str.slice(last, m.index))
    last = m.index + m[0].length
    if (m[1]) out += anchor(m[2], m[1])
    else if (m[3]) {
      const url = m[3].replace(/[.,;:!?]+$/, '')
      out += anchor(url, url) + esc(m[3].slice(url.length))
    } else out += ORIGIN ? anchor(ORIGIN + m[4], m[4]) : esc(m[4])
  }
  return out + esc(str.slice(last))
}

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
.review{font-weight:600}.review-confirmed{color:var(--crit)}.review-unsure{color:var(--maj)}.review-false-positive{color:var(--mut)}
h3{font-size:15px;margin:22px 0 4px}
ul.pages .where{color:var(--fg);word-break:normal;margin:2px 0 6px}
.note-box{border-left:3px solid var(--maj);padding:8px 12px;background:var(--card);
border-radius:0 8px 8px 0;font-size:13px;color:var(--mut);margin:12px 0}
.heuristic{border-left-color:var(--min)}
table{width:100%;border-collapse:collapse;font-size:13px}
.scroll{overflow-x:auto}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
.wrap a{color:inherit;text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px}
.wrap a:hover{text-decoration-thickness:2px}
.vis-page{border-top:1px solid var(--line);padding:12px 0}
.vis-page .kv{margin:0 0 8px}
.strip{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;align-items:flex-start}
.thumb{flex:none;margin:0;font-size:12px;color:var(--mut);text-align:center}
.thumb button{display:block;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--card);
cursor:zoom-in;overflow:hidden;height:280px}
.thumb button:focus-visible{outline:2px solid var(--maj);outline-offset:2px}
.thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
.menu-row{border-top:1px solid var(--line);padding:12px 0}
.chip.ok{color:#2e7d4f}
dialog.lb{max-width:96vw;max-height:94vh;padding:0;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
dialog.lb::backdrop{background:rgba(0,0,0,.6)}
dialog.lb .bar{position:sticky;top:0;display:flex;justify-content:space-between;gap:12px;padding:8px 12px;
background:var(--card);border-bottom:1px solid var(--line);font-size:13px}
dialog.lb img{display:block;max-width:100%;margin:0 auto}
`

// Thumbnail width per viewport width: a phone shot stays narrow, a desktop
// one wide, all at the same height so a row reads as one strip.
const thumbWidth = (w) => Math.round(Math.min(320, Math.max(110, Number(w) / 4.5)))
const thumb = (src, label, w) => `<figure class="thumb"><button type="button" data-full="${esc(src)}" data-label="${esc(label)}" style="width:${thumbWidth(w)}px" aria-label="Открыть ${esc(label)}"><img loading="lazy" src="${esc(src)}" alt="${esc(label)}"></button><figcaption>${esc(label)}</figcaption></figure>`

// Every page at every width, defects or not -- what QA scrolls through by eye.
function renderVisual(visual) {
  if (!Array.isArray(visual) || !visual.length) {
    return '<h2>Визуальная проверка</h2><p class="sub">Скриншотов страниц нет — браузерная проверка не снимала страницы (запустите <code>qc browse</code> этой версией).</p>'
  }
  return `<h2>Визуальная проверка — все страницы на всех ширинах</h2>
<div class="note-box heuristic">Скриншоты всей страницы на каждой ширине, даже там, где дефектов не найдено, — чтобы глазами пролистать сайт. Нажмите на миниатюру, чтобы открыть в полный размер.</div>
${visual.map(v => `<div class="vis-page"><p class="kv">${rich(v.url)}</p><div class="strip">${v.shots.map(s =>
    thumb(s.src, `${s.width} px${s.cut ? ' (обрезано)' : ''}`, s.width)).join('')}</div></div>`).join('')}`
}

const MANUAL_STATUS = { ok: ['ok', 'в порядке'], defect: ['crit', 'есть дефекты'], skipped: ['note', 'не проверено'] }
const MANUAL_SECTIONS = [
  ['menu', 'Мобильное меню', 'открывается ли бургер, на всю ли ширину, не выходит ли за край, видны ли все пункты, раскрываются ли подменю, закрывается ли, совпадают ли ссылки с десктопным меню'],
  ['popup', 'Попапы', 'открывается ли по кнопке, помещается ли в экран, закрывается ли крестиком, кликом мимо и Esc'],
  ['form', 'Формы', 'обязательные поля и *, тексты ошибок, маска телефона, кнопка после ошибки, раскладка на мобильном (без отправки)'],
  ['faq', 'FAQ и аккордеоны', 'открывается ли нужный пункт, не ломается ли вёрстка'],
  ['focus', 'Фокус с клавиатуры', 'виден ли фокус при переходе по Tab, доходит ли он до меню, кнопок и форм, нет ли ловушек'],
  ['content', 'Противоречия в тексте', 'сроки, цифры, часы, цены и обещания, которые расходятся между страницами'],
]

// What Claude checked by hand (Playwright, or reading the pages for
// `content`); the engine only renders what Claude recorded.
function renderManual(manualChecks, claudeFindings) {
  const checks = Array.isArray(manualChecks) ? manualChecks : []
  const done = MANUAL_SECTIONS.filter(([k]) => checks.some(c => c.check === k))
  const missing = MANUAL_SECTIONS.filter(([k]) => !checks.some(c => c.check === k))
  const head = `<h2>Ручные проверки Claude (Playwright и чтение страниц)</h2>
<div class="note-box heuristic">Это то, что движок не умеет: нажать, навести, пройти Tab, понять смысл текста. Claude проверил вручную; найденные дефекты учтены в вердикте.</div>`
  const body = done.map(([k, title, what]) => `<h3>${esc(title)}</h3><p class="sub">${esc(what)}</p>${checks.filter(c => c.check === k).map(m => {
    const [cls, label] = MANUAL_STATUS[m.status] || MANUAL_STATUS.skipped
    // One block per defect, with every page it names (a content defect spans several).
    const defs = []
    for (const f of claudeFindings.filter(f => (m.index != null ? f.manual === m.index : f.check === k && f.page === m.page && (f.breakpoint ?? null) === (m.width ?? null)))) {
      const d = defs.find(x => x.rule === f.rule && x.found === f.found)
      if (d) d.pages.push(f.page)
      else defs.push({ ...f, pages: [f.page] })
    }
    return `<div class="menu-row"><p class="kv"><span class="chip ${cls}">${esc(label)}</span>${m.width != null ? ` <b>${esc(m.width)} px</b> ·` : ''} ${rich(m.page)}</p>
${m.checked ? `<p class="kv">${rich(m.checked)}</p>` : ''}
${defs.map(f => `<div class="defect"><p class="kv"><span class="chip ${CHIP[f.severity] || 'note'}">${esc(f.severity)}</span> ${esc(f.rule)} · ${esc(f.title)}</p><p class="kv">найдено: ${rich(f.found)}</p>${f.where ? `<p class="kv">где: ${rich(f.where)}</p>` : ''}<p class="kv">ожидается: ${rich(f.expected)}</p>${f.pages.length > 1 ? `<ul class="pages">${f.pages.map(p => `<li>${rich(p)}</li>`).join('')}</ul>` : ''}</div>`).join('')}
${(m.shots || []).length ? `<div class="strip">${m.shots.map((src, i) => thumb(src, `${m.width != null ? `${m.width} px · ` : ''}${i + 1}`, m.width || 768)).join('')}</div>` : ''}</div>`
  }).join('')}`).join('')
  const rest = missing.length ? `<p class="sub">Не проверялось вручную: ${missing.map(([, t]) => esc(t)).join(', ')}.</p>` : ''
  return head + body + rest
}

const LIGHTBOX = `<dialog class="lb" id="qc-lb"><div class="bar"><span id="qc-lb-t"></span><button type="button" id="qc-lb-x">Закрыть</button></div><img id="qc-lb-i" alt=""></dialog>
<script>(()=>{const d=document.getElementById('qc-lb');if(!d||!d.showModal)return;const i=document.getElementById('qc-lb-i'),t=document.getElementById('qc-lb-t');
document.addEventListener('click',e=>{const b=e.target.closest('[data-full]');if(!b)return;i.src=b.dataset.full;i.alt=b.dataset.label;t.textContent=b.dataset.label;d.showModal()});
document.getElementById('qc-lb-x').onclick=()=>d.close();d.addEventListener('click',e=>{if(e.target===d)d.close()})})()</script>`

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
  //
  // A region whose NAME could not be determined is labelled as the container
  // id it actually is, and said to be unnamed -- not printed in the name slot
  // as though it were one. On the only real site this has run against, every
  // label read "регион: 3381" rather than "footer", because that snapshot was
  // crawled before the parser recorded `locationsById` and nothing detected a
  // snapshot whose shape predates a parser change. The finding is still
  // correct and still collapses across pages; only the name is missing, and
  // re-crawling is what supplies it.
  const region = d.example?.region ?? null
  const unnamedRegion = typeof region === 'string' && region.startsWith(UNNAMED_REGION_PREFIX)
  const regionHtml = region
    ? (unnamedRegion
        ? `<div class="kv">регион: общий контейнер Elementor <code>${esc(region.slice(UNNAMED_REGION_PREFIX.length))}</code> (название — header/footer — определить не удалось: снимок сделан до того, как парсер начал сохранять локации; пересоберите его через <code>--fresh</code>) — общий для всех вхождений ниже, исправить нужно один раз</div>`
        : `<div class="kv">регион: <code>${esc(region)}</code> — общий для всех вхождений ниже, исправить нужно один раз</div>`)
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
        ${d.example?.review ? `<div class="kv review review-${esc(d.example.review.verdict)}">Claude: ${esc(REVIEW_LABEL[d.example.review.verdict] || d.example.review.verdict)}${d.example.review.note ? ` — ${rich(d.example.review.note)}` : ''}</div>` : ''}
        ${String(d.scope || '').startsWith('template:') ? `<div class="kv">раздел: <code>${esc(d.scope.slice(9))}</code></div>` : ''}
        <div class="kv">найдено: <code>${rich(d.found)}</code></div>
        ${d.expected ? `<div class="kv">ожидается: <code>${rich(d.expected)}</code></div>` : ''}
        <div class="kv">селектор: <code>${esc(d.selector)}</code></div>
        ${breakpointsHtml}
        ${regionHtml}
        ${shotHtml}
        <ul class="pages">${shownPages.map(p => `<li>${rich(p)}${d.where?.[p] ? `<div class="where">${rich(d.where[p])}</div>` : ''}</li>`).join('')}</ul>
        ${hiddenCount > 0 ? `<p class="kv">…и ещё ${hiddenCount} страниц не показано (ограничение списка)</p>` : ''}
      </div>`
}

// Where a defect lives, so it is fixed at the right level:
//   global    site chrome (header, menu, footer) or on ~every page: one fix
//             in a template part repairs all of them;
//   template  every page it is on shares a section (/services/…): the
//             section's template or shared block;
//   page      everything else.
const CHROME = new Set(['header', 'nav', 'footer', 'chrome'])
const sectionOfPage = (u) => { try { return new URL(u).pathname.split('/').filter(Boolean)[0] || null } catch { return null } }
export function scopeOf(d, totalPages) {
  const zones = [...(d.zones || [])]
  if (d.region || (zones.length && zones.every(z => CHROME.has(z)))) return 'global'
  if (totalPages >= 5 && d.pages.length >= Math.max(3, 0.8 * totalPages)) return 'global'
  const secs = new Set(d.pages.map(sectionOfPage))
  if (d.pages.length >= 2 && secs.size === 1 && [...secs][0]) return `template:/${[...secs][0]}/`
  return 'page'
}

function scoped(groups, totalPages) {
  const buckets = new Map()
  for (const g of groups) {
    for (const d of g.identities) {
      const scope = scopeOf({ ...d, region: d.example?.region }, totalPages)
      const key = scope.startsWith('template') ? 'template' : scope
      if (!buckets.has(key)) buckets.set(key, new Map())
      const b = buckets.get(key)
      const gk = `${g.rule}|${g.severity}|${g.confidence}`
      if (!b.has(gk)) b.set(gk, { ...g, identities: [], pages: new Set(), count: 0 })
      const sg = b.get(gk)
      sg.identities.push({ ...d, scope })
      d.pages.forEach(p => sg.pages.add(p))
      sg.count += d.count
    }
  }
  const TITLES = {
    global: ['Глобальные ошибки', 'хедер, меню, футер или все страницы сайта — исправляется один раз в общем шаблоне'],
    template: ['Ошибки шаблонов разделов', 'все страницы одного раздела — исправляется в шаблоне или общем блоке раздела'],
    page: ['Ошибки отдельных страниц', 'исправляется на конкретной странице'],
  }
  return ['global', 'template', 'page'].filter(k => buckets.has(k)).map(k => ({
    key: k, title: TITLES[k][0], note: TITLES[k][1],
    groups: [...buckets.get(k).values()].map(g => ({ ...g, pages: [...g.pages] })),
  }))
}

function renderScoped(groups, totalPages, ctx) {
  return scoped(groups, totalPages).map(s =>
    `<h3>${esc(s.title)}</h3><p class="sub">${esc(s.note)}</p>${s.groups.map(g => renderGroup(g, ctx)).join('')}`).join('')
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

const REVIEW_LABEL = { confirmed: 'подтверждено', unsure: 'нужно проверить вручную', 'false-positive': 'ложное срабатывание' }

export function renderReport({
  host, env, envReason, pages, findings, diff, snapshotAgeDays, source, sitemapStatus,
  browserCoverage,
  rejected = [],
  siteSummary = null,
  visual = [],
  manualChecks = [],
}) {
  // Fail fast on malformed findings, matching the array contract rollUp/diffRuns
  // already enforce (src/report/json.js). Coercing bad input to [] here would
  // turn a caller bug or corrupted findings.json into a confident, professional
  // "Pass" report — the worst possible failure mode for a QC tool, because it
  // is indistinguishable from a genuinely clean site. A thrown TypeError is
  // impossible to miss; a false all-clear is not. No HTML is produced below
  // this check when findings is unusable.
  try { ORIGIN = new URL(`https://${host}`).origin } catch { ORIGIN = null }
  if (!Array.isArray(findings)) {
    const received = findings === null ? 'null' : findings === undefined ? 'undefined' : typeof findings
    throw new TypeError(`renderReport requires findings to be an array, got ${received}`)
  }
  const list = findings
  const solid = list.filter(f => f.confidence !== 'heuristic')
  // Static (markup) and browser (rendered page) findings are fixed by
  // different people and checked differently, so each gets its own part.
  const isBrowser = (f) => f.engine === 'browser'
  // Claude's own Playwright findings (the mobile menu) render in their block.
  const isClaude = (f) => f.engine === 'claude'
  const claudeFindings = list.filter(isClaude)
  const hasShots = (Array.isArray(visual) && visual.length > 0) || (Array.isArray(manualChecks) && manualChecks.some(m => (m.shots || []).length))
  const groups = rollUp(solid.filter(f => !isBrowser(f) && !isClaude(f)))
  const heur = rollUp(list.filter(f => f.confidence === 'heuristic' && !isBrowser(f) && !isClaude(f)))
  const bGroups = rollUp(solid.filter(isBrowser))
  const bHeur = rollUp(list.filter(f => f.confidence === 'heuristic' && isBrowser(f)))
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

    // Pages that would not open at all. "7 из 31" alone cannot distinguish a
    // page that FAILED from one that was never attempted, and those call for
    // opposite reactions: a not-yet-attempted page just needs the pass to be
    // run again, while a failed page is a page the site itself would not
    // serve. The spec requires both the count and the list to reach the
    // header, so a reader is not left inferring it from a bare fraction.
    const failedUrls = Array.isArray(browserCoverage.failedUrls) ? browserCoverage.failedUrls : []
    const pagesFailed = Number(browserCoverage.pagesFailed) || failedUrls.length
    const shownFailed = failedUrls.slice(0, PAGE_LIST_CAP)
    const hiddenFailed = failedUrls.length - shownFailed.length
    const failedHtml = pagesFailed
      ? `<div class="note-box">Не открылись при браузерной проверке: <b>${esc(pagesFailed)}</b> страниц(ы) — они проверены безуспешно, а не пропущены, и визуальные дефекты на них неизвестны.` +
        (shownFailed.length
          ? `<ul>${shownFailed.map(x => {
              const url = typeof x === 'string' ? x : (x && x.url) || ''
              const err = typeof x === 'string' ? '' : (x && x.error) || ''
              return `<li>${rich(url)}${err ? ` — ${esc(err)}` : ''}</li>`
            }).join('')}${hiddenFailed > 0 ? `<li>…и ещё ${esc(hiddenFailed)}</li>` : ''}</ul>`
          : '') +
        ` Повторный запуск <code>qc browse ${esc(host)}</code> пробует их снова — <code>--force</code> для этого не нужен.</div>`
      : ''

    // Widths the breakpoint budget excluded. `dropped` already reaches
    // browse's stdout and the snapshot meta; the spec says explicitly that
    // excluded widths are listed in the REPORT rather than swallowed, and it
    // never was -- so a reader could not tell that e.g. 1200 (the Bootstrap
    // and Elementor desktop boundary) was never measured at all.
    const droppedWidths = Array.isArray(browserCoverage.droppedWidths) ? browserCoverage.droppedWidths : []
    const droppedHtml = droppedWidths.length
      ? `<div class="note-box">Ширины, не вошедшие в проверку из-за лимита (${esc(droppedWidths.length)}): <code>${droppedWidths.map(esc).join(', ')}</code>. Дефекты, которые проявляются только на этих ширинах, не измерялись. Чтобы проверить любую из них, запустите <code>qc browse ${esc(host)} --breakpoints ${esc(droppedWidths.join(','))} --force</code>.</div>`
      : ''

    browserCoverageHtml = `<p class="sub">браузерная проверка: ${esc(pagesDone)} из ${esc(pagesTotal)} страниц` +
      (pagesFailed ? ` · не открылись: ${esc(pagesFailed)}` : '') +
      (widths.length ? ` · ширины: ${widths.map(esc).join(', ')}` : '') +
      (droppedWidths.length ? ` · исключённые ширины: ${droppedWidths.map(esc).join(', ')}` : '') + `</p>` +
      // Rows older than this crawl were dropped by audit (cli.js); saying
      // "partial, resume" would hide that the whole pass is out of date.
      (Number(browserCoverage.stalePages) > 0
        ? `<div class="note-box">Браузерная проверка устарела для ${esc(browserCoverage.stalePages)} стр.: они проверялись до этого обхода, их находки в отчёт не вошли. Запустите <code>qc browse ${esc(host)}</code> заново.</div>`
        : '') +
      (!complete && !(Number(browserCoverage.stalePages) > 0 && pagesDone === 0)
        ? `<div class="note-box">Браузерная проверка выполнена частично: проверено ${esc(pagesDone)} из ${esc(pagesTotal)} страниц. Визуальные дефекты на остальных страницах могли остаться незамеченными. Запустите <code>qc browse ${esc(host)}</code> ещё раз, чтобы продолжить — прогон возобновляемый: уже проверенные страницы не начинаются заново, а те, что не открылись, пробуются снова.</div>`
        : '') +
      failedHtml + droppedHtml
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
      ? renderScoped(groups, pages, ctx)
      : '<p class="sub">Нарушений не найдено — сайт прошёл проверку без замечаний.</p>'
    const heurHtml = heur.length
      ? `<h2>Требует взгляда (неподтверждённые эвристики)</h2>
<div class="note-box heuristic">Ниже — находки эвристических правил: возможны ложные срабатывания, они <b>не учитываются</b> в вердикте и в плитках серьёзности выше. Проверьте вручную перед тем, как заводить задачу.</div>
${renderScoped(heur, pages, ctx)}`
      : ''
    const widthsLabel = Array.isArray(browserCoverage?.widths) && browserCoverage.widths.length ? ` · ширины ${browserCoverage.widths.join(', ')} px и ресайз 1920→320` : ''
    const browserHtml = !browserCoverage && !bGroups.length && !bHeur.length
      ? `<h2>Браузерная проверка</h2><p class="sub">Не выполнялась — визуальные дефекты не проверены.</p>`
      : `<h2>Браузерная проверка (вёрстка, адаптив, интерактив${esc(widthsLabel)})</h2>
${bGroups.length ? renderScoped(bGroups, pages, ctx) : '<p class="sub">Подтверждённых визуальных дефектов нет.</p>'}
${bHeur.length ? `<h3>Требует взгляда</h3><div class="note-box heuristic">Эвристики браузерной проверки — не учитываются в вердикте.</div>${renderScoped(bHeur, pages, ctx)}` : ''}`
    const rejectedGroups = rollUp(rejected)
    const rejectedHtml = rejectedGroups.length
      ? `<h2>Отклонено при ревью Claude</h2>
<div class="note-box heuristic">Claude проверил эти находки и счёл их ложными срабатываниями. Они не учитываются в вердикте и плитках; причина указана у каждой.</div>
${rejectedGroups.map(g => renderGroup(g, ctx)).join('')}`
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
${siteSummary ? `<div class="note-box heuristic"><b>О сайте:</b> ${esc(siteSummary)}</div>` : ''}
${snapshotAgeDays > STALENESS_WARNING_DAYS ? `<div class="note-box">Снапшоту больше ${esc(STALENESS_WARNING_DAYS)} дней — данные могли устареть. Перезапустите с <code>--fresh</code>.</div>` : ''}
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
<h2>Статическая проверка (HTML, ссылки, SEO, контент)</h2>
${groupsHtml}
${heurHtml}
${browserHtml}
${renderManual(manualChecks, claudeFindings)}
${renderVisual(visual)}
${rejectedHtml}
<h2>Страницы</h2>
${uniquePages.length ? `<div class="scroll"><table><tr><th>Страница</th><th>Находок</th></tr>
${shownPages.map(p =>
  `<tr><td>${rich(p)}</td><td>${list.filter(f => f.page === p).length}</td></tr>`).join('')}
</table></div>
${hiddenPageCount > 0 ? `<p class="kv">…и ещё ${hiddenPageCount} страниц не показано (ограничение индекса)</p>` : ''}` : '<p class="sub">Нет страниц с находками.</p>'}
</div>${hasShots ? LIGHTBOX : ''}</body></html>`
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
