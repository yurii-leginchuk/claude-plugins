import { spotText } from '../browser/evidence.js'
import { rollUp, verdict, countDistinct, defectIdentity } from './json.js'
import { STALENESS_WARNING_DAYS } from '../lib/snapshot-ttl.js'
import { UNNAMED_REGION_PREFIX } from '../browser/regions.js'
import { TYPE_ORDER, TYPE_LABEL } from '../lib/page-type.js'
import { categoryOf } from './category.js'

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
.look{font-size:15px;overflow-wrap:anywhere}
.defect img[alt=""]{border:1px solid var(--line);border-radius:6px;max-width:min(100%,760px)!important}
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
.did{display:inline-block;font:700 14px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 9px;border-radius:6px;text-decoration:none!important;background:var(--fg);color:var(--bg);letter-spacing:.02em}
.did:hover{background:var(--maj)}
.cat{display:inline-block;font:700 11px/1.4 ui-sans-serif,-apple-system,sans-serif;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:999px;border:1px solid currentColor;vertical-align:middle}
.cat-dev{color:#2f6db5}.cat-seo{color:#8a4fbf}.cat-copy{color:#b7621b}
/* Team split (dev/seo/copy) hidden for now; the data is still in the report. */
.catbar,.cat{display:none!important}
.catbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0}
.catbar button{font:inherit;font-size:13px;padding:4px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg);cursor:pointer}
.catbar button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.catbar .n{opacity:.65}
.ids{display:flex;flex-wrap:wrap;gap:4px;flex-basis:100%;order:9}
.ids .did{font-size:12px;padding:1px 6px}
.flash{outline:2px solid var(--maj);outline-offset:6px;border-radius:4px}
.find{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0 4px;font-size:13px}
.find input{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);width:12em;max-width:100%}
.find button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);cursor:pointer}
.find input:focus-visible,.find button:focus-visible{outline:2px solid var(--maj);outline-offset:1px}
.find .sub{margin:0}
.wrap a{color:inherit;text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px}
.wrap a:hover{text-decoration-thickness:2px}
.vis-page{border-top:1px solid var(--line);padding:12px 0}
.vis-page .kv{margin:0 0 8px}
.strip{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;align-items:flex-start}
.thumb{flex:none;margin:0;font-size:12px;color:var(--mut);text-align:center}
.shot-view{height:420px;overflow-y:auto;overflow-x:hidden;border:1px solid var(--line);border-radius:6px;background:var(--card);overscroll-behavior:contain}
.shot-view:focus-visible{outline:2px solid var(--maj);outline-offset:2px}
.shot-view img{display:block;width:100%;height:auto}
.thumb figcaption button{font:inherit;color:var(--mut);background:none;border:0;padding:4px 2px;cursor:zoom-in;text-decoration:underline;text-underline-offset:2px}
.thumb figcaption button:focus-visible{outline:2px solid var(--maj);outline-offset:1px}
.menu-row{border-top:1px solid var(--line);padding:12px 0}
.steps{margin:6px 0 10px;padding-left:22px}.steps li{margin:3px 0;overflow-wrap:anywhere}
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
// A scrollable window onto a full-page picture; the windows of one row scroll
// together (by the share scrolled, since the phone page is taller). The
// caption opens the picture full size.
const thumb = (src, label, w) => `<figure class="thumb" style="width:${thumbWidth(w)}px"><div class="shot-view" tabindex="0" role="region" aria-label="${esc(label)}, scroll"><img loading="lazy" src="${esc(src)}" alt="${esc(label)}"></div><figcaption><button type="button" data-full="${esc(src)}" data-label="${esc(label)}">${esc(label)} ↗</button></figcaption></figure>`

