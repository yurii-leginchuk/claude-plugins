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

// The agent's longer texts: HTML from a short list of tags and the report's
// own classes (so every report looks the same), or a small Markdown (lists,
// **bold**, `code`). Anything else in them is escaped. A long single
// paragraph with neither reads as one fact per line.
const inline = (t) => rich(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
const TAGS = new Set(['p', 'br', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'code', 'pre', 'kbd', 'mark', 'small', 'h4', 'h5', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'span', 'div', 'del', 'ins'])
export const HTML_CLASSES = ['ok', 'bad', 'warn', 'muted', 'callout', 'before', 'after', 'pair', 'steps-list', 'value']
function cleanTag(tag) {
  const m = tag.match(/^<(\/?)([a-z0-9]+)([^>]*)>$/i)
  if (!m || !TAGS.has(m[2].toLowerCase())) return esc(tag)
  const name = m[2].toLowerCase()
  if (m[1]) return `</${name}>`
  const attrs = []
  const cls = m[3].match(/\sclass\s*=\s*["']([^"']*)["']/i)
  if (cls) { const ok = cls[1].split(/\s+/).filter(c => HTML_CLASSES.includes(c)); if (ok.length) attrs.push(`class="${ok.join(' ')}"`) }
  if (name === 'a') {
    const href = m[3].match(/\shref\s*=\s*["']([^"']*)["']/i)
    if (href && /^https?:\/\//i.test(href[1])) attrs.push(`href="${esc(href[1])}" target="_blank" rel="noopener"`)
  }
  return `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
}
function html(text) {
  let out = ''
  let last = 0
  for (const m of text.matchAll(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/gi)) {
    out += inline(text.slice(last, m.index)) + cleanTag(m[0])
    last = m.index + m[0].length
  }
  // named and numeric entities (&rarr;, &#8217;) stay entities; they cannot open a tag
  return `<div class="md">${(out + inline(text.slice(last))).replace(/&amp;([a-z][a-z0-9]{1,30}|#\d{1,6}|#x[0-9a-f]{1,6});/gi, '&$1;').replace(/(<div class="(?:before|after)">)\s*(?:now|before|should be|after)\s*:\s*/gi, '$1')}</div>`
}
export function md(s) {
  let text = String(s ?? '').trim()
  if (!text) return ''
  if (/<\/?(p|ul|ol|li|b|strong|code|table|div|span|br|h4|h5|em|i|mark|kbd|pre|blockquote|small|del|ins|a)\b[^>]*>/i.test(text)) return html(text)
  if (!/\n/.test(text) && text.length > 280) text = text.split(/(?<=[.;])\s+(?=[A-Z«“"(])/).map(x => `- ${x}`).join('\n')
  return text.split(/\n\s*\n/).map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.every(l => /^[-*] /.test(l))) return `<ul class="md">${lines.map(l => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`
    if (lines.every(l => /^\d+[.)] /.test(l))) return `<ol class="md">${lines.map(l => `<li>${inline(l.replace(/^\d+[.)] /, ''))}</li>`).join('')}</ol>`
    return `<p class="md">${lines.map(inline).join('<br>')}</p>`
  }).join('')
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
/* One reading column: header with the two tabs, then the failed list or the passed list. */
:root{--bg:#fff;--fg:#14171c;--mut:#5c6570;--line:#e3e6eb;--card:#f6f7f9;--raise:#fff;
--crit:#c0243a;--maj:#b35d12;--min:#556170;--note:#6b7480;--ok:#2b7a4b;--hi:#b35d12;--mark:#e0245e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1216;--fg:#e8eaed;--mut:#9aa3ad;--line:#262c33;--card:#161a20;--raise:#1b2027;
--crit:#ff6b81;--maj:#e69a52;--min:#a2abb5;--note:#a2abb5;--ok:#5fc48a;--hi:#e69a52;color-scheme:dark}}
:root[data-theme=dark]{--bg:#0f1216;--fg:#e8eaed;--mut:#9aa3ad;--line:#262c33;--card:#161a20;--raise:#1b2027;
--crit:#ff6b81;--maj:#e69a52;--min:#a2abb5;--note:#a2abb5;--ok:#5fc48a;--hi:#e69a52;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding-block:28px 80px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
h1{font-size:24px;margin:0 0 4px;text-wrap:balance}h2{font-size:18px;margin:30px 0 10px;text-wrap:balance;display:flex;gap:10px;align-items:center}
.sub{color:var(--mut);font-size:13px}
.about{margin:10px 0 0;max-width:70ch}
a{color:inherit;text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px}a:hover{text-decoration-thickness:2px}
code{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:13px;word-break:break-all}
.summary{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;margin:18px 0 6px}
.verdict{display:flex;align-items:center;padding:0 18px;border-radius:10px;font-weight:700;font-size:18px;border:2px solid currentColor}
.v-Fail{color:var(--crit)}.v-Needs{color:var(--maj)}.v-Pass{color:var(--ok)}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px;min-width:92px}
.tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.tile span{color:var(--mut);font-size:12px}
.tile.wide{min-width:220px}.tile.sev-crit b{color:var(--crit)}.tile.sev-maj b{color:var(--maj)}
.note-box{border-left:3px solid var(--maj);padding:8px 12px;background:var(--card);border-radius:0 8px 8px 0;font-size:13px;color:var(--mut);margin:12px 0}
.note-box ul{margin:0;padding-left:18px}
.bar{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:var(--bg);display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);margin-top:14px;padding:8px 0}
.tabs{display:flex;gap:4px}
.tabs button{font:inherit;font-weight:600;padding:8px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--mut);cursor:pointer}
.tabs button[aria-selected=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.tabs .n{font-variant-numeric:tabular-nums;opacity:.8;margin-left:4px}
.find{display:flex;gap:6px;align-items:center;font-size:13px}
.find input{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);width:9em}
.find button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);cursor:pointer}
button:focus-visible,input:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--hi);outline-offset:2px}
.rule{border:1px solid var(--line);border-radius:10px;margin:10px 0;background:var(--card)}
.rule>summary{cursor:pointer;padding:12px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rule>.body{padding:0 14px 14px}
.cnt{margin-left:auto;color:var(--mut);font-size:13px;font-variant-numeric:tabular-nums}
.chip{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:6px;border:1px solid currentColor;white-space:nowrap}
.chip.crit{color:var(--crit)}.chip.maj{color:var(--maj)}.chip.min{color:var(--min)}.chip.note{color:var(--note)}.chip.ok{color:var(--ok)}
.ids{display:flex;flex-wrap:wrap;gap:4px;flex-basis:100%}
.did{display:inline-block;font:700 13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 8px;border-radius:6px;text-decoration:none!important;background:var(--fg);color:var(--bg)}
.ids .did{font-size:11px;padding:1px 6px}.did:hover{background:var(--hi)}
.defect{background:var(--raise);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0;scroll-margin-top:80px}
.dhead{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dcard>summary{display:block;cursor:pointer;list-style:none;padding:0;margin:0;color:inherit;font-size:inherit;font-weight:inherit}.dcard>summary::-webkit-details-marker{display:none}.dcard>summary .dhead::after{content:"\\25B8";margin-left:auto;color:var(--mut)}.dcard[open]>summary .dhead::after{content:"\\25BE"}.dcard>summary .where{margin-bottom:0}.dcard[open]>summary{margin-bottom:8px}
.dtitle{font-size:15px}
.badge{margin-left:auto;font-size:12px;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:1px 9px;white-space:nowrap}
.kv{margin:6px 0;overflow-wrap:anywhere}.where{color:var(--mut);font-size:13px}
.shot{margin:10px 0;max-width:760px}
.shot button{display:block;padding:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card);cursor:zoom-in;max-width:100%}
.shot img{display:block;max-width:100%;height:auto;max-height:520px;object-fit:contain}
.shot figcaption{font-size:12px;color:var(--mut);margin-top:4px}
.noshot{font-size:13px;color:var(--mut);background:var(--card);border:1px dashed var(--line);border-radius:8px;padding:8px 12px;margin:10px 0}
details.more>summary{cursor:pointer;color:var(--mut);font-size:13px;margin-top:6px}.steps-box>summary{font-weight:600;color:var(--fg);font-size:14px}
ul.pages{margin:6px 0 0;padding-left:18px;color:var(--mut);font-size:13px}ul.pages li{overflow-wrap:anywhere}ul.pages .where{color:var(--fg)}
ul.found{list-style:none;padding:0;margin:4px 0 10px;display:grid;gap:6px}.small-shot .shot{max-width:460px}.small-shot .shot img{max-height:340px}
.steps{margin:6px 0 10px;padding-left:22px}.steps li{margin:3px 0;overflow-wrap:anywhere}
.check{border-top:1px solid var(--line);padding:8px 0}.check:first-of-type{border-top:0}
.rules-ok{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px 16px;font-size:14px}
.flash{outline:2px solid var(--hi);outline-offset:4px}
.thumb{flex:none;margin:0;font-size:12px;color:var(--mut)}.strip{display:flex;gap:12px;overflow-x:auto}
.shot-view{height:420px;overflow-y:auto;border:1px solid var(--line);border-radius:6px}.shot-view img{display:block;width:100%}
dialog.lb{max-width:96vw;max-height:94vh;padding:0;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
dialog.lb::backdrop{background:rgba(0,0,0,.6)}
dialog.lb .bar{position:sticky;top:0;margin:0;padding:8px 12px;background:var(--card);font-size:13px}
dialog.lb button{font:inherit;background:none;border:1px solid var(--line);border-radius:6px;color:var(--fg);padding:2px 10px;cursor:pointer}
dialog.lb img{display:block;max-width:100%;margin:0 auto}
ul.md,ol.md{margin:4px 0;padding-left:20px}ul.md li,ol.md li{margin:2px 0}p.md{margin:4px 0}.kv>b+p.md,.kv>b+ul.md{margin-top:2px}
.saw{font-size:14px}
.md table{border-collapse:collapse;margin:6px 0;font-size:13px}.md th,.md td{border:1px solid var(--line);padding:4px 8px;text-align:left}.md th{background:var(--card)}
.md .ok{color:var(--ok);font-weight:600}.md .bad{color:var(--crit);font-weight:600}.md .warn{color:var(--maj);font-weight:600}.md .muted{color:var(--mut)}
.md .callout{background:var(--card);border-left:3px solid var(--hi);padding:6px 10px;border-radius:0 6px 6px 0;margin:6px 0}
.md .pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin:6px 0}.md .before,.md .after{border:1px solid var(--line);border-radius:6px;padding:6px 10px}
.md .before{border-left:3px solid var(--crit)}.md .after{border-left:3px solid var(--ok)}.md .value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);padding:0 4px;border-radius:4px}
.md pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;overflow-x:auto;font-size:12px}.md kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 4px;font-size:12px}
.md mark{background:color-mix(in srgb,var(--hi) 25%,transparent);color:inherit}.dbody{display:grid;gap:16px;margin-top:4px}@media (min-width:980px){.dbody:has(.shot){grid-template-columns:minmax(0,11fr) minmax(0,10fr);align-items:start}.dbody:has(.shot) .dshot{position:sticky;top:72px}}.vs{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.dshot:empty{display:none}.dshot .shot{margin:0;max-width:none}.dshot .noshot{margin:0}.dtext{min-width:0;max-width:74ch}.dtext>.row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:4px 14px;padding:12px 0;border-top:1px solid var(--line)}.dtext>.row:first-child{border-top:0;padding-top:2px}.dtext>.row>.lab{font-size:13px;font-weight:600;color:var(--mut);padding-top:2px}.dtext>.row>.val{min-width:0;overflow-wrap:anywhere}.dtext>.row>.val>.md>:first-child{margin-top:0}.dtext>.row>.val>.md>:last-child{margin-bottom:0}.dtext>.row.fix>.lab{color:var(--ok)}.dtext>.row.fix>.val{background:color-mix(in srgb,var(--ok) 7%,var(--bg));border-radius:8px;padding:10px 12px}.dtext>.row.note{font-size:14px;color:var(--mut)}@media (max-width:600px){.dtext>.row{grid-template-columns:minmax(0,1fr)}}.md .pair{display:block;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:0 12px;margin:10px 0}.md .pair>.before,.md .pair>.after{position:relative;border:0;border-radius:0;padding:8px 0 8px 86px}.md .pair>.after{border-top:1px solid var(--line)}.md .pair>.before::before,.md .pair>.after::before{position:absolute;left:0;top:10px;font-size:12px;font-weight:600}@media (max-width:600px){.md .pair>.before,.md .pair>.after{padding-left:0}.md .pair>.before::before,.md .pair>.after::before{position:static;display:block}}.md .pair>.before::before{content:"Now";color:var(--crit)}.md .pair>.after::before{content:"Should be";color:var(--ok)}.md .pair>.before{color:var(--mut)}.md ul,.md ol{margin:6px 0;padding-left:18px}.md li{margin:4px 0}.md li::marker{color:var(--mut)}.md .callout{background:none;border:0;border-top:1px dashed color-mix(in srgb,var(--ok) 40%,var(--line));border-radius:0;padding:8px 0 0;margin:10px 0 0;font-size:14px;color:var(--mut)}.md code,.md .value{font-size:.92em}
hr.sep{border:0;border-top:1px dashed var(--line);margin:12px 0}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
@media (max-width:600px){.badge{margin-left:0}.find input{width:7em}}
`

// Thumbnail width per viewport width: a phone shot stays narrow, a desktop
// one wide, all at the same height so a row reads as one strip.
const thumbWidth = (w) => Math.round(Math.min(320, Math.max(110, Number(w) / 4.5)))
const thumb = (src, label, w) => `<figure class="thumb" style="width:${thumbWidth(w)}px"><div class="shot-view" tabindex="0" role="region" aria-label="${esc(label)}, scroll"><img loading="lazy" src="${esc(src)}" alt="${esc(label)}"></div><figcaption><button type="button" data-full="${esc(src)}" data-label="${esc(label)}">${esc(label)} ↗</button></figcaption></figure>`

// Every page at every width (the browser pass's full-page pictures). Not shown
// for now: the report carries pictures only for what failed.
export function renderVisual(visual) {
  if (!Array.isArray(visual) || !visual.length) return ''
  const page = (v) => `<div class="vis-page"><p class="kv">${rich(v.url)}</p><div class="strip">${v.shots.map(s => thumb(s.src, `${s.width} px`, s.width)).join('')}</div></div>`
  return `<details class="rule"><summary><b>Every page at every width</b></summary><div class="body">${visual.map(page).join('')}</div></details>`
}

const SEVERITIES = ['critical', 'major', 'minor', 'note']
const CHECK_LABEL = {
  journey: 'Visitor journeys', visual: 'Screenshot review', content: 'Copy', menu: 'Menu', popup: 'Popups',
  form: 'Forms', faq: 'Tabs, accordions and sliders', focus: 'Keyboard focus', pages: 'Service pages', design: 'Design vs Figma',
}
const CHECK_WHAT = {
  menu: 'the burger opens, fits the screen, every item reachable, submenus open, it closes, links match the desktop menu',
  popup: 'opens from its button, fits the screen, closes with the X, a click outside and Esc',
  form: 'required fields and *, error texts, phone mask, the button after an error, mobile layout (not submitted)',
  faq: 'every tab, item and slide opened, the layout holds',
  pages: '404, search with results and with none, listings and archives, gated content',
  design: 'sections, layout, images and counts against the Figma frame; text against the copy doc; fonts and colours by their values',
  focus: 'focus is visible on Tab and reaches the menu, buttons and forms',
  content: 'timelines, numbers, hours, prices and promises compared between pages',
  visual: 'every page at every width, piece by piece: text past its box, overlaps, cut or empty blocks, broken grids and images',
}

// Where the fix goes: once for the whole site, once per section, or per page.
function scopeBadge(scope, pages) {
  if (scope === 'global') return '<span class="badge">site-wide · fix once</span>'
  if (String(scope).startsWith('template:')) return `<span class="badge">section <code>${esc(scope.slice(9))}</code></span>`
  return `<span class="badge">${pages} ${pages === 1 ? 'page' : 'pages'}</span>`
}

// The defect's picture with the spot outlined, or why there is none.
function picture(x) {
  const src = (typeof x.shotSrc === 'string' && /^visual\/[\w.-]+$/.test(x.shotSrc)) ? x.shotSrc
    : (typeof x.shotDataUri === 'string' && x.shotDataUri.startsWith('data:image/')) ? x.shotDataUri : null
  if (x.suppressed) return '<p class="noshot">Picture hidden to fit the size limit.</p>'
  if (src) {
    const cap = x.spot ? spotText(x.spot, x.shotWidth) : `the problem is outlined${x.shotWidth ? ` · at ${x.shotWidth} px` : ''}`
    const site = `<figure class="shot"><button type="button" data-full="${src.startsWith('data:') ? '' : esc(src)}" data-label="${esc(x.id || x.title)}"><img loading="lazy" src="${esc(src)}" alt=""></button><figcaption>${esc(cap)}</figcaption></figure>`
    if (!(typeof x.designSrc === 'string' && /^visual\/[\w.-]+$/.test(x.designSrc))) return site
    return `<div class="vs"><figure class="shot"><button type="button" data-full="${esc(x.designSrc)}" data-label="${esc(`${x.id || x.title} · Figma`)}"><img loading="lazy" src="${esc(x.designSrc)}" alt=""></button><figcaption>Figma design</figcaption></figure>${site}</div>`
  }
  if (x.rule === 'X1') return '<p class="noshot">Nothing to see on the page: this is an error in the browser console.</p>'
  // there, but hidden at this moment (a closed tab, a slide, another width)
  if (x.spot?.note) return `<p class="noshot">No picture: ${esc(x.spot.note)}.</p>`
  if (x.evidenceStatus === 'invisible' || /^(head|html|title)$|^(meta|script|link)\b|meta\[|script\[/i.test(String(x.selector || ''))) {
    return `<p class="noshot">Nothing to see on the page: this is in the page’s code${x.selector ? ` (<code>${esc(x.selector)}</code>)` : ''}.</p>`
  }
  return '<p class="noshot">No picture: the spot could not be found on the page again.</p>'
}

// One problem: what is wrong, where, its picture, and what right looks like.
function card(x) {
  const pages = x.pages || []
  const first = pages[0]
  const widths = x.widths && x.widths.length ? ` · ${x.widths.map(esc).join(', ')} px` : ''
  return `<article class="defect"${x.id ? ` id="${esc(x.id)}"` : ''} data-cat="${esc(x.cat || 'dev')}">
