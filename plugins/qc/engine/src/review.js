// Claude's review of a finished audit. `qc findings <host>` lists the latest
// run's distinct defects with short ids (D1, D2, …), where they are and the
// site profile; Claude checks them (reading pages where needed) and writes a
// review file; `qc review <host> <file>` re-renders the report with the
// verdicts: false positives are left out and stop counting,
// confirmed and unsure ones carry Claude's note.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { latestRunDir, snapshotDir, loadSnapshot } from './crawl/store.js'
import { defectIdentity, verdict, countDistinct } from './report/json.js'
import { renderReport, scopeOf } from './report/html.js'
import { linkScreenshots } from './report/inline.js'
import { CATEGORIES } from './report/category.js'
import { attachEvidence, loadEvidence } from './browser/evidence.js'
import { markBox } from './browser/png.js'

const VERDICTS = new Set(['confirmed', 'false-positive', 'unsure'])
const STATUSES = new Set(['ok', 'defect', 'skipped'])
// A defect Claude found gets its severity from what it does to the visitor,
// not from Claude's sense of how bad it is: the same defect then gets the
// same severity on every run.
export const IMPACT = {
  blocker: 'critical', // the visitor cannot finish a journey: buy, book, call, send a form, reach a page
  broken: 'major', // visibly broken or wrong (layout, a feature, a fact), but the journey can still be done
  degraded: 'minor', // works, but worse than it should: awkward, inconsistent, an accessibility gap with a way round
  cosmetic: 'note', // only looks a little off
}
// What the second, independent check (a fresh agent repeating the steps) made of it.
const VERIFIED = new Set(['reproduced', 'not-reproduced', 'unable'])
const CODE = /^[A-Z]\d{1,2}$/
// Where the defect is on the page, apart from how it is described: the exact,
// unique text of the broken element and/or its selector. qc evidence looks for
// this only, so a quote of the right text in `found` cannot be outlined instead.
export function targetOf(t) {
  if (!t) return null
  if (typeof t === 'string') return t.trim() ? { text: t.trim() } : null
  const out = {}
  if (typeof t.text === 'string' && t.text.trim()) out.text = t.text.trim()
  if (typeof t.selector === 'string' && t.selector.trim()) out.selector = t.selector.trim()
  // the mistakes inside it, each marked on the picture («buiness», «instance»)
  if (Array.isArray(t.marks)) { const m = t.marks.map(x => String(x).trim()).filter(Boolean); if (m.length) out.marks = m }
  return out.text || out.selector ? out : null
}
export const evidenceKey = (f) => `claude:${defectIdentity(f)}${f.target ? `|${f.target.selector || ''}|${f.target.text || ''}|${(f.target.marks || []).join('|')}` : ''}`

// What Claude checks by hand in Playwright (and, for `content`, by reading
// the pages), with the taxonomy codes each check may report. The engine
// never clicks or reads for meaning; these are the parts it leaves to Claude.
export const MANUAL_CHECKS = {
  menu: ['D1', 'C2', 'C6', 'C9', 'D9', 'D2', 'B6'],
  popup: ['K4', 'C6', 'D9', 'J2', 'B6'],
  form: ['G2', 'G3', 'G5', 'G6', 'G7', 'G11', 'G12', 'G14', 'J5'],
  faq: ['F9', 'C2', 'J2'],
  focus: ['J2', 'J5'],
  content: ['H16', 'H8', 'H3', 'H12', 'E17'],
  // A visitor's task done end to end (find a price, book, buy, call) and
  // Claude's look at the page screenshots: any taxonomy code, with a title.
  journey: CODE,
  visual: CODE,
}
const allows = (check, rule) => (MANUAL_CHECKS[check] instanceof RegExp ? MANUAL_CHECKS[check].test(String(rule)) : MANUAL_CHECKS[check].includes(rule))
export const MANUAL_TITLES = {
  D1: 'Menu or submenu does not open', C6: 'Does not fit the screen', C9: 'Mobile menu does not scroll',
  D9: 'Does not close', D2: 'Mobile and desktop menus differ', B6: 'Overlapping elements',
  K4: 'Popup does not work', J2: 'Does not work with the keyboard', J5: 'Accessibility (ADA)',
  G2: 'Consent checkbox is not required', G3: 'Required field without *', G5: 'Phone field accepts non-digits',
  G6: 'Email is not required', G7: 'Submit button disappears after an error', G11: 'Form field layout',
  G12: 'Active field is not highlighted', G14: 'Form does not submit or jumps to the top',
  F9: 'Accordion works incorrectly', C2: 'Element does not fit the screen',
  H16: 'Pages contradict each other', H8: 'Duplicate text', H3: 'Typo', H12: 'Wrong city or state',
  E17: 'Text promises something the site does not have',
}