// Every page at every width, defects or not -- what QA scrolls through by eye.
// Folded, grouped by page type (each group folded too), with a filter by URL
// or title; a closed group loads none of its pictures.
function renderVisual(visual) {
  if (!Array.isArray(visual) || !visual.length) {
    return '<h2>Visual check</h2><p class="sub">No page screenshots: the browser pass did not capture any pages (run <code>qc browse</code> with this version).</p>'
  }
  const groups = new Map()
  for (const v of visual) {
    const t = TYPE_LABEL[v.type] ? v.type : 'other'
    if (!groups.has(t)) groups.set(t, [])
    groups.get(t).push(v)
  }
  const ordered = TYPE_ORDER.filter(t => groups.has(t))
  const shots = visual.reduce((n, v) => n + v.shots.length, 0)
  const page = (v) => `<div class="vis-page" data-find="${esc(`${v.url} ${v.title || ''}`.toLowerCase())}"><p class="kv">${rich(v.url)}${v.title ? ` <span class="sub">${esc(v.title)}</span>` : ''}</p><div class="strip">${v.shots.map(s =>
    thumb(s.src, `${s.width} px${s.cut ? ' (cut)' : ''}`, s.width)).join('')}</div></div>`
  return `<h2>Visual check</h2>
<div class="find"><label for="qc-page-find">Find a page</label><input id="qc-page-find" name="qc-page-find" type="search" placeholder="part of the URL or title" autocomplete="off" spellcheck="false"><span id="qc-page-msg" class="sub" aria-live="polite"></span></div>
<details class="rule vis" id="qc-visual"><summary><b>Every page at every width</b><span class="cnt">${visual.length} pages · ${shots} screenshots</span></summary><div class="body">
<p class="sub">Full-page screenshots at every width, including pages with no defects, so you can scroll through the site by eye. The windows of one page scroll together; the caption under a window opens it at full size.</p>
${ordered.map(t => `<details class="rule vis-group" data-type="${esc(t)}"><summary><b>${esc(TYPE_LABEL[t])}</b><span class="cnt">${groups.get(t).length} pages</span></summary><div class="body">${groups.get(t).map(page).join('')}</div></details>`).join('')}
</div></details>`
}

const MANUAL_STATUS = { ok: ['ok', 'ok'], defect: ['crit', 'defects found'], skipped: ['note', 'not checked'] }
const MANUAL_SECTIONS = [
  ['menu', 'Mobile menu', 'does the burger open, full width, nothing past the edge, all items visible, submenus expand, it closes, links match the desktop menu'],
  ['popup', 'Popups', 'opens from its button, fits the screen, closes with the X, a click outside and Esc'],
  ['form', 'Forms', 'required fields and *, error texts, phone mask, button after an error, mobile layout (not submitted)'],
  ['faq', 'FAQ and accordions', 'the right item opens, the layout does not break'],
  ['focus', 'Keyboard focus', 'focus is visible on Tab, reaches the menu, buttons and forms, no focus traps'],
  ['content', 'Contradictions in the text', 'timelines, numbers, hours, prices and promises that differ between pages'],
  ['visual', 'Screenshots looked at by Claude', 'pages of every template at every width: text past its box, overlaps, cut or empty blocks, broken grids, images'],
]

// One block per defect, with every page it names (a content defect spans several).
function defectsOf(m, claudeFindings) {
  const defs = []
  for (const f of claudeFindings.filter(f => (m.index != null ? f.manual === m.index : f.check === m.check && f.page === m.page && (f.breakpoint ?? null) === (m.width ?? null)))) {
    const d = defs.find(x => x.rule === f.rule && x.found === f.found)
    if (d) d.pages.push(f.page)
    else defs.push({ ...f, pages: [f.page] })
  }
  return defs
}

const manualDefect = (f) => `<div class="defect"${f.id ? ` id="${esc(f.id)}"` : ''} data-cat="${esc(categoryOf(f))}"><p class="kv">${f.id ? `<a class="did" href="#${esc(f.id)}">${esc(f.id)}</a> ` : ''}<span class="cat cat-${esc(categoryOf(f))}">${esc(categoryOf(f))}</span> <span class="chip ${CHIP[f.severity] || 'note'}">${esc(f.severity)}</span> ${esc(f.rule)} · ${esc(f.title)}${f.confidence === 'heuristic' ? ' <span class="chip note">not repeated by the second check</span>' : ''}</p><p class="kv"><b>Problem:</b> ${rich(f.found)}</p>${f.where ? `<p class="kv">where: ${rich(f.where)}</p>` : ''}<p class="kv"><b>Fix:</b> ${rich(f.expected)}</p>${f.pages.length > 1 ? `<ul class="pages">${f.pages.map(p => `<li>${rich(p)}</li>`).join('')}</ul>` : ''}</div>`