<details class="dcard"><summary><div class="dhead">${x.id ? `<a class="did" href="#${esc(x.id)}">${esc(x.id)}</a>` : ''}<span class="chip ${CHIP[x.severity] || 'note'}">${esc(LABEL[x.severity] || x.severity)}</span><b class="dtitle">${esc(x.title)}</b>${x.rule ? `<span class="sub">${esc(x.rule)}</span>` : ''}${scopeBadge(x.scope, pages.length)}</div>
${first ? `<p class="kv where">${rich(first)}${pages.length > 1 ? ` <span class="sub">and ${pages.length - 1} more</span>` : ''}${widths}</p>` : ''}</summary>
<div class="dbody"><div class="dshot">${picture(x)}</div><div class="dtext">
<div class="row"><span class="lab">Problem</span><div class="val">${md(x.found)}</div></div>
${x.expected ? `<div class="row fix"><span class="lab">Fix</span><div class="val">${md(x.expected)}</div></div>` : ''}
${x.note ? `<div class="row note"><span class="lab">Agent</span><div class="val">${md(x.note.replace(/^Agent:\s*/, ''))}</div></div>` : ''}
${x.region ? `<p class="kv sub">${String(x.region).startsWith(UNNAMED_REGION_PREFIX) ? `region: shared Elementor container <code>${esc(x.region.slice(UNNAMED_REGION_PREFIX.length))}</code> (its name could not be determined)` : `region: <code>${esc(x.region)}</code>`}, shared by every page below: fix it once</p>` : ''}
${pages.length > 1 || x.selector ? `<details class="more"><summary>Details</summary>${x.selector ? `<p class="kv sub">selector <code>${esc(x.selector)}</code></p>` : ''}${pages.length > 1 ? `<ul class="pages">${pages.slice(0, PAGE_LIST_CAP).map(p => `<li>${rich(p)}${x.where?.[p] ? `<div class="where">${rich(x.where[p])}</div>` : ''}</li>`).join('')}</ul>${pages.length > PAGE_LIST_CAP ? `<p class="kv sub">…and ${pages.length - PAGE_LIST_CAP} more pages not shown (list limit)</p>` : ''}` : ''}</details>` : ''}</div></div></details>
</article>`
}

// Claude's defects, one per id with every page it names.
function claudeDefects(findings) {
  const byId = new Map()
  // the same defect found at two widths or on two checks (M8 at 360, M9 at 1440) is one card
  for (const f of findings) {
    const k = defectIdentity(f)
    if (!byId.has(k)) byId.set(k, { ...f, pages: [], widths: new Set(), manuals: new Set() })
    const d = byId.get(k)
    if (f.page && !d.pages.includes(f.page)) d.pages.push(f.page)
    if (f.breakpoint != null) d.widths.add(f.breakpoint)
    if (f.manual != null) d.manuals.add(f.manual)
  }
  return [...byId.values()].map(d => ({ ...d, widths: [...d.widths].sort((a, b) => a - b) }))
}

const reviewNote = (r) => (r?.note ? `Agent: ${r.note}` : '')

// Engine groups (rollUp) and Claude's defects as cards with their group title.
function items(groups, claude, { totalPages, breakpointsByIdentity, suppressedShots, candidates, ids }) {
  const out = []
  for (const g of groups) {
    const defects = g.identities?.length ? g.identities : [{ ...g.example, identity: defectIdentity(g.example), pages: g.pages, example: g.example }]
    for (const d of defects) {
      const ex = d.example || {}
      if (candidates && typeof ex.shotDataUri === 'string') candidates.push({ identity: d.identity, severity: g.severity, bytes: ex.shotDataUri.length })
      out.push({
        group: `${g.rule} · ${g.title}`, rule: g.rule, id: ids?.[d.identity], severity: g.severity, title: g.title, found: d.found, expected: d.expected,
        pages: d.pages, widths: [...(breakpointsByIdentity.get(d.identity) || [])].sort((a, b) => a - b), selector: d.selector,
        scope: scopeOf({ ...d, region: ex.region }, totalPages), region: ex.region || null,
        where: d.where, note: reviewNote(ex.review), shotSrc: ex.shotSrc, shotDataUri: ex.shotDataUri, shotWidth: ex.shotWidth, spot: ex.spot,
        evidenceStatus: ex.evidenceStatus, suppressed: suppressedShots.has(d.identity), cat: categoryOf(ex),
      })
    }
  }
  for (const d of claude) {
    out.push({
      group: CHECK_LABEL[d.check] || 'Checked by the agent', rule: d.rule, id: d.id, severity: d.severity, title: d.title, found: d.found, expected: d.expected,
      pages: d.pages, widths: d.widths, selector: d.selector, scope: d.pages.length > 1 ? scopeOf({ pages: d.pages, zones: [] }, totalPages) : 'page',
      where: null, note: d.confidence === 'heuristic' ? reviewNote(d.review) : '', shotSrc: d.shotSrc, shotDataUri: d.shotDataUri, shotWidth: d.shotWidth ?? d.breakpoint, spot: d.spot, designSrc: d.designSrc,
      evidenceStatus: d.evidenceStatus, suppressed: false, cat: categoryOf(d),
    })
  }
  return out
}

// Failed: every problem once, one list, the worst first.
const FOLD_AT = 3
function renderProblems(list) {
  if (!list.length) return '<p class="sub">No violations found: everything checked passed.</p>'
  const order = { critical: 0, major: 1, minor: 2, note: 3 }
  const sorted = [...list].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || (b.pages?.length || 0) - (a.pages?.length || 0))
  const shown = sorted.slice(0, DEFECT_CAP * 5)
  // A rule with many cards (a redirect per link) folds into one closed block, placed at its worst card.
  const byRule = new Map()
  for (const x of shown) byRule.set(x.title, [...(byRule.get(x.title) || []), x])
  const done = new Set()
  const body = shown.map(x => {
    const same = byRule.get(x.title)
    if (same.length < FOLD_AT) return card(x)
    if (done.has(x.title)) return ''
    done.add(x.title)
    return `<details class="rule group"><summary><span class="chip ${CHIP[x.severity] || 'note'}">${esc(LABEL[x.severity] || x.severity)}</span> <b>${esc(x.title)}</b><span class="cnt">${same.length} problems</span></summary><div class="body">${same.map(card).join('')}</div></details>`
  }).join('')
  return `<h2>Problems <span class="sub">${list.length}</span></h2>${body}${sorted.length > shown.length ? `<p class="kv">…and ${sorted.length - shown.length} more defects not shown (list limit)</p>` : ''}`
}

const JOURNEY_STATUS = { ok: ['ok', 'passed'], defect: ['crit', 'had problems'], skipped: ['note', 'not done'] }

// A visitor's task at every width it ran at, as one card: its problems
// (links to the cards in the list), then the steps of each width, folded.
export function journeyGroups(checks) {
  const by = new Map()
  for (const m of checks.filter(c => c.check === 'journey')) {
    const k = String(m.title || '').trim().toLowerCase()
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(m)
  }
  return [...by.values()].map(runs => runs.sort((a, b) => (a.width ?? 0) - (b.width ?? 0)))
}
const runStatus = (runs) => (runs.some(m => m.status === 'defect') ? 'defect' : runs.every(m => m.status === 'ok') ? 'ok' : 'skipped')
function journey(runs, defs, { open = false } = {}) {
  const status = runStatus(runs)
  const [cls, label] = JOURNEY_STATUS[status] || JOURNEY_STATUS.skipped
  const widths = runs.map(m => m.width).filter(w => w != null)
  const steps = (m) => `${runs.length > 1 ? `<p class="kv"><b>At ${esc(m.width)} px</b>${m.status === 'ok' ? ' · <span class="sub">passed</span>' : ''}</p>` : ''}<p class="kv">start: ${rich(m.page)}</p><ol class="steps">${m.steps.map(st => `<li>${rich(st)}</li>`).join('')}</ol>