// review.manual: one entry per check × page × width, `ok` ones included so
// the report shows what was looked at. Screenshots are copied next to the
// report; defects become findings that count toward the verdict. The older
// `review.menu` is read as `manual` entries with check "menu".
// Every defect Claude records must carry its evidence (a screenshot, or a
// quote for a content defect) and the verifier's result: one it could not
// reproduce is dropped, one it could not check either way only needs a look.
function manualOf(review, dir, host = null) {
  const evidence = host ? loadEvidence(host) : {}
  const pieces = new Map((tilesOf(dir)?.tiles || []).map(t => [t.id, t]))
  const checks = []
  const findings = []
  const manualIds = new Map()
  let notReproduced = 0
  const entries = [...(review.manual || []), ...(review.menu || []).map(m => ({ check: 'menu', ...m }))]
  entries.forEach((m, i) => {
    const at = `review manual[${i}]`
    if (!m || !MANUAL_CHECKS[m.check]) throw new Error(`${at}: check must be one of ${Object.keys(MANUAL_CHECKS).join(', ')}`)
    if (!m.page) throw new Error(`${at}: page is required`)
    if (m.check !== 'content' && !Number.isFinite(Number(m.width))) throw new Error(`${at}: width is required`)
    if (!STATUSES.has(m.status)) throw new Error(`${at}: status must be ok, defect or skipped`)
    if (m.check === 'journey' && (!m.title || !(m.steps || []).length)) throw new Error(`${at}: a journey needs a title and its steps`)
    const width = m.width == null ? null : Number(m.width)
    const shots = (m.shots || []).map((src, j) => {
      if (!existsSync(src)) throw new Error(`${at}: screenshot file not found: ${src}`)
      mkdirSync(join(dir, 'visual'), { recursive: true })
      const name = `manual-${i}-${j}${extname(src) || '.png'}`
      copyFileSync(src, join(dir, 'visual', name))
      return `visual/${name}`
    })
    for (const d of m.defects || []) {
      // A visual defect may name its piece: the piece is its picture and its places are its pages.
      const piece = m.check === 'visual' && d.tile ? pieces.get(d.tile) : null
      if (d.tile && m.check === 'visual' && !piece) throw new Error(`${at}: no piece ${d.tile} in this run (qc tiles)`)
      if (piece && !shots.some(s => s.endsWith(`tile-${d.tile}.png`))) {
        mkdirSync(join(dir, 'visual'), { recursive: true })
        copyFileSync(piece.file, join(dir, 'visual', `tile-${d.tile}.png`))
        shots.push(`visual/tile-${d.tile}.png`)
      }
      if (!allows(m.check, d.rule)) throw new Error(`${at}: rule for ${m.check} must be ${MANUAL_CHECKS[m.check] instanceof RegExp ? 'a taxonomy code like C2' : `one of ${MANUAL_CHECKS[m.check].join(', ')}`}`)
      if (!IMPACT[d.impact]) throw new Error(`${at}: impact must be one of ${Object.keys(IMPACT).join(', ')}`)
      if (!d.found || !d.expected) throw new Error(`${at}: a defect needs found and expected`)
      if (!d.title && !MANUAL_TITLES[d.rule]) throw new Error(`${at}: a ${d.rule} defect needs a title`)
      if (m.check === 'content' ? !/«[^»]+»|“[^”]+”|"[^"]+"/.test(d.found) : !shots.length) {
        throw new Error(`${at}: a defect needs its evidence: ${m.check === 'content' ? 'the words from the page, quoted in found' : 'a screenshot in shots'}`)
      }
      if (!VERIFIED.has(d.verified)) throw new Error(`${at}: verified must be reproduced, not-reproduced or unable (the verifier's result)`)
      if (d.verified === 'not-reproduced') { notReproduced++; continue }
      const key = `${i}|${d.rule}|${d.found}`
      if (!manualIds.has(key)) manualIds.set(key, `M${manualIds.size + 1}`)
      const how = m.fromCache ? 'found by the agent on an earlier QC, the same picture now' : m.check === 'content' ? 'found by the agent while reading the pages' : m.check === 'journey' ? `found by the agent on the journey «${m.title}»` : 'checked by the agent in Playwright'
      const piecePages = piece ? [...new Set((piece.places || [piece]).map(p => p.page || piece.page))] : null
      // The spot outlined: the agent's box on its picture, else qc evidence's crop of the page, else the plain picture.
      let shot = shots.length ? join(dir, piece ? `visual/tile-${d.tile}.png` : shots[d.shot] || shots[0]) : null
      let marked = false
      if (d.box && shot) {
        if (!/\.png$/i.test(shot)) throw new Error(`${at}: box needs a PNG picture, got ${shot}`)
        shot = markBox(shot, d.box, join(dir, 'visual', `mark-${i}-${manualIds.get(key)}.png`))
        marked = true
      }
      for (const page of d.pages?.length ? d.pages : piecePages || [m.page]) {
        findings.push({
          id: manualIds.get(key),
          rule: d.rule, title: d.title || MANUAL_TITLES[d.rule], severity: IMPACT[d.impact], impact: d.impact,
          confidence: d.verified === 'unable' ? 'heuristic' : 'high', engine: 'claude',
          check: m.check, manual: i, page, breakpoint: width, category: CATEGORIES.includes(d.category) ? d.category : (m.check === 'content' ? 'copy' : 'dev'), selector: d.selector || null, found: d.found, expected: d.expected,
          where: d.where || null, zone: m.check === 'menu' ? 'header' : null,
          target: targetOf(d.target || review.targets?.[manualIds.get(key)]),
          // the defect card shows its own picture: d.shot picks one of the check's shots, the first by default
          ...(shot ? { shot } : {}), marked,
          review: { verdict: d.verified === 'unable' ? 'unsure' : 'confirmed', note: d.verified === 'unable' ? `${how}; the second check could not repeat it either way` : `${how}, repeated by a second check` },
        })
      }
    }
    if (m.status === 'defect' && !(m.defects || []).length) throw new Error(`${at}: status defect without defects`)
    checks.push({ index: i, check: m.check, form: [].concat(m.form ?? []).map(String), title: m.title ? String(m.title) : null, steps: (m.steps || []).map(String), page: m.page, width, status: m.status, checked: m.checked ? String(m.checked) : null, shots })
  })
  for (const f of findings) {
    if (f.marked) continue
    const e = evidence[evidenceKey(f)]
    if (e?.status === 'ok' && e.path && existsSync(e.path)) { f.shot = e.path; f.shotWidth = e.width; if (e.spot) f.spot = e.spot }
    else if (e) { f.evidenceStatus = e.status; if (e.why) f.spot = { note: e.why } }
  }
  return { checks, findings, notReproduced }
}