const JOURNEY_STATUS = { ok: ['ok', 'done'], defect: ['crit', 'had problems'], skipped: ['note', 'not done'] }

// The visitor's tasks Claude did end to end (find a price, book, buy, call):
// the first thing the report shows, since one that fails costs leads.
function renderJourneys(manualChecks, claudeFindings) {
  const js = (Array.isArray(manualChecks) ? manualChecks : []).filter(m => m.check === 'journey')
  if (!js.length) return ''
  const done = js.filter(m => m.status === 'ok').length
  return `<h2>Visitor journeys</h2>
<div class="note-box heuristic">Claude did what a visitor comes to do, step by step, at a phone and a desktop width: ${done} of ${js.length} went through without problems.</div>
${js.map(m => {
    const [cls, label] = JOURNEY_STATUS[m.status] || JOURNEY_STATUS.skipped
    const defs = defectsOf(m, claudeFindings)
    return `<details class="rule journey"${m.status === 'ok' ? '' : ' open'}><summary><span class="chip ${cls}">${esc(label)}</span> <b>${esc(m.title)}</b><span class="cnt">${m.width != null ? `${esc(m.width)} px · ` : ''}${m.steps.length} steps · ${defs.length} defects</span></summary><div class="body">
<p class="kv">start: ${rich(m.page)}</p>
<ol class="steps">${m.steps.map(s => `<li>${rich(s)}</li>`).join('')}</ol>
${m.checked ? `<p class="kv">${rich(m.checked)}</p>` : ''}
${defs.map(manualDefect).join('')}
${(m.shots || []).length ? `<div class="strip">${m.shots.map((src, i) => thumb(src, `${m.width != null ? `${m.width} px · ` : ''}step ${i + 1}`, m.width || 768)).join('')}</div>` : ''}</div></details>`
  }).join('')}`
}

// What Claude checked by hand (Playwright, or reading the pages for
// `content`); the engine only renders what Claude recorded.
function renderManual(manualChecks, claudeFindings) {
  const checks = Array.isArray(manualChecks) ? manualChecks : []
  const done = MANUAL_SECTIONS.filter(([k]) => checks.some(c => c.check === k))
  const missing = MANUAL_SECTIONS.filter(([k]) => !checks.some(c => c.check === k))
  const head = `<h2>Claude’s manual checks (Playwright and reading the pages)</h2>
<div class="note-box heuristic">These are things the engine cannot do: click, hover, Tab through, understand what the text means. Claude checked them by hand; the defects found count toward the verdict.</div>`
  const body = done.map(([k, title, what]) => {
    const rows = checks.filter(c => c.check === k)
    const nDefects = new Set(claudeFindings.filter(f => f.check === k).map(f => f.id || `${f.rule}|${f.found}`)).size
    return `<details class="rule"><summary><span class="chip ${nDefects ? 'crit' : 'ok'}">${nDefects ? 'defects found' : 'ok'}</span> <b>${esc(title)}</b><span class="cnt">${rows.length} checks · ${nDefects} defects</span></summary><div class="body"><p class="sub">${esc(what)}</p>${rows.map(m => {
    const [cls, label] = MANUAL_STATUS[m.status] || MANUAL_STATUS.skipped
    const defs = defectsOf(m, claudeFindings)
    return `<div class="menu-row"><p class="kv"><span class="chip ${cls}">${esc(label)}</span>${m.width != null ? ` <b>${esc(m.width)} px</b> ·` : ''} ${rich(m.page)}</p>
${m.checked ? `<p class="kv">${rich(m.checked)}</p>` : ''}
${defs.map(manualDefect).join('')}
${(m.shots || []).length ? `<div class="strip">${m.shots.map((src, i) => thumb(src, `${m.width != null ? `${m.width} px · ` : ''}${i + 1}`, m.width || 768)).join('')}</div>` : ''}</div>`
  }).join('')}</div></details>`
  }).join('')
  const rest = missing.length ? `<p class="sub">Not checked by hand: ${missing.map(([, t]) => esc(t)).join(', ')}.</p>` : ''
  return head + body + rest
}