${m.checked ? `<p class="kv"><b>What the agent saw</b></p><div class="kv saw">${md(m.checked)}</div>` : ''}
${m.status !== 'ok' && (m.shots || []).length ? `<div class="strip">${m.shots.map((src, i) => thumb(src, `${m.width != null ? `${m.width} px · ` : ''}step ${i + 1}`, m.width || 768)).join('')}</div>` : ''}`
  return `<details class="rule journey"${open ? ' open' : ''}><summary><span class="chip ${cls}">${esc(label)}</span> <b>${esc(runs[0].title)}</b><span class="cnt">${widths.length ? `${widths.map(esc).join(', ')} px` : ''}</span></summary><div class="body">
${defs.length ? `<ul class="found">${defs.map(d => `<li><a class="did" href="#${esc(d.id)}">${esc(d.id)}</a> <span class="chip ${CHIP[d.severity] || 'note'}">${esc(LABEL[d.severity] || d.severity)}</span> <a href="#${esc(d.id)}" class="jlink">${esc(d.title)}</a>${d.widths?.length ? ` <span class="sub">· ${d.widths.map(esc).join(', ')} px</span>` : ''}</li>`).join('')}</ul>` : ''}
<details class="more steps-box"><summary>Steps</summary>${runs.map(steps).join('<hr class="sep">')}</details></div></details>`
}

// Passed: what was checked and found right, as text (no pictures for now).
function renderPassed({ manualChecks, claude, rulesPassed, tiles, browserCoverage, pages, forms = [], parts = [] }) {
  const checks = Array.isArray(manualChecks) ? manualChecks : []
  const js = journeyGroups(checks).filter(runs => runStatus(runs) === 'ok')
  const byCheck = Object.keys(CHECK_LABEL).filter(k => k !== 'journey').map(k => [k, checks.filter(m => m.check === k && m.status === 'ok')]).filter(([, rows]) => rows.length)
  const cov = browserCoverage ? `${browserCoverage.pagesDone} of ${browserCoverage.pagesTotal} pages in a browser${Array.isArray(browserCoverage.widths) && browserCoverage.widths.length ? ` at ${browserCoverage.widths.join(', ')} px` : ''}` : 'no browser pass'
  return `<p class="sub">Checked: ${esc(pages)} pages read, ${esc(cov)}${tiles ? `, ${esc(tiles.seen)} of ${esc(tiles.total)} screen pieces looked at by the agent` : ''}${forms.length ? `, ${forms.filter(f => f.checked).length} of ${forms.length} forms checked by hand` : ''}${parts.length ? `, ${parts.filter(f => f.checked).length} of ${parts.length} popups, tabs, accordions and sliders opened by hand` : ''}.</p>
