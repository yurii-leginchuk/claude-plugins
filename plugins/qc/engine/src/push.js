// `qc push <host>`: the latest run's results -- not its HTML -- to the QC
// Reports site (a WordPress plugin, qc-reports.poirier.agency), where they
// become a public report people mark fixed. One POST for the run, then one
// per evidence picture (defect crops, manual-check screenshots); the
// full-page screenshots stay in the HTML report.
//
// Credentials: ~/.config/qc/reports.json {url, user, appPassword} or
// QC_REPORTS_URL / QC_REPORTS_USER / QC_REPORTS_APP_PASSWORD.
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { reviewedRun } from './review.js'
import { defectIdentity, verdict, countDistinct } from './report/json.js'
import { scopeOf } from './report/html.js'
import { spotText } from './browser/evidence.js'
import { categoryOf } from './report/category.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export function reportsConfig(env = process.env) {
  const file = join(homedir(), '.config', 'qc', 'reports.json')
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const cfg = {
    url: env.QC_REPORTS_URL || fromFile.url,
    user: env.QC_REPORTS_USER || fromFile.user,
    appPassword: env.QC_REPORTS_APP_PASSWORD || fromFile.appPassword,
  }
  if (!cfg.url || !cfg.user || !cfg.appPassword) {
    throw new Error(`no access to the reports site: fill in ${file} ({"url","user","appPassword"}) or set QC_REPORTS_URL/USER/APP_PASSWORD`)
  }
  return { ...cfg, url: cfg.url.replace(/\/+$/, '') }
}

// One entry per distinct defect, every page it is on with its `where`.
export function buildPayload(run) {
  const { input, kept, rejected, manual, ids, review, dir } = run
  const groups = new Map()
  for (const f of [...kept, ...rejected]) {
    const identity = defectIdentity(f)
    if (!groups.has(identity)) {
      groups.set(identity, {
        code: f.engine === 'claude' ? f.id : ids[identity], identity, rule: f.rule, title: f.title,
        severity: f.severity, confidence: f.confidence || 'high', engine: f.engine || 'static', check: f.check || '',
        found: f.found ?? '', expected: f.expected ?? '', selector: f.selector ?? '', review: f.review || null,
        category: categoryOf(f),
        zones: new Set(), region: f.region || null, pages: new Map(), breakpoints: new Set(), shots: new Set(),
      })
    }
    const g = groups.get(identity)
    if (f.zone) g.zones.add(f.zone)
    if (f.page && !g.pages.has(f.page)) g.pages.set(f.page, f.where || null)
    if (f.breakpoint != null) g.breakpoints.add(f.breakpoint)
    if (f.shot && existsSync(f.shot) && !rejected.includes(f)) g.shots.add(f.shot)
    if (f.designShot && existsSync(f.designShot) && !rejected.includes(f)) g.design = f.designShot
    if (!g.spot && f.spot) g.spot = spotText(f.spot, f.shotWidth)
  }
  const files = new Map()
  const defects = [...groups.values()].filter(g => g.code).map(g => {
    const pages = [...g.pages.keys()]
    for (const s of g.shots) files.set(basename(s), s)
    // the Figma side of a design defect travels as the first picture, named figma-…
    if (g.design) files.set(`figma-${basename(g.design)}`, g.design)
    return {
      code: g.code, identity: g.identity, rule: g.rule, title: g.title, severity: g.severity, confidence: g.confidence,
      engine: g.engine, check: g.check, category: g.category, found: g.found, expected: g.expected, selector: g.selector, review: g.review,
      scope: scopeOf({ zones: g.zones, pages, region: g.region }, input.pages),
      pages: pages.map(url => ({ url, where: g.pages.get(url) })), page_count: pages.length,
      breakpoints: [...g.breakpoints].sort((a, b) => a - b), evidence: [...(g.design ? [`figma-${basename(g.design)}`] : []), ...[...g.shots].map(s => basename(s))], spot: g.spot || '',
    }
  })
  // Pictures only for what failed: a check that passed sends none for now.
  const checks = manual.checks.map(c => {
    const evidence = c.status === 'ok' ? [] : (c.shots || []).map(src => basename(src))
    for (const name of evidence) files.set(name, join(dir, 'visual', name))
    // the same defect found on two checks is one entry on the site: link each check to that entry's code
    const codes = [...new Set(manual.findings.filter(f => f.manual === c.index).map(f => groups.get(defectIdentity(f))?.code || f.id))]
    return { check: c.check, title: c.title || '', steps: c.steps || [], defects: codes, page: c.page, width: c.width, status: c.status, checked: c.checked, evidence }
  })
  const withProblems = new Set([...kept].map(f => f.rule))
  const rulesPassed = (input.rules || []).filter(r => !withProblems.has(r.id))
  const solid = kept.filter(f => f.confidence !== 'heuristic')
  return {
    payload: {
      host: input.host, ran_at: input.ranAt || Date.now(), env: input.env, env_reason: input.envReason,
      pages: input.pages, verdict: verdict(kept), about: review.summary || '', engine_version: VERSION,
      stats: {
        distinct: countDistinct(solid), heuristics: countDistinct(kept.filter(f => f.confidence === 'heuristic')),
        diff: input.diff ? { added: input.diff.added?.length ?? 0, fixed: input.diff.fixed?.length ?? 0, remaining: input.diff.remaining?.length ?? 0 } : null,
        browserCoverage: input.browserCoverage || null, rejected: new Set(rejected.map(defectIdentity)).size, rulesPassed,
        forms: (run.forms || []).map(f => ({ id: f.id, page: f.page, pages: f.pages, fields: f.fields, checked: f.checked })),
        parts: (run.parts || []).map(f => ({ id: f.id, page: f.page, pages: f.pages, fields: f.fields, checked: f.checked })),
      },
      defects, manual: checks,
    },
    files,
  }
}