// Find a defect by its id: opens the collapsed groups around it and scrolls to it;
// a link to «#D12» does the same on load.
const FIND = `<script>(()=>{const msg=document.getElementById('qc-find-msg');
function go(raw,quiet){const id=String(raw||'').trim().toUpperCase().replace(/^#/,'');if(!id)return;const el=document.getElementById(id);
if(!el||!/^[DM]\\d+$/.test(id)){if(!quiet&&msg)msg.textContent='No defect '+id+' in this report';return}
for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;
el.scrollIntoView({block:'center'});el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');if(msg)msg.textContent=''}
const f=document.getElementById('qc-find-form');if(f)f.addEventListener('submit',e=>{e.preventDefault();go(document.getElementById('qc-find').value)});
document.addEventListener('click',e=>{const a=e.target.closest('a.did');if(a){e.preventDefault();go(a.getAttribute('href'),true)}});
if(location.hash)go(location.hash,true);
document.querySelectorAll('[data-cat-filter]').forEach(b=>b.addEventListener('click',()=>{const c=b.dataset.catFilter;
document.querySelectorAll('[data-cat-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
document.querySelectorAll('.defect[data-cat]').forEach(d=>{d.hidden=c!=='all'&&d.dataset.cat!==c});
document.querySelectorAll('details.rule').forEach(g=>{const ds=g.querySelectorAll('.defect[data-cat]');if(!ds.length)return;const any=[...ds].some(d=>!d.hidden);g.hidden=!any;if(c!=='all'&&any)g.open=true})}));
const pf=document.getElementById('qc-page-find'),pm=document.getElementById('qc-page-msg');
if(pf)pf.addEventListener('input',()=>{const q=pf.value.trim().toLowerCase();let n=0;const vb=document.getElementById('qc-visual');if(q&&vb)vb.open=true;
document.querySelectorAll('.vis-group').forEach(g=>{let hit=0;g.querySelectorAll('.vis-page').forEach(p=>{const ok=!q||p.dataset.find.includes(q);p.hidden=!ok;if(ok)hit++});
g.hidden=q&&!hit;if(q)g.open=hit>0&&hit<=12;n+=hit});if(pm)pm.textContent=q?(n?'pages: '+n:'nothing found'):''})})()</script>`