${js.length ? `<h2>Visitor journeys that went through</h2>${js.map(runs => journey(runs, [])).join('')}` : ''}
${byCheck.length ? `<h2>Checked by the agent and right</h2>${byCheck.map(([k, rows]) => `<details class="rule"><summary><span class="chip ok">ok</span> <b>${esc(CHECK_LABEL[k])}</b><span class="cnt">${rows.length} ${rows.length === 1 ? 'check' : 'checks'}</span></summary><div class="body"><p class="sub">${esc(CHECK_WHAT[k] || '')}</p>${rows.map(m => `<div class="check"><p class="kv">${m.width != null ? `<b>${esc(m.width)} px</b> · ` : ''}${rich(m.page)}</p>${m.checked ? `<div class="kv sub">${md(m.checked)}</div>` : ''}</div>`).join('')}</div></details>`).join('')}` : ''}
${(() => { const none = ['menu', 'popup', 'form', 'faq', 'focus', 'content', 'pages'].filter(k => !checks.some(m => m.check === k)); return none.length ? `<p class="sub">Not checked by hand: ${none.map(k => esc(CHECK_LABEL[k])).join(', ')}.</p>` : '' })()}
${rulesPassed.length ? `<h2>Automatic checks with no problems</h2><div class="rules-ok">${rulesPassed.map(r => `<div><span class="chip ok">ok</span> <b>${esc(r.id)}</b> ${esc(r.title)}</div>`).join('')}</div>` : ''}`
}

// What the crawl found that no hand check named: a gap in the QC, not a defect.
function renderLeft(all, title, noun, sub) {
  const left = all.filter(f => !f.checked)
  if (!left.length) return ''
  return `<details class="rule unsure"><summary><span class="chip note">needs a look</span> <b>${esc(title)}</b><span class="cnt">${left.length} of ${all.length} ${noun}</span></summary><div class="body"><p class="sub">${esc(sub)}</p><ul class="pages">${left.map(f => `<li><b>${esc(f.id)}</b>${f.fields.length ? ` <span class="sub">(${f.fields.map(esc).join(', ')}…)</span>` : ''}<div class="where">${f.page ? rich(f.page) : ''}${f.pages > 1 ? ` <span class="sub">and ${f.pages - 1} more pages</span>` : ''}</div></li>`).join('')}</ul></div></details>`
}

const TABS = `<script>(()=>{const tabs=[...document.querySelectorAll('[data-tab]')];const show=n=>{tabs.forEach(t=>{const on=t.dataset.tab===n;t.setAttribute('aria-selected',String(on));document.getElementById('panel-'+t.dataset.tab).hidden=!on})};
tabs.forEach(t=>t.addEventListener('click',()=>{show(t.dataset.tab);history.replaceState(null,'','#'+t.dataset.tab)}));
window.qcShowTab=show;if(location.hash==='#passed')show('passed')})()</script>`

// Find a defect by its id: opens the failed tab and the groups around it.
const FIND = `<script>(()=>{const msg=document.getElementById('qc-find-msg');
function go(raw,quiet){const id=String(raw||'').trim().toUpperCase().replace(/^#/,'');if(!id)return;const el=document.getElementById(id);
if(!el||!/^[DM]\\d+$/.test(id)){if(!quiet&&msg)msg.textContent='No problem '+id+' in this report';return}
if(window.qcShowTab)window.qcShowTab('failed');for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;const own=el.querySelector(':scope > details.dcard');if(own)own.open=true;
el.scrollIntoView({block:'center'});el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');if(msg)msg.textContent=''}
const f=document.getElementById('qc-find-form');if(f)f.addEventListener('submit',e=>{e.preventDefault();go(document.getElementById('qc-find').value)});
document.addEventListener('click',e=>{const a=e.target.closest('a.did, a.jlink');if(a){e.preventDefault();go(a.getAttribute('href'),true)}});
if(location.hash&&location.hash!=='#passed'&&location.hash!=='#failed')go(location.hash,true)})()</script>`

// The picture full size; the <img> is made on first open, so a report with
// no pictures has none.
const LIGHTBOX = `<dialog class="lb" id="qc-lb"><div class="bar"><span id="qc-lb-t"></span><button type="button" id="qc-lb-x">Close</button></div></dialog>
<script>(()=>{const d=document.getElementById('qc-lb');if(!d||!d.showModal)return;const t=document.getElementById('qc-lb-t');let i=null;
document.addEventListener('click',e=>{const b=e.target.closest('[data-full]');if(!b)return;if(!i){i=document.createElement('img');d.appendChild(i)}const im=b.querySelector('img');i.src=b.dataset.full||(im&&im.src)||'';i.alt=b.dataset.label;t.textContent=b.dataset.label;d.showModal()});
document.getElementById('qc-lb-x').onclick=()=>d.close();d.addEventListener('click',e=>{if(e.target===d)d.close()})})()</script>`

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

export function renderReport({
  host, env, envReason, pages, findings, diff, snapshotAgeDays, source, sitemapStatus,
  browserCoverage,
  rejected = [],
  siteSummary = null,
  unjudged = 0,
  // every form the crawl found, and whether the agent checked it by hand: [{id, page, pages, fields, checked}]
  forms = [],
  // popups, tabs, accordions, sliders the crawl found, the same shape
  parts = [],
  // the screen pieces Claude looked at in the visual review: {total, seen, unseenPages, missing}
  tiles = null,
  manualChecks = [],
  // every rule the run executed, {id, title}: the ones with no problem are listed as passed
  rules = [],
  // identity -> «D12», the same ids `qc findings` prints
  ids = null,
  // when the audit ran (ms); shown next to the domain
  ranAt = null,
}) {
  // Fail fast on malformed findings: coercing bad input to [] would turn a
  // caller bug into a confident "Pass" report.
  try { ORIGIN = new URL(`https://${host}`).origin } catch { ORIGIN = null }
  const qcDate = Number.isFinite(ranAt) ? new Date(ranAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null
  if (!Array.isArray(findings)) {
    const received = findings === null ? 'null' : findings === undefined ? 'undefined' : typeof findings
    throw new TypeError(`renderReport requires findings to be an array, got ${received}`)
  }
  const list = findings
  const isClaude = (f) => f.engine === 'claude'
  const solid = list.filter(f => f.confidence !== 'heuristic')
  const claudeAll = list.filter(isClaude)
  const groups = rollUp(solid.filter(f => !isClaude(f)))
  const heur = rollUp(list.filter(f => f.confidence === 'heuristic' && !isClaude(f)))
  const claudeSolid = claudeDefects(claudeAll.filter(f => f.confidence !== 'heuristic'))
  const claudeUnsure = claudeDefects(claudeAll.filter(f => f.confidence === 'heuristic'))
  const v = verdict(list)
  const vClass = v === 'Fail' ? 'v-Fail' : v === 'Pass' ? 'v-Pass' : 'v-Needs'
  const distinct = countDistinct(solid)
  const distinctTotal = distinct.critical + distinct.major + distinct.minor + distinct.note
  const checks = Array.isArray(manualChecks) ? manualChecks : []
  const journeys = journeyGroups(checks)
  const failedJourneys = journeys.filter(runs => runStatus(runs) !== 'ok')
  const withProblems = new Set(list.map(f => f.rule))
  const rulesPassed = (Array.isArray(rules) ? rules : []).filter(r => !withProblems.has(r.id))
  const passedCount = journeys.length - failedJourneys.length + checks.filter(m => m.check !== 'journey' && m.status === 'ok').length + rulesPassed.length

  const breakpointsByIdentity = new Map()
  for (const f of list) {
    if (f.breakpoint == null) continue
    const id = defectIdentity(f)
    if (!breakpointsByIdentity.has(id)) breakpointsByIdentity.set(id, new Set())
    breakpointsByIdentity.get(id).add(f.breakpoint)
  }

  const ageLabel = snapshotAgeDays < 1 ? 'fresh' : `${Number(snapshotAgeDays).toFixed(0)} days`
  const pagesDone = Number(browserCoverage?.pagesDone) || 0
  const pagesTotal = Number(browserCoverage?.pagesTotal) || 0
  const failedUrls = Array.isArray(browserCoverage?.failedUrls) ? browserCoverage.failedUrls : []
  // What the reader must know before trusting the lists: anything not checked.
  const dropped = Array.isArray(browserCoverage?.droppedWidths) ? browserCoverage.droppedWidths : []
  const stale = Number(browserCoverage?.stalePages) > 0
  const warnings = [
    !browserCoverage ? `The browser pass did not run: only the HTML was checked. Layout, screenshots and clicks were not. Run <code>qc browse ${esc(host)}</code>.` : '',
    browserCoverage && pagesTotal && pagesDone < pagesTotal && !(stale && pagesDone === 0) ? `The browser pass is partial: ${esc(pagesDone)} of ${esc(pagesTotal)} pages checked; visual problems on the rest are unknown. Run <code>qc browse ${esc(host)}</code> again to continue.` : '',
    failedUrls.length ? `Did not open in the browser pass: ${esc(failedUrls.length)} ${failedUrls.length === 1 ? 'page' : 'pages'} — ${failedUrls.slice(0, PAGE_LIST_CAP).map(x => `${rich(typeof x === 'string' ? x : x?.url)}${x?.error ? ` (${esc(x.error)})` : ''}`).join(', ')}${failedUrls.length > PAGE_LIST_CAP ? ` and ${failedUrls.length - PAGE_LIST_CAP} more` : ''}.` : '',
    dropped.length ? `Excluded widths (not measured): <code>${dropped.map(esc).join(', ')}</code>. Check them with <code>qc browse ${esc(host)} --breakpoints ${esc(dropped.join(','))} --force</code>.` : '',
    stale ? `The browser pass is out of date for ${esc(browserCoverage.stalePages)} pages: they were checked before this crawl. Run <code>qc browse ${esc(host)}</code> again.` : '',
    unjudged ? `${esc(unjudged)} ${unjudged === 1 ? 'candidate' : 'candidates'} from the scripts were not checked by the agent and are not shown.` : '',
    tiles && (tiles.seen < tiles.total || tiles.missing) ? `The agent looked at ${esc(tiles.seen)} of ${esc(tiles.total)} screen pieces${tiles.missing ? `; ${esc(tiles.missing)} page widths have none` : ''}: small visual problems there may be missed.` : '',
    snapshotAgeDays > STALENESS_WARNING_DAYS ? `The snapshot is more than ${esc(STALENESS_WARNING_DAYS)} days old, so the data may be out of date. Run again with <code>--fresh</code>.` : '',
    sitemapStatus && sitemapStatus !== 'ok' ? `Sitemap: <b>${esc(sitemapStatus)}</b>. The page list may be incomplete.` : '',
  ].filter(Boolean)

  function build(suppressedShots, { oversizeBytes } = {}) {
    const candidates = suppressedShots ? null : []
    const ctx = { totalPages: pages, breakpointsByIdentity, suppressedShots: suppressedShots ?? new Set(), candidates, ids }
    const problems = items(groups, claudeSolid, ctx)
    const unsure = items(heur, claudeUnsure, ctx)
    const defsOf = (runs) => claudeSolid.filter(d => runs.some(m => d.manuals.has(m.index)))
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QC ${esc(host)}${qcDate ? ` ${esc(qcDate)}` : ''}</title><style>${CSS}</style></head><body><div class="wrap">
<header class="top"><h1>QC · ${esc(host)}${qcDate ? ` · ${esc(qcDate)}` : ''}</h1>
<p class="sub">${esc(env)} site${envReason ? ` (${esc(envReason)})` : ''} · ${esc(pages)} pages · page list: ${esc(source)} · crawl: ${ageLabel}</p>
${siteSummary ? `<p class="about"><b>About the site:</b> ${esc(siteSummary)}</p>` : ''}
<div class="summary"><span class="verdict ${vClass}">${esc(v)}</span>
<div class="tile wide"><b>${distinctTotal} ${distinctTotal === 1 ? 'problem' : 'problems'}</b><span>to fix · ${solid.length} occurrences on ${new Set(solid.map(f => f.page)).size} pages</span></div>
${['critical', 'major', 'minor'].map(s => `<div class="tile sev-${CHIP[s]}"><b>${distinct[s]}</b><span>${LABEL[s]}</span></div>`).join('')}
${journeys.length ? `<div class="tile"><b>${journeys.length - failedJourneys.length} of ${journeys.length}</b><span>journeys passed</span></div>` : ''}
</div>
<p class="sub">Since the last QC (occurrences): <b>${diff?.added?.length ?? 0}</b> new · <b>${diff?.fixed?.length ?? 0}</b> fixed · <b>${diff?.remaining?.length ?? 0}</b> remaining</p>
${warnings.length ? `<div class="note-box"><ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul></div>` : ''}
${suppressedShots && suppressedShots.size ? `<div class="note-box">Some screenshots are hidden to fit the publish size limit: ${esc(suppressedShots.size)} not shown (note first, then minor, major and, if needed, critical). Every problem is still listed.</div>` : ''}
${oversizeBytes != null ? `<div class="note-box">The report is over the recommended publish size limit (~${esc((oversizeBytes / (1024 * 1024)).toFixed(1))} MB of ${esc(PUBLISH_BYTE_LIMIT / (1024 * 1024))} MB) even after hiding every picture that could be hidden.</div>` : ''}
<div class="bar"><div class="tabs" role="tablist"><button type="button" role="tab" data-tab="failed" aria-selected="true">Failed <span class="n">${distinctTotal}</span></button><button type="button" role="tab" data-tab="passed" aria-selected="false">Passed <span class="n">${passedCount}</span></button></div>
<form class="find" id="qc-find-form" role="search"><label for="qc-find">Find</label><input id="qc-find" name="qc-find" placeholder="D12 or M3" autocomplete="off" spellcheck="false"><button type="submit">Go</button><span id="qc-find-msg" class="sub" aria-live="polite"></span></form></div></header>
<main>
<section id="panel-failed" role="tabpanel">
${failedJourneys.length ? `<h2>Visitor journeys with problems</h2><p class="sub">The agent did what a visitor comes to do, step by step; ${failedJourneys.length} of ${journeys.length} ran into a problem.</p>${failedJourneys.map(runs => journey(runs, defsOf(runs), { open: true })).join('')}` : ''}
${renderProblems(problems)}
${renderLeft(forms, 'Forms not checked by hand', 'forms', 'The crawl found these forms, but the agent did not fill them in at 360 and 1440. They are not defects; nobody has looked at them yet.')}
${renderLeft(parts, 'Popups, tabs, accordions and sliders not opened by hand', 'parts', 'The crawl found these, but the agent did not open them (every tab, item and slide) at 360 and 1440. What they hide was never seen.')}
${unsure.length ? `<details class="rule unsure"><summary><span class="chip note">needs a look</span> <b>Unconfirmed heuristics and unsure finds</b><span class="cnt">${unsure.length} — not counted</span></summary><div class="body"><p class="sub">The scripts or the agent could not tell either way; a person should look before filing a task.</p>${unsure.slice(0, DEFECT_CAP * 2).map(card).join('')}</div></details>` : ''}
</section>
<section id="panel-passed" role="tabpanel" hidden>
${renderPassed({ manualChecks: checks, claude: claudeSolid, rulesPassed, tiles, browserCoverage, pages, forms, parts })}
</section>
</main></div>${LIGHTBOX}${TABS}${FIND}</body></html>`
    return { html, candidates }
  }

  const first = build(null)
  if (Buffer.byteLength(first.html, 'utf8') <= PUBLISH_BYTE_LIMIT) return first.html
  // Over budget (inlined pictures): drop pictures, lowest severity and biggest first.
  const droppable = first.candidates.sort((a, b) => (SHOT_DROP_ORDER[a.severity] - SHOT_DROP_ORDER[b.severity]) || (b.bytes - a.bytes))
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
  return build(suppressed, { oversizeBytes: secondBytes }).html
}