// How Claude settles a finding the engine could not, in a real browser
// (Playwright MCP) rather than by fetching HTML. Shown by `qc findings`.
export const VERIFY = {
  E1: 'Playwright: open the link in the browser (navigate). Did the page open and is it the right page? Bot protection returns 403/406 only to scripts',
  F12: 'Playwright: click the link. Did a popup/form open or did it scroll to a block? Then it is a trigger, not a dead link',
  J3: 'Playwright: screenshot the element at its width. Is the text visible and readable? Hidden (screen-reader) text does not count',
  F1: 'Playwright: hover the mouse and compare screenshots or computed style before and after',
  F4: 'Playwright: hover and click. Does the element do anything?',
  X1: 'Playwright: open the page and read the console. Is the error from the site or from a third-party widget (captcha, chat)?',
  B6: 'Playwright: screenshot at this width. Do the elements really overlap?',
  C2: 'Playwright: screenshot at this width. Is there horizontal scroll or cut-off content?',
  B3: 'Visual review: look at the spot on its piece (a hint in qc tiles). Is the block really empty, or a band of colour by design?',
  B5: 'Visual review: look at the spot on its piece (a hint in qc tiles). Does the text really stick out of a visible box?',
  B9: 'Visual review: look at the spot on its piece (a hint in qc tiles). Is there really no gap between the icon and the text?',
}