const LIGHTBOX = `<dialog class="lb" id="qc-lb"><div class="bar"><span id="qc-lb-t"></span><button type="button" id="qc-lb-x">Close</button></div><img id="qc-lb-i" alt=""></dialog>
<script>(()=>{const d=document.getElementById('qc-lb');if(!d||!d.showModal)return;const i=document.getElementById('qc-lb-i'),t=document.getElementById('qc-lb-t');
document.addEventListener('click',e=>{const b=e.target.closest('[data-full]');if(!b)return;i.src=b.dataset.full;i.alt=b.dataset.label;t.textContent=b.dataset.label;d.showModal()});
document.getElementById('qc-lb-x').onclick=()=>d.close();d.addEventListener('click',e=>{if(e.target===d)d.close()})})();
(()=>{let active=null;const grab=e=>{const v=e.target.closest&&e.target.closest('.shot-view');if(v)active=v};
['wheel','touchstart','pointerdown','keydown','focusin'].forEach(t=>document.addEventListener(t,grab,{capture:true,passive:true}));
document.addEventListener('scroll',e=>{const v=e.target;if(v!==active)return;const strip=v.closest('.strip');if(!strip)return;
const max=v.scrollHeight-v.clientHeight;const k=max>0?v.scrollTop/max:0;
strip.querySelectorAll('.shot-view').forEach(o=>{if(o!==v)o.scrollTop=k*(o.scrollHeight-o.clientHeight)})},true)})()</script>`

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
    ? `<div class="kv">breakpoints: <code>${[...bps].sort((a, b) => a - b).map(esc).join(', ')}</code></div>`
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
  // label read "region: 3381" rather than "footer", because that snapshot was
  // crawled before the parser recorded `locationsById` and nothing detected a
  // snapshot whose shape predates a parser change. The finding is still
  // correct and still collapses across pages; only the name is missing, and
  // re-crawling is what supplies it.
  const region = d.example?.region ?? null
  const unnamedRegion = typeof region === 'string' && region.startsWith(UNNAMED_REGION_PREFIX)
  const regionHtml = region
    ? (unnamedRegion
        ? `<div class="kv">region: shared Elementor container <code>${esc(region.slice(UNNAMED_REGION_PREFIX.length))}</code> (its name, header or footer, could not be determined: the snapshot was taken before the parser started saving locations; rebuild it with <code>--fresh</code>). Shared by every occurrence below, so fix it once</div>`
        : `<div class="kv">region: <code>${esc(region)}</code>. Shared by every occurrence below, so fix it once</div>`)
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
        ? `<div class="kv sub">screenshot hidden: the report went over the size limit (see the warning above)</div>`
        : `<div class="kv"><img src="${esc(shotDataUri)}" alt="" style="max-width:100%">` +
          (shotWidth != null ? `<div class="sub">screenshot taken at ${esc(shotWidth)}px wide</div>` : '') +
          `</div>`)
    : ''

  const did = ctx.ids?.[d.identity]
  const cat = categoryOf(d.example || d)
  return `
      <div class="defect"${did ? ` id="${esc(did)}"` : ''} data-cat="${esc(cat)}">
        <div class="kv">${did ? `<a class="did" href="#${esc(did)}">${esc(did)}</a> ` : ''}<span class="cat cat-${esc(cat)}">${esc(cat)}</span></div>
        ${d.example?.review ? `<div class="kv review review-${esc(d.example.review.verdict)}">Claude: ${esc(REVIEW_LABEL[d.example.review.verdict] || d.example.review.verdict)}${d.example.review.note ? ` — ${rich(d.example.review.note)}` : ''}</div>` : ''}
        ${String(d.scope || '').startsWith('template:') ? `<div class="kv">section: <code>${esc(d.scope.slice(9))}</code></div>` : ''}
        ${d.example?.spot ? `<div class="kv look"><b>Where to look:</b> ${esc(spotText(d.example.spot, shotWidth))}${shownPages[0] ? ` on ${rich(shownPages[0])}` : ''}</div>` : ''}
        ${shotHtml}
        <div class="kv"><b>Problem:</b> ${rich(d.found)}</div>
        ${d.expected ? `<div class="kv"><b>Fix:</b> ${rich(d.expected)}</div>` : ''}
        <div class="kv sub">selector: <code>${esc(d.selector)}</code></div>
        ${breakpointsHtml}
        ${regionHtml}
        <ul class="pages">${shownPages.map(p => `<li>${rich(p)}${d.where?.[p] ? `<div class="where">${rich(d.where[p])}</div>` : ''}</li>`).join('')}</ul>
        ${hiddenCount > 0 ? `<p class="kv">…and ${hiddenCount} more pages not shown (list limit)</p>` : ''}
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
    global: ['Site-wide', 'header, menu, footer or every page of the site: fix once in the shared template'],
    template: ['Template', 'every page of one section: fix in the section’s template or shared block'],
    page: ['Single pages', 'fix on the page itself'],
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
      <span class="cnt">${defects.length} defects · ${g.pages.length} pages · ${g.count} findings</span>
      ${(() => { const ids = shown.map(d => ctx.ids?.[d.identity]).filter(Boolean); return ids.length ? `<span class="ids">${ids.map(id => `<a class="did" href="#${esc(id)}">${esc(id)}</a>`).join('')}</span>` : '' })()}
    </summary>
    <div class="body">
      ${shown.map(d => renderDefect(d, { ...ctx, severity: g.severity })).join('')}
      ${hiddenDefects > 0 ? `<p class="kv">…and ${hiddenDefects} more defects not shown (list limit)</p>` : ''}
    </div>
  </details>`
}

const REVIEW_LABEL = { confirmed: 'confirmed', unsure: 'needs a manual check', 'false-positive': 'false positive' }

