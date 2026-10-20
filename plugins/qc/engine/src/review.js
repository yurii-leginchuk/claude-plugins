// Claude's review of a finished audit. `qc findings <host>` lists the latest
// run's distinct defects with short ids (D1, D2, …), where they are and the
// site profile; Claude checks them (reading pages where needed) and writes a
// review file; `qc review <host> <file>` re-renders the report with the
// verdicts: false positives move to their own section and stop counting,
// confirmed and unsure ones carry Claude's note.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { latestRunDir } from './crawl/store.js'
import { defectIdentity, verdict, countDistinct } from './report/json.js'
import { renderReport, scopeOf } from './report/html.js'
import { inlineScreenshots } from './report/inline.js'
import { CATEGORIES } from './report/category.js'
import { attachEvidence } from './browser/evidence.js'

const VERDICTS = new Set(['confirmed', 'false-positive', 'unsure'])
const STATUSES = new Set(['ok', 'defect', 'skipped'])
const SEVERITIES = new Set(['critical', 'major', 'minor', 'note'])

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
}
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
function manualOf(review, dir) {
  const checks = []
  const findings = []
  const manualIds = new Map()
  const entries = [...(review.manual || []), ...(review.menu || []).map(m => ({ check: 'menu', ...m }))]
  entries.forEach((m, i) => {
    const at = `review manual[${i}]`
    if (!m || !MANUAL_CHECKS[m.check]) throw new Error(`${at}: check must be one of ${Object.keys(MANUAL_CHECKS).join(', ')}`)
    if (!m.page) throw new Error(`${at}: page is required`)
    if (m.check !== 'content' && !Number.isFinite(Number(m.width))) throw new Error(`${at}: width is required`)
    if (!STATUSES.has(m.status)) throw new Error(`${at}: status must be ok, defect or skipped`)
    const width = m.width == null ? null : Number(m.width)
    const shots = (m.shots || []).map((src, j) => {
      if (!existsSync(src)) throw new Error(`${at}: screenshot file not found: ${src}`)
      mkdirSync(join(dir, 'visual'), { recursive: true })
      const name = `manual-${i}-${j}${extname(src) || '.png'}`
      copyFileSync(src, join(dir, 'visual', name))
      return `visual/${name}`
    })
    for (const d of m.defects || []) {
      if (!MANUAL_CHECKS[m.check].includes(d.rule)) throw new Error(`${at}: rule for ${m.check} must be one of ${MANUAL_CHECKS[m.check].join(', ')}`)
      if (!SEVERITIES.has(d.severity)) throw new Error(`${at}: severity must be critical, major, minor or note`)
      if (!d.found || !d.expected) throw new Error(`${at}: a defect needs found and expected`)
      const key = `${i}|${d.rule}|${d.found}`
      if (!manualIds.has(key)) manualIds.set(key, `M${manualIds.size + 1}`)
      for (const page of d.pages?.length ? d.pages : [m.page]) {
        findings.push({
          id: manualIds.get(key),
          rule: d.rule, title: d.title || MANUAL_TITLES[d.rule], severity: d.severity, confidence: 'high', engine: 'claude',
          check: m.check, manual: i, page, breakpoint: width, category: CATEGORIES.includes(d.category) ? d.category : (m.check === 'content' ? 'copy' : 'dev'), selector: d.selector || null, found: d.found, expected: d.expected,
          where: d.where || null, zone: m.check === 'menu' ? 'header' : null,
          // the defect card shows its own picture: d.shot picks one of the check's shots, the first by default
          ...(shots.length ? { shot: join(dir, shots[d.shot] || shots[0]) } : {}),
          review: { verdict: 'confirmed', note: m.check === 'content' ? 'found by Claude while reading the pages' : 'checked by Claude in Playwright' },
        })
      }
    }
    if (m.status === 'defect' && !(m.defects || []).length) throw new Error(`${at}: status defect without defects`)
    checks.push({ index: i, check: m.check, page: m.page, width, status: m.status, checked: m.checked ? String(m.checked) : null, shots })
  })
  return { checks, findings }
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
  return { runDir: dir, profile, defects: defects.map(({ identity, ...d }) => (VERIFY[d.rule] && d.confidence === 'heuristic' ? { ...d, verify: VERIFY[d.rule] } : d)) }
}

// The run's findings split by Claude's verdicts: kept (with notes, plus the
// manual-check findings), rejected (false positives), and the manual checks.
function sortByReview(dir, findings, review) {
  const ids = existsSync(join(dir, 'distinct.json')) ? JSON.parse(readFileSync(join(dir, 'distinct.json'), 'utf8')) : []
  const identityOf = new Map(ids.map(x => [x.id, x.identity]))
  const byIdentity = new Map()
  for (const item of review.items || []) {
    if (!VERDICTS.has(item.verdict)) throw new Error(`review ${item.id}: verdict must be confirmed, false-positive or unsure`)
    const identity = identityOf.get(item.id)
    if (!identity) throw new Error(`review: no defect ${item.id} in the last run (run qc findings first)`)
    if (item.category && !CATEGORIES.includes(item.category)) throw new Error(`review ${item.id}: category must be one of ${CATEGORIES.join(', ')}`)
    byIdentity.set(identity, { verdict: item.verdict, note: item.note ? String(item.note) : null, category: item.category || null })
  }
  const kept = []
  const rejected = []
  for (let f of findings) {
    const r = byIdentity.get(defectIdentity(f))
    if (r?.category) f = { ...f, category: r.category }
    if (r?.verdict === 'false-positive') rejected.push({ ...f, review: r })
    // A heuristic Claude settled (in Playwright, by eye) is a defect: it counts.
    else if (r?.verdict === 'confirmed' && f.confidence === 'heuristic') kept.push({ ...f, confidence: 'high', confirmedHeuristic: true, review: r })
    else kept.push(r ? { ...f, review: r } : f)
  }
  const manual = manualOf(review, dir)
  kept.push(...manual.findings)
  return { kept, rejected, manual, byIdentity }
}

// The latest run as Claude left it (review.json, if `qc review` ran), for `qc push`.
export function reviewedRun(host) {
  const { dir, findings, input } = runOf(host)
  const review = existsSync(join(dir, 'review.json')) ? JSON.parse(readFileSync(join(dir, 'review.json'), 'utf8')) : { items: [] }
  return { dir, input, findings, review, ids: idsFor(findings, input.pages), ...sortByReview(dir, findings, review) }
}

export function applyReview(host, reviewPath) {
  const { dir, findings, input } = runOf(host)
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'))
  attachEvidence(host, findings)
  const { kept, rejected, manual, byIdentity } = sortByReview(dir, findings, review)
  inlineScreenshots([...kept, ...rejected])
  const html = renderReport({ ...input, findings: kept, rejected, siteSummary: review.summary || null, manualChecks: manual.checks, ids: idsFor(findings, input.pages) })
  writeFileSync(join(dir, 'report.html'), html)
  writeFileSync(join(dir, 'review.json'), JSON.stringify(review, null, 2))
  const count = (v) => [...byIdentity.values()].filter(r => r.verdict === v).length
  return {
    host, runDir: dir, reportPath: join(dir, 'report.html'), verdict: verdict(kept), distinct: countDistinct(kept),
    reviewed: byIdentity.size, confirmed: count('confirmed'), falsePositive: count('false-positive'), unsure: count('unsure'),
    manualChecked: manual.checks.length, manualDefects: manual.findings.length,
  }
}