// Rules whose findings are a judgement, not a measurement: whether two lists
// are meant to be one, whether a city is foreign to this business, whether two
// claims contradict. The engine only proposes candidates; Claude decides each
// one by reading the page, and only a confirmed or unsure one reaches the
// report. `og:site_name` (H17) is a fact, not a judgement.
export const JUDGED = {
  H14: 'Claude: is this list meant to be the same on every page (insurers, service areas, what is included)? Lists that only share a heading — recipe ingredients, menus, product specs, posts — differ by design: false-positive',
  H12: 'Claude: is the place really foreign to this business (not a city it serves, not a neighbourhood, not a name like West New York or a person’s name)?',
  H16: 'Claude: read both places. Do the two claims really contradict for a visitor, or do they speak about different services, plans or locations?',
  H17: 'Claude: is it really another spelling of the brand, or the brand plus what the business does, a legal name, a product name?',
  G13: 'Claude: should a visitor be able to pick this service in the form, or is the form for something else (a job, a newsletter, a single service)?',
  E16: 'Claude: is this really a service of the business that the hub or footer should list, or a sub-page, an add-on, a location?',
  E17: 'Claude: does the CTA promise something this page does not offer, or is it worded generally on purpose?',
  E2: 'Claude: should the same link text go to one place? «Learn more» and «Read more» naturally go to different pages',
  E15: 'Claude: is the link really useless for a visitor, or does it help (a logo to home, a breadcrumb, a skip link)?',
  I21: 'Claude: does the page really look copied from the other one, or do they share a heading for a reason (a product and its hub)?',
  H6: 'Claude: is it really placeholder text a visitor would see, or a real word (a «TBD» in a post, a sample in a how-to)?',
  I20: 'Claude: does the schema really say something the page does not, or is it the same fact written differently?',
}
export const isJudged = (f) => Boolean(JUDGED[f.rule]) && !(f.rule === 'H17' && /og:site_name/.test(String(f.found || '')))
// Rules whose script result is a guess about what a visitor sees or what a
// click does: right about a third of the time on real sites. Like every
// heuristic, they are candidates until Claude has checked them in a browser.
const BROWSER_CHECKED = new Set(['F12', 'X1', 'J3', 'F1', 'F4'])
// Only what a script measures without error (a missing tel:, a heading level,
// a 404, a horizontal scroll) reaches the report on its own; everything else
// needs Claude's verdict.
export const isCandidate = (f) => isJudged(f) || f.confidence === 'heuristic' || BROWSER_CHECKED.has(f.rule)

// Claude's look at a piece, kept by the hash of its pixels: the same picture
// on the next run needs no second look, and its defects carry over.
const cachePath = (host) => join(snapshotDir(host), 'visual-cache.json')
export const loadVisualCache = (host) => (existsSync(cachePath(host)) ? JSON.parse(readFileSync(cachePath(host), 'utf8')) : {})
// the cached look at a piece: any of the pixel hashes it was seen under
const cachedLook = (cache, t) => (t.hashes || [t.hash]).filter(Boolean).map(h => cache[`${t.width}|${h}`]).find(Boolean)
const tilesOf = (dir) => (existsSync(join(dir, 'tiles.json')) ? JSON.parse(readFileSync(join(dir, 'tiles.json'), 'utf8')) : null)
// Script measurements that point the visual review at a spot (y on the page).
export const HINT_RULES = new Set(['B3', 'B5', 'B9', 'C2', 'B6'])