// The reports site takes English only (it refuses Cyrillic too); say which
// fields before sending, so the run can be translated and pushed again.
export function nonEnglishFields(payload) {
  const bad = []
  const scan = (v, path) => { if (typeof v === 'string' && /\p{Script=Cyrillic}/u.test(v)) bad.push(path) }
  scan(payload.about, 'about')
  scan(payload.env_reason, 'env_reason')
  for (const d of payload.defects) {
    for (const k of ['title', 'found', 'expected', 'selector', 'spot']) scan(d[k], `${d.code}.${k}`)
    scan(d.review?.note, `${d.code}.review.note`)
    d.pages.forEach((p, i) => scan(p.where, `${d.code}.pages.${i}.where`))
  }
  payload.manual.forEach((m, i) => {
    scan(m.checked, `manual.${i}.checked`)
    scan(m.title, `manual.${i}.title`)
    ;(m.steps || []).forEach((st, j) => scan(st, `manual.${i}.steps.${j}`))
  })
  return bad
}

async function call(cfg, method, path, body, fetchImpl) {
  const res = await fetchImpl(`${cfg.url}/wp-json/qc-reports/v1${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON: an error page */ }
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${json?.message || text.slice(0, 160)}`)
  return json
}

// The server takes about 1 MB per request (base64 included): a bigger PNG
// goes as WebP, drawn through Chromium's canvas, under a .webp name.
export const MAX_EVIDENCE_BYTES = 640 * 1024
export async function shrinkLarge(files, payload, { launch = null } = {}) {
  const big = [...files].filter(([name, path]) => /\.png$/i.test(name) && existsSync(path) && statSync(path).size > MAX_EVIDENCE_BYTES)
  if (!big.length) return
  const { launchBrowser } = await import('./browser/launch.js')
  const { browser, newPage } = await (launch || launchBrowser)()
  try {
    const page = await newPage()
    for (const [name, path] of big) {
      const uri = `data:image/png;base64,${readFileSync(path).toString('base64')}`
      let q = 0.85
      let out = null
      while (q >= 0.4) {
        out = await page.evaluate(async ({ uri, q }) => {
          const img = new Image(); img.src = uri; await img.decode()
          const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
          c.getContext('2d').drawImage(img, 0, 0)
          return c.toDataURL('image/webp', q).split(',')[1]
        }, { uri, q })
        if (out.length * 0.75 <= MAX_EVIDENCE_BYTES) break
        q -= 0.15
      }
      const webp = name.replace(/\.png$/i, '.webp')
      const to = path.replace(/\.png$/i, '.webp')
      writeFileSync(to, Buffer.from(out, 'base64'))
      files.delete(name)
      files.set(webp, to)
      for (const d of [...payload.defects, ...payload.manual]) d.evidence = (d.evidence || []).map(n => (n === name ? webp : n))
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function push(host, { fetchImpl = fetch, env = process.env } = {}) {
  const cfg = reportsConfig(env)
  const { payload, files } = buildPayload(reviewedRun(host))
  const bad = nonEnglishFields(payload)
  if (bad.length) {
    throw new Error(`QC Reports takes English only; translate these fields of the review and run qc review again: ${bad.slice(0, 15).join(', ')}${bad.length > 15 ? ` and ${bad.length - 15} more` : ''}`)
  }
  await shrinkLarge(files, payload)
  const saved = await call(cfg, 'POST', '/runs', payload, fetchImpl)
  const failed = []
  for (const [name, path] of files) {
    try {
      await call(cfg, 'POST', `/runs/${saved.run_key}/evidence`, { name, data: readFileSync(path).toString('base64') }, fetchImpl)
    } catch (e) {
      failed.push({ name, error: e.message })
    }
  }
  return {
    host, url: saved.url, runKey: saved.run_key, defects: saved.defects, manual: saved.manual,
    evidence: files.size - failed.length, evidenceFailed: failed,
  }
}
