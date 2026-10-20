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

const VERDICTS = new Set(['confirmed', 'false-positive', 'unsure'])
const STATUSES = new Set(['ok', 'defect', 'skipped'])
const SEVERITIES = new Set(['critical', 'major', 'minor', 'note'])

// What Claude checks by hand in Playwright (and, for `content`, by reading
// the pages), with the taxonomy codes each check may report. The engine
// never clicks or reads for meaning; these are the parts it leaves to Claude.
export const MANUAL_CHECKS = {
  menu: ['D1', 'C6', 'C9', 'D9', 'D2', 'B6'],
  popup: ['K4', 'C6', 'D9', 'J2', 'B6'],
  form: ['G2', 'G3', 'G5', 'G6', 'G7', 'G11', 'G12', 'G14', 'J5'],
  faq: ['F9', 'C2', 'J2'],
  focus: ['J2', 'J5'],
  content: ['H16', 'H8', 'H3', 'H12', 'E17'],
}
export const MANUAL_TITLES = {
  D1: 'Меню или подменю не открывается', C6: 'Не помещается в экран', C9: 'Мобильное меню не прокручивается',
  D9: 'Не закрывается', D2: 'Мобильное и десктопное меню расходятся', B6: 'Перекрытие элементов',
  K4: 'Попап не работает', J2: 'Не работает с клавиатуры', J5: 'Доступность (ADA)',
  G2: 'Чекбокс согласия не обязателен', G3: 'Обязательное поле без *', G5: 'Телефон принимает не цифры',
  G6: 'Email не обязателен', G7: 'Кнопка отправки пропадает после ошибки', G11: 'Раскладка полей формы',
  G12: 'Активное поле не подсвечивается', G14: 'Форма не отправляется или прыгает наверх',
  F9: 'Аккордеон работает неправильно', C2: 'Элемент не влезает в экран',
  H16: 'Страницы противоречат друг другу', H8: 'Дубль текста', H3: 'Опечатка', H12: 'Чужой город или штат',
  E17: 'Текст обещает не то, что есть на сайте',
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
    const at = `ревью manual[${i}]`
    if (!m || !MANUAL_CHECKS[m.check]) throw new Error(`${at}: check должен быть одним из ${Object.keys(MANUAL_CHECKS).join(', ')}`)
    if (!m.page) throw new Error(`${at}: нужен page`)
    if (m.check !== 'content' && !Number.isFinite(Number(m.width))) throw new Error(`${at}: нужен width`)
    if (!STATUSES.has(m.status)) throw new Error(`${at}: status должен быть ok, defect или skipped`)
    const width = m.width == null ? null : Number(m.width)
    const shots = (m.shots || []).map((src, j) => {
      if (!existsSync(src)) throw new Error(`${at}: нет файла скриншота ${src}`)
      mkdirSync(join(dir, 'visual'), { recursive: true })
      const name = `manual-${i}-${j}${extname(src) || '.png'}`
      copyFileSync(src, join(dir, 'visual', name))
      return `visual/${name}`
    })
    for (const d of m.defects || []) {
      if (!MANUAL_CHECKS[m.check].includes(d.rule)) throw new Error(`${at}: rule для ${m.check} должен быть одним из ${MANUAL_CHECKS[m.check].join(', ')}`)
      if (!SEVERITIES.has(d.severity)) throw new Error(`${at}: severity должен быть critical, major, minor или note`)
      if (!d.found || !d.expected) throw new Error(`${at}: у дефекта нужны found и expected`)
      const key = `${i}|${d.rule}|${d.found}`
      if (!manualIds.has(key)) manualIds.set(key, `M${manualIds.size + 1}`)
      for (const page of d.pages?.length ? d.pages : [m.page]) {
        findings.push({
          id: manualIds.get(key),
          rule: d.rule, title: d.title || MANUAL_TITLES[d.rule], severity: d.severity, confidence: 'high', engine: 'claude',
          check: m.check, manual: i, page, breakpoint: width, selector: d.selector || null, found: d.found, expected: d.expected,
          where: d.where || null, zone: m.check === 'menu' ? 'header' : null,
          review: { verdict: 'confirmed', note: m.check === 'content' ? 'найдено Claude при чтении страниц' : 'проверено Claude в Playwright' },
        })
      }
    }
    if (m.status === 'defect' && !(m.defects || []).length) throw new Error(`${at}: status defect без defects`)
    checks.push({ index: i, check: m.check, page: m.page, width, status: m.status, checked: m.checked ? String(m.checked) : null, shots })
  })
  return { checks, findings }
}

// How Claude settles a finding the engine could not, in a real browser
// (Playwright MCP) rather than by fetching HTML. Shown by `qc findings`.
export const VERIFY = {
  E1: 'Playwright: открыть ссылку в браузере (navigate) — страница открылась и это та страница? Бот-защита отдаёт 403/406 только скрипту',
  F12: 'Playwright: нажать ссылку — открылся попап/форма или прокрутка к блоку? Тогда это триггер, а не мёртвая ссылка',
  J3: 'Playwright: скриншот элемента на его ширине — текст виден и читается? Скрытый (screen-reader) текст не в счёт',
  F1: 'Playwright: навести мышь (hover) и сравнить скриншоты или computed style до и после',
  F4: 'Playwright: навести мышь и нажать — элемент что-то делает?',
  X1: 'Playwright: открыть страницу и прочитать консоль — ошибка от сайта или от стороннего виджета (капча, чат)?',
  B6: 'Playwright: скриншот на этой ширине — элементы правда наезжают друг на друга?',
  C2: 'Playwright: скриншот на этой ширине — есть ли горизонтальный скролл или обрезанный контент?',
}

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
  const manual = manualOf(review, dir)
  kept.push(...manual.findings)
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