// The screen pieces of the latest run (tiles.json, written by qc audit),
// grouped for splitting between visual agents: a piece shown on several
// pages once, the rest by page type and page. Pieces seen on an earlier run
// (the same pixels) are left out; script hints are attached to their piece.
export function listTiles(host) {
  const { dir, findings, input } = runOf(host)
  const manifest = tilesOf(dir)
  if (!manifest) throw new Error(`no screen pieces in ${dir}: run qc browse, then qc audit`)
  const cache = loadVisualCache(host)
  const ids = idsFor(findings, input.pages)
  const hints = new Map()
  for (const f of findings) {
    if (!HINT_RULES.has(f.rule) || !Number.isFinite(f.y)) continue
    const t = manifest.tiles.find(t => t.width === f.breakpoint && (t.places || [t]).some(p => (p.page || t.page) === f.page && p.top <= f.y && f.y < p.bottom))
    if (!t) continue
    const list = hints.get(t.id) || []
    const id = ids[defectIdentity(f)]
    if (!list.some(h => h.id === id)) list.push({ id, rule: f.rule, found: f.found })
    hints.set(t.id, list)
  }
  const byType = { shared: {} }
  let cached = 0
  for (const t of manifest.tiles) {
    if (cachedLook(cache, t)) { cached++; continue }
    const n = new Set((t.places || []).map(p => p.page)).size
    const piece = { id: t.id, width: t.width, file: t.file, top: t.top, bottom: t.bottom, kind: t.kind, ...(n > 1 ? { pages: n } : {}), ...(hints.has(t.id) ? { hints: hints.get(t.id) } : {}) }
    const [type, page] = n > 1 ? ['shared', 'on several pages'] : [t.type, t.page]
    ;((byType[type] ||= {})[page] ||= []).push(piece)
  }
  if (!Object.keys(byType.shared).length) delete byType.shared
  return { runDir: dir, total: manifest.tiles.length, cached, toLook: manifest.tiles.length - cached, missing: manifest.missing, byType }
}

// "T3", "T3-T9" or "T3–T9" -> every id named.
function tileIds(list) {
  const out = new Set()
  for (const x of list || []) {
    const m = String(x).trim().match(/^T(\d+)(?:\s*[-–]\s*T?(\d+))?$/)
    if (!m) throw new Error(`review: «${x}» is not a tile id like T12 or T12-T18`)
    for (let n = Number(m[1]); n <= Number(m[2] || m[1]); n++) out.add(`T${n}`)
  }
  return out
}

// Which pieces the visual entries say Claude looked at, against every piece there is.
export function tileCoverage(dir, review) {
  const manifest = tilesOf(dir)
  if (!manifest) return null
  const { tiles, missing } = manifest
  const seen = new Set()
  for (const m of review.manual || []) if (m?.check === 'visual') for (const id of tileIds(m.tiles)) seen.add(id)
  const unseen = tiles.filter(t => !seen.has(t.id))
  return {
    total: tiles.length, seen: tiles.length - unseen.length,
    unseen: unseen.slice(0, 100).map(t => `${t.id} ${t.page} ${t.width}px ${t.top}-${t.bottom}`),
    unseenPages: [...new Set(unseen.flatMap(t => (t.places || [t]).map(p => p.page || t.page)))].length, missing: missing.length,
  }
}

const CARRIED = ['rule', 'title', 'impact', 'found', 'expected', 'category', 'verified', 'where', 'selector']

