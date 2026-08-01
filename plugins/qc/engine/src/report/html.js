import { rollUp, verdict } from './json.js'

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
.rule{border:1px solid var(--line);border-radius:10px;margin:10px 0;background:var(--card)}
.rule>summary{cursor:pointer;padding:12px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.chip{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
padding:2px 8px;border-radius:6px;border:1px solid currentColor}
.chip.crit{color:var(--crit)}.chip.maj{color:var(--maj)}.chip.min{color:var(--min)}.chip.note{color:var(--note)}
.cnt{margin-left:auto;color:var(--mut);font-size:13px}
.body{padding:0 14px 14px;font-size:14px}
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

function renderGroup(g) {
  const shownPages = g.pages.slice(0, PAGE_LIST_CAP)
  const hiddenCount = g.pages.length - shownPages.length
  return `
  <details class="rule">
    <summary>
      <span class="chip ${CHIP[g.severity] ?? 'note'}">${esc(LABEL[g.severity] ?? g.severity)}</span>
      <b>${esc(g.rule)}</b> · ${esc(g.title)}
      <span class="cnt">${g.pages.length} страниц · ${g.count} находок</span>
    </summary>
    <div class="body">
      <div class="kv">найдено: <code>${esc(g.example.found)}</code></div>
      ${g.example.expected ? `<div class="kv">ожидается: <code>${esc(g.example.expected)}</code></div>` : ''}
      <div class="kv">селектор: <code>${esc(g.example.selector)}</code></div>
      <ul class="pages">${shownPages.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      ${hiddenCount > 0 ? `<p class="kv">…и ещё ${hiddenCount} страниц не показано (ограничение списка)</p>` : ''}
    </div>
  </details>`
}

export function renderReport({ host, env, envReason, pages, findings, diff, snapshotAgeDays, source }) {
  const list = Array.isArray(findings) ? findings : []
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

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QC ${esc(host)}</title><style>${CSS}</style></head><body><div class="wrap">
<h1>QC · ${esc(host)}</h1>
<p class="sub">среда: <b>${esc(env)}</b>${envReason ? ` (${esc(envReason)})` : ''} ·
страниц: ${esc(pages)} · источник списка: ${esc(source)} ·
снапшот: ${ageLabel}</p>
<p><span class="verdict ${vClass}">${esc(v)}</span></p>
${snapshotAgeDays > 7 ? `<div class="note-box">Снапшот старше 7 дней — данные могли устареть. Перезапустите с <code>--fresh</code>.</div>` : ''}
<div class="tiles">
  <div class="tile"><b>${by('critical')}</b><span>Critical</span></div>
  <div class="tile"><b>${by('major')}</b><span>Major</span></div>
  <div class="tile"><b>${by('minor')}</b><span>Minor</span></div>
  <div class="tile"><b>${diff?.added?.length ?? 0}</b><span>новых</span></div>
  <div class="tile"><b>${diff?.fixed?.length ?? 0}</b><span>починено</span></div>
</div>
<h2>Находки по правилам</h2>
${groups.length ? groups.map(renderGroup).join('') : '<p class="sub">Нарушений не найдено — сайт прошёл проверку без замечаний.</p>'}
${heur.length ? `<h2>Требует взгляда (неподтверждённые эвристики)</h2>
<div class="note-box heuristic">Ниже — находки эвристических правил: возможны ложные срабатывания, они <b>не учитываются</b> в вердикте и в плитках серьёзности выше. Проверьте вручную перед тем, как заводить задачу.</div>
${heur.map(renderGroup).join('')}` : ''}
<h2>Страницы</h2>
${uniquePages.length ? `<div class="scroll"><table><tr><th>Страница</th><th>Находок</th></tr>
${shownPages.map(p =>
  `<tr><td>${esc(p)}</td><td>${list.filter(f => f.page === p).length}</td></tr>`).join('')}
</table></div>
${hiddenPageCount > 0 ? `<p class="kv">…и ещё ${hiddenPageCount} страниц не показано (ограничение индекса)</p>` : ''}` : '<p class="sub">Нет страниц с находками.</p>'}
</div></body></html>`
}
