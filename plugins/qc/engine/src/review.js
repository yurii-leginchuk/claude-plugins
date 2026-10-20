// Claude's review of a finished audit. `qc findings <host>` lists the latest
// run's distinct defects with short ids (D1, D2, …), where they are and the
// site profile; Claude checks them (reading pages where needed) and writes a
// review file; `qc review <host> <file>` re-renders the report with the
// verdicts: false positives move to their own section and stop counting,
// confirmed and unsure ones carry Claude's note.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { latestRunDir } from './crawl/store.js'
import { defectIdentity, verdict, countDistinct } from './report/json.js'
import { renderReport, scopeOf } from './report/html.js'

const VERDICTS = new Set(['confirmed', 'false-positive', 'unsure'])

function runOf(host) {
  const dir = latestRunDir(host)
  if (!dir || !existsSync(join(dir, 'report-input.json'))) {
    throw new Error(`нет запуска для ${host}, сделанного этой версией: сначала qc audit`)
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

export function listFindings(host) {
  const { dir, findings, input, profile } = runOf(host)
  const defects = distinctDefects(findings, input.pages)
  writeFileSync(join(dir, 'distinct.json'), JSON.stringify(defects.map(d => ({ id: d.id, identity: d.identity }))))
  return { runDir: dir, profile, defects: defects.map(({ identity, ...d }) => d) }
}

export function applyReview(host, reviewPath) {
  const { dir, findings, input } = runOf(host)
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'))
  const ids = existsSync(join(dir, 'distinct.json')) ? JSON.parse(readFileSync(join(dir, 'distinct.json'), 'utf8')) : []
  const identityOf = new Map(ids.map(x => [x.id, x.identity]))
  const byIdentity = new Map()
  for (const item of review.items || []) {
    if (!VERDICTS.has(item.verdict)) throw new Error(`ревью ${item.id}: verdict должен быть confirmed, false-positive или unsure`)
    const identity = identityOf.get(item.id)
    if (!identity) throw new Error(`ревью: нет дефекта ${item.id} в последнем запуске (сначала qc findings)`)
    byIdentity.set(identity, { verdict: item.verdict, note: item.note ? String(item.note) : null })
  }
  const kept = []
  const rejected = []
  for (const f of findings) {
    const r = byIdentity.get(defectIdentity(f))
    if (r?.verdict === 'false-positive') rejected.push({ ...f, review: r })
    else kept.push(r ? { ...f, review: r } : f)
  }
  const html = renderReport({ ...input, findings: kept, rejected, siteSummary: review.summary || null })
  writeFileSync(join(dir, 'report.html'), html)
  writeFileSync(join(dir, 'review.json'), JSON.stringify(review, null, 2))
  const count = (v) => [...byIdentity.values()].filter(r => r.verdict === v).length
  return {
    host, runDir: dir, reportPath: join(dir, 'report.html'), verdict: verdict(kept), distinct: countDistinct(kept),
    reviewed: byIdentity.size, confirmed: count('confirmed'), falsePositive: count('false-positive'), unsure: count('unsure'),
  }
}