// Pieces the review did not look at whose pixels were looked at before: the
// earlier look is added as a visual entry, so they count as seen.
function fromCache(host, dir, review) {
  const manifest = tilesOf(dir)
  if (!manifest) return []
  const cache = loadVisualCache(host)
  const seen = new Set()
  for (const m of review.manual || []) if (m?.check === 'visual') for (const id of tileIds(m.tiles)) seen.add(id)
  return manifest.tiles.filter(t => !seen.has(t.id) && cachedLook(cache, t)).map(t => {
    const c = cachedLook(cache, t)
    return {
      check: 'visual', page: t.page, width: t.width, tiles: [t.id], status: c.defects?.length ? 'defect' : 'ok', fromCache: true,
      checked: `the same picture as on the QC of ${String(c.at).slice(0, 10)}; that look stands`,
      defects: (c.defects || []).map(d => ({ ...d, tile: t.id })),
    }
  })
}

// After a review: each piece's look by its pixels. Only entries whose every
// defect names its piece (`tile`) are kept, so a defect is never cached on
// the wrong piece and a piece with an unplaced defect is not cached as ok.
function saveVisualCache(host, dir, review) {
  const manifest = tilesOf(dir)
  if (!manifest) return
  const byId = new Map(manifest.tiles.map(t => [t.id, t]))
  const cache = loadVisualCache(host)
  const at = new Date().toISOString()
  for (const m of review.manual || []) {
    if (m?.check !== 'visual' || m.fromCache || (m.defects || []).some(d => !d.tile)) continue
    for (const id of tileIds(m.tiles)) {
      const t = byId.get(id)
      if (!t) continue
      const defects = (m.defects || []).filter(d => d.tile === id && d.verified !== 'not-reproduced').map(d => Object.fromEntries(CARRIED.filter(k => d[k] != null).map(k => [k, d[k]])))
      for (const h of (t.hashes || [t.hash]).filter(Boolean)) cache[`${t.width}|${h}`] = { at, ...(defects.length ? { defects } : {}) }
    }
  }
  mkdirSync(snapshotDir(host), { recursive: true })
  writeFileSync(cachePath(host), JSON.stringify(cache))
}

function runOf(host) {
  const dir = latestRunDir(host)
  if (!dir || !existsSync(join(dir, 'report-input.json'))) {
    throw new Error(`no run for ${host} made by this version: run qc audit first`)
  }
  const findings = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'))
  const input = JSON.parse(readFileSync(join(dir, 'report-input.json'), 'utf8'))
  const profile = existsSync(join(dir, 'profile.json')) ? JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')) : null
  return { dir, findings, input, profile }
}

export function distinctDefects(findings, totalPages) {
  const byId = new Map()
  for (const f of findings) {
    const identity = defectIdentity(f)
    if (!byId.has(identity)) {
      byId.set(identity, {
        identity, rule: f.rule, title: f.title, severity: f.severity, confidence: f.confidence,
        found: f.found, expected: f.expected, selector: f.selector, zones: new Set(), pages: [], examples: [],
      })
    }
    const d = byId.get(identity)
    if (f.zone) d.zones.add(f.zone)
    if (!d.pages.includes(f.page)) d.pages.push(f.page)
    if (d.examples.length < 3 && !d.examples.some(e => e.page === f.page)) d.examples.push({ page: f.page, where: f.where || null })
  }
  const order = { critical: 0, major: 1, minor: 2, note: 3 }
  return [...byId.values()]
    .sort((a, b) => (a.confidence === 'heuristic') - (b.confidence === 'heuristic') || order[a.severity] - order[b.severity] || b.pages.length - a.pages.length)
    .map((d, i) => ({ id: `D${i + 1}`, ...d, scope: scopeOf({ zones: d.zones, pages: d.pages, region: null }, totalPages), zones: [...d.zones], pageCount: d.pages.length, pages: d.pages.slice(0, 20) }))
}

// identity -> «D12» for the report, the same numbering `qc findings` prints.
export function idsFor(findings, totalPages) {
  return Object.fromEntries(distinctDefects(findings, totalPages).map(d => [d.identity, d.id]))
}