export function renderReport({
  host, env, envReason, pages, findings, diff, snapshotAgeDays, source, sitemapStatus,
  browserCoverage,
  rejected = [],
  siteSummary = null,
  unjudged = 0,
  // the screen pieces Claude looked at in the visual review: {total, seen, unseenPages, missing}
  tiles = null,
  visual = [],
  manualChecks = [],
  // identity -> «D12», the same ids `qc findings` prints
  ids = null,
  // when the audit ran (ms); shown next to the domain
  ranAt = null,
}) {
  // Fail fast on malformed findings, matching the array contract rollUp/diffRuns
  // already enforce (src/report/json.js). Coercing bad input to [] here would
  // turn a caller bug or corrupted findings.json into a confident, professional
  // "Pass" report — the worst possible failure mode for a QC tool, because it
  // is indistinguishable from a genuinely clean site. A thrown TypeError is
  // impossible to miss; a false all-clear is not. No HTML is produced below
  // this check when findings is unusable.
  try { ORIGIN = new URL(`https://${host}`).origin } catch { ORIGIN = null }
  const qcDate = Number.isFinite(ranAt) ? new Date(ranAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null
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
    ? 'fresh'
    : `${Number(snapshotAgeDays).toFixed(0)} days`

  // The severity tiles count raw occurrences, which is what made the report
  // lead with "Major 56" -- the exact number this engine's distinct/occurrence
  // split exists to stop anyone quoting. `distinct` was computed in cli.js and
  // never rendered, so the word never appeared in the HTML at all. It leads the
  // tile row now, with occurrences kept beside it as blast radius.
  const distinct = countDistinct(solid)
  // Distinct counted defects per team, for the filter bar; they add up to the headline.
  const byCat = { dev: 0, seo: 0, copy: 0 }
  for (const id of new Set(solid.map(f => defectIdentity(f) + '|' + categoryOf(f)))) byCat[id.split('|').pop()]++
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
    browserCoverageHtml = `<div class="note-box">The browser pass did not run: this report is based on static HTML analysis only. Visual and interactive defects (overflow, overlapping elements, hover/focus, console errors, screenshots) were not checked. Run <code>qc browse ${esc(host)}</code> to complete the report.</div>`
  } else {
    const pagesDone = Number(browserCoverage.pagesDone) || 0
    const pagesTotal = Number(browserCoverage.pagesTotal) || 0
    const widths = Array.isArray(browserCoverage.widths) ? browserCoverage.widths : []
    const complete = pagesTotal > 0 && pagesDone >= pagesTotal

    // Pages that would not open at all. "7 of 31" alone cannot distinguish a
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
      ? `<div class="note-box">Did not open in the browser pass: <b>${esc(pagesFailed)}</b> page(s). They were attempted and failed, not skipped, and their visual defects are unknown.` +
        (shownFailed.length
          ? `<ul>${shownFailed.map(x => {
              const url = typeof x === 'string' ? x : (x && x.url) || ''
              const err = typeof x === 'string' ? '' : (x && x.error) || ''
              return `<li>${rich(url)}${err ? ` — ${esc(err)}` : ''}</li>`
            }).join('')}${hiddenFailed > 0 ? `<li>…and ${esc(hiddenFailed)} more</li>` : ''}</ul>`
          : '') +
        ` Running <code>qc browse ${esc(host)}</code> again retries them; <code>--force</code> is not needed for that.</div>`
      : ''

    // Widths the breakpoint budget excluded. `dropped` already reaches
    // browse's stdout and the snapshot meta; the spec says explicitly that
    // excluded widths are listed in the REPORT rather than swallowed, and it
    // never was -- so a reader could not tell that e.g. 1200 (the Bootstrap
    // and Elementor desktop boundary) was never measured at all.
    const droppedWidths = Array.isArray(browserCoverage.droppedWidths) ? browserCoverage.droppedWidths : []
    const droppedHtml = droppedWidths.length
      ? `<div class="note-box">Widths left out of the check by the limit (${esc(droppedWidths.length)}): <code>${droppedWidths.map(esc).join(', ')}</code>. Defects that show only at these widths were not measured. To check any of them, run <code>qc browse ${esc(host)} --breakpoints ${esc(droppedWidths.join(','))} --force</code>.</div>`
      : ''

    browserCoverageHtml = `<p class="sub">browser pass: ${esc(pagesDone)} of ${esc(pagesTotal)} pages` +
      (pagesFailed ? ` · did not open: ${esc(pagesFailed)}` : '') +
      (widths.length ? ` · widths: ${widths.map(esc).join(', ')}` : '') +
      (droppedWidths.length ? ` · excluded widths: ${droppedWidths.map(esc).join(', ')}` : '') + `</p>` +
      // Rows older than this crawl were dropped by audit (cli.js); saying
      // "partial, resume" would hide that the whole pass is out of date.
      (Number(browserCoverage.stalePages) > 0
        ? `<div class="note-box">The browser pass is out of date for ${esc(browserCoverage.stalePages)} pages: they were checked before this crawl, so their findings are not in the report. Run <code>qc browse ${esc(host)}</code> again.</div>`
        : '') +
      (!complete && !(Number(browserCoverage.stalePages) > 0 && pagesDone === 0)
        ? `<div class="note-box">The browser pass is partial: ${esc(pagesDone)} of ${esc(pagesTotal)} pages checked. Visual defects on the other pages may have gone unnoticed. Run <code>qc browse ${esc(host)}</code> again to continue. The run resumes: pages already checked are not started over, and pages that did not open are retried.</div>`
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
    const ctx = { breakpointsByIdentity, suppressedShots: suppressedShots ?? new Set(), candidates, ids }
    const groupsHtml = groups.length
      ? renderScoped(groups, pages, ctx)
      : '<p class="sub">No violations found: the site passed the check with no remarks.</p>'
    const heurHtml = heur.length
      ? `<h2>Needs a look (unconfirmed heuristics)</h2>
<div class="note-box heuristic">Below are findings from heuristic rules. They may be false positives and <b>do not count</b> toward the verdict or the severity tiles above. Check by hand before filing a task.</div>
${renderScoped(heur, pages, ctx)}`
      : ''
    const widthsLabel = Array.isArray(browserCoverage?.widths) && browserCoverage.widths.length ? ` · widths ${browserCoverage.widths.join(', ')} px and resize 1920→320` : ''
    const browserHtml = !browserCoverage && !bGroups.length && !bHeur.length
      ? `<h2>Browser pass</h2><p class="sub">Did not run: visual defects were not checked.</p>`
      : `<h2>Browser pass (layout, responsive, interactive${esc(widthsLabel)})</h2>
${bGroups.length ? renderScoped(bGroups, pages, ctx) : '<p class="sub">No confirmed visual defects.</p>'}
${bHeur.length ? `<h3>Needs a look</h3><div class="note-box heuristic">Browser pass heuristics: they do not count toward the verdict.</div>${renderScoped(bHeur, pages, ctx)}` : ''}`

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QC ${esc(host)}${qcDate ? ` ${esc(qcDate)}` : ''}</title><style>${CSS}</style></head><body><div class="wrap">
<h1>QC · ${esc(host)}${qcDate ? ` · ${esc(qcDate)}` : ''}</h1>
<p class="sub">environment: <b>${esc(env)}</b>${envReason ? ` (${esc(envReason)})` : ''} ·
pages: ${esc(pages)} · page list source: ${esc(source)} ·
snapshot: ${ageLabel}</p>
<p><span class="verdict ${vClass}">${esc(v)}</span></p>
${siteSummary ? `<div class="note-box heuristic"><b>About the site:</b> ${esc(siteSummary)}</div>` : ''}
${unjudged ? `<div class="note-box heuristic">${unjudged} ${unjudged === 1 ? 'candidate' : 'candidates'} the scripts could not decide on their own (judgement rules, clicks and console errors, heuristics) were not checked by Claude and are not shown: they are defects only once Claude confirms them.</div>` : ''}
${tiles && (tiles.seen < tiles.total || tiles.missing) ? `<div class="note-box">Claude’s look at the screenshots covered ${tiles.seen} of ${tiles.total} screen pieces${tiles.unseenPages ? ` (${tiles.unseenPages} pages not fully looked at)` : ''}${tiles.missing ? `; ${tiles.missing} page widths have no pieces at all` : ''}: small visual defects there may be missed.</div>` : ''}
${snapshotAgeDays > STALENESS_WARNING_DAYS ? `<div class="note-box">The snapshot is more than ${esc(STALENESS_WARNING_DAYS)} days old, so the data may be out of date. Run again with <code>--fresh</code>.</div>` : ''}
${sitemapWarning ? `<div class="note-box">Sitemap: <b>${esc(sitemapStatus)}</b>. The page list may be incomplete, so some of the site’s pages may be missing from the report.</div>` : ''}
${browserCoverageHtml}
${suppressedShots && suppressedShots.size ? `<div class="note-box">Some screenshots are hidden to fit the publish size limit: ${esc(suppressedShots.size)} screenshot(s) not shown (removal order: note first, then minor, major and, if needed, critical). The defects and their details (found/expected/selector/pages) are all still below; only the images are hidden.</div>` : ''}
${oversizeBytes != null ? `<div class="note-box">The report is over the recommended publish size limit (~${esc((oversizeBytes / (1024 * 1024)).toFixed(1))} MB of ${esc(PUBLISH_BYTE_LIMIT / (1024 * 1024))} MB), even after hiding every screenshot that could be hidden. Publishing it as an Artifact may fail because of the file size. The findings in this file are intact; this is a warning about size, not content.</div>` : ''}
<div class="tiles">
  <div class="tile wide"><b>${distinctTotal} defects</b><span>${occurrenceTotal} occurrences on ${uniquePages.length} pages</span></div>
  <div class="tile"><b>${by('critical')}</b><span>Critical</span></div>
  <div class="tile"><b>${by('major')}</b><span>Major</span></div>
  <div class="tile"><b>${by('minor')}</b><span>Minor</span></div>
  <div class="tile"><b>${diff?.added?.length ?? 0}</b><span>new</span></div>
  <div class="tile"><b>${diff?.fixed?.length ?? 0}</b><span>fixed</span></div>
  <div class="tile"><b>${diff?.remaining?.length ?? 0}</b><span>remaining</span></div>
</div>
<form class="find" id="qc-find-form" role="search"><label for="qc-find">Find a defect by id</label>
<input id="qc-find" name="qc-find" placeholder="D12 or M3" autocomplete="off" spellcheck="false">
<button type="submit">Find</button><span id="qc-find-msg" class="sub" aria-live="polite"></span></form>
<div class="catbar" role="group" aria-label="Who fixes it">${['all', 'dev', 'seo', 'copy'].map(c => `<button type="button" data-cat-filter="${c}" aria-pressed="${c === 'all'}">${c === 'all' ? 'All' : c} <span class="n">${c === 'all' ? byCat.dev + byCat.seo + byCat.copy : byCat[c]}</span></button>`).join('')}<span class="sub">dev — a developer fixes it alone · seo — needs the SEO team · copy — needs the copy team</span></div>
<p class="sub">Defects by severity: ${distinct.critical} critical · ${distinct.major} major · ${distinct.minor} minor · ${distinct.note} note. This is the number of real tasks to fix.
The Critical/Major/Minor tiles above count occurrences (one fix can close several at once).</p>
${renderJourneys(manualChecks, claudeFindings)}
<h2>Static check (HTML, links, SEO, content)</h2>
${groupsHtml}
${heurHtml}
${browserHtml}
${renderManual(manualChecks, claudeFindings)}
${renderVisual(visual)}
<h2>Pages</h2>
${uniquePages.length ? `<div class="scroll"><table><tr><th>Page</th><th>Findings</th></tr>
${shownPages.map(p =>
  `<tr><td>${rich(p)}</td><td>${list.filter(f => f.page === p).length}</td></tr>`).join('')}
</table></div>
${hiddenPageCount > 0 ? `<p class="kv">…and ${hiddenPageCount} more pages not shown (index limit)</p>` : ''}` : '<p class="sub">No pages with findings.</p>'}
</div>${hasShots ? LIGHTBOX : ''}${FIND}</body></html>`
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