export function listFindings(host) {
  const { dir, findings, input, profile } = runOf(host)
  const defects = distinctDefects(findings, input.pages)
  writeFileSync(join(dir, 'distinct.json'), JSON.stringify(defects.map(d => ({ id: d.id, identity: d.identity }))))
  return {
    runDir: dir, profile,
    defects: defects.map(({ identity, ...d }) => (isJudged(d) ? { ...d, judge: JUDGED[d.rule] } : isCandidate(d) ? { ...d, verify: VERIFY[d.rule] || 'Playwright: open the page at this width and look at the spot. Is it what the finding says?' } : d)),
  }
}

// The run's findings split by Claude's verdicts: kept (with notes, plus the
// manual-check findings), rejected (false positives), and the manual checks.
export function sortByReview(dir, findings, review, host = null) {
  const ids = existsSync(join(dir, 'distinct.json')) ? JSON.parse(readFileSync(join(dir, 'distinct.json'), 'utf8')) : []
  const identityOf = new Map(ids.map(x => [x.id, x.identity]))
  const byIdentity = new Map()
  for (const item of review.items || []) {
    if (!VERDICTS.has(item.verdict)) throw new Error(`review ${item.id}: verdict must be confirmed, false-positive or unsure`)
    const identity = identityOf.get(item.id)
    if (!identity) throw new Error(`review: no defect ${item.id} in the last run (run qc findings first)`)
    if (item.category && !CATEGORIES.includes(item.category)) throw new Error(`review ${item.id}: category must be one of ${CATEGORIES.join(', ')}`)
    byIdentity.set(identity, { verdict: item.verdict, note: item.note ? String(item.note) : null, category: item.category || null, fix: item.fix ? String(item.fix) : null })
  }
  const kept = []
  const rejected = []
  const unjudged = new Set()
  for (let f of findings) {
    const r = byIdentity.get(defectIdentity(f))
    if (r?.category) f = { ...f, category: r.category }
    // Claude's own fix for this defect (the right link, the right address) replaces the rule's generic one.
    if (r?.fix) f = { ...f, expected: r.fix }
    // A candidate nobody checked is not a defect yet: left out.
    if (!r && isCandidate(f)) { unjudged.add(defectIdentity(f)); continue }
    if (r?.verdict === 'false-positive') rejected.push({ ...f, review: r })
    // A candidate Claude confirmed (by reading, in Playwright) is a defect: it counts.
    else if (r?.verdict === 'confirmed' && isCandidate(f)) kept.push({ ...f, confidence: 'high', confirmedHeuristic: true, review: r })
    // «Cannot tell from what I see» is a fair answer: it needs a person's look and does not count.
    else if (r?.verdict === 'unsure' && isCandidate(f)) kept.push({ ...f, confidence: 'heuristic', review: r })
    else kept.push(r ? { ...f, review: r } : f)
  }
  const manual = manualOf(review, dir, host)
  kept.push(...manual.findings)
  // review.fixes: {"D12": "…", "M3": "…"}, the looked-up fix for a defect, kept apart from the verdicts.
  const fixes = review.fixes && typeof review.fixes === 'object' ? review.fixes : {}
  const codeOf = new Map(ids.map(x => [x.identity, x.id]))
  for (let i = 0; i < kept.length; i++) {
    const code = kept[i].engine === 'claude' ? kept[i].id : codeOf.get(defectIdentity(kept[i]))
    if (code && fixes[code]) kept[i] = { ...kept[i], expected: String(fixes[code]) }
  }
  return { kept, rejected, manual, byIdentity, unjudged: unjudged.size }
}

// Every form the crawl found (profile.forms, by its Gravity Forms id) and whether a
// hand check or journey named it in `form`; «gform_5», «5» and «form 5» are one form.
const formNo = (v) => String(v).replace(/\D/g, '')
export function formCoverage(profile, checks) {
  const named = new Set(checks.flatMap(c => c.form || []).map(formNo).filter(Boolean))
  return (profile?.forms || []).filter(f => f.id && formNo(f.id)).map(f => {
    const pages = [...new Set(f.pages || [])]
    return { id: f.id, page: pages[0] || null, pages: pages.length, fields: (f.fields || []).map(x => x.label).filter(Boolean).slice(0, 3), checked: named.has(formNo(f.id)) }
  })
}

// The latest run as Claude left it (review.json, if `qc review` ran), for `qc push`.
export function reviewedRun(host) {
  const { dir, findings, input, profile } = runOf(host)
  const review = existsSync(join(dir, 'review.json')) ? JSON.parse(readFileSync(join(dir, 'review.json'), 'utf8')) : { items: [] }
  const sorted = sortByReview(dir, findings, review, host)
  return { dir, input, findings, review, ids: idsFor(findings, input.pages), ...sorted, forms: formCoverage(profile, sorted.manual.checks) }
}

export function applyReview(host, reviewPath) {
  const { dir, findings, input, profile } = runOf(host)
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'))
  review.manual = [...(review.manual || []).filter(m => !m?.fromCache), ...fromCache(host, dir, review)]
  attachEvidence(host, findings)
  const { kept, rejected, manual, byIdentity, unjudged } = sortByReview(dir, findings, review, host)
  linkScreenshots(kept, dir)
  const tiles = tileCoverage(dir, review)
  const forms = formCoverage(profile, manual.checks)
  const html = renderReport({ ...input, findings: kept, rejected, siteSummary: review.summary || null, manualChecks: manual.checks, ids: idsFor(findings, input.pages), unjudged, tiles, forms })
  writeFileSync(join(dir, 'report.html'), html)
  writeFileSync(join(dir, 'review.json'), JSON.stringify(review, null, 2))
  saveVisualCache(host, dir, review)
  const count = (v) => [...byIdentity.values()].filter(r => r.verdict === v).length
  return {
    host, runDir: dir, reportPath: join(dir, 'report.html'), verdict: verdict(kept), distinct: countDistinct(kept),
    reviewed: byIdentity.size, confirmed: count('confirmed'), falsePositive: count('false-positive'), unsure: count('unsure'),
    manualChecked: manual.checks.length, manualDefects: manual.findings.length, notReproduced: manual.notReproduced, unjudged,
    tiles,
    forms: { checked: forms.filter(f => f.checked).length, total: forms.length, notChecked: forms.filter(f => !f.checked).map(f => f.id) },
    journeys: manual.checks.filter(c => c.check === 'journey').map(c => ({ title: c.title, width: c.width, status: c.status })),
  }
}

// The words a content defect quotes, looked up on the pages it names in the
// crawled text: what a script settles without error, so the second check
// only has to judge whether the claim is right. Letters and digits only, so
// Markdown from the CMS (**, #, [link](url)) and spacing do not matter; a
// quote cut with «…» or « / » is looked up part by part.
const letters = (t) => String(t).replace(/\]\([^)]*\)/g, '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '')
export function checkQuotes(host, reviewPath) {
  const snap = loadSnapshot(host)
  if (!snap) throw new Error(`no crawl of ${host}: run qc audit first`)
  const textOf = new Map(snap.pages.map(p => [p.url.replace(/\/$/, ''), letters([p.title, p.metaDescription, p.text].filter(Boolean).join(' '))]))
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'))
  const out = []
  ;(review.manual || []).forEach((m, i) => {
    if (m?.check !== 'content') return
    for (const d of m.defects || []) {
      const quotes = [...String(d.found).matchAll(/«([^»]+)»|“([^”]+)”|"([^"]+)"/g)].map(x => x[1] || x[2] || x[3])
      const pages = d.pages?.length ? d.pages : [m.page]
      for (const q of quotes) {
        const parts = q.split(/…|\.\.\.|\s\/\s/).map(letters).filter(x => x.length >= 3)
        const where = pages.map(page => {
          const text = textOf.get(String(page).replace(/\/$/, ''))
          return { page, found: text == null ? null : parts.every(x => text.includes(x)) }
        })
        out.push({ entry: i, rule: d.rule, quote: q, onAPage: where.some(w => w.found), pages: where })
      }
    }
  })
  return { quotes: out.length, notFound: out.filter(q => !q.onAPage).length, items: out }
}
