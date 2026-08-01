import { readXlsx } from './xlsx.js'
import { normalizeUrl } from '../lib/url.js'

// Column headers differ per client, so match on meaning rather than exact text.
// Each pattern is checked against the *whole* trimmed header cell, so a
// column like "Suggested URL" or "Asana Task Link" cannot be mistaken for
// "URL", and "Developer" cannot be mistaken for "Dev Link".
const COLUMNS = {
  pageName: [/^page\s*name$/i, /^name$/i],
  url:      [/^url$/i, /live\s*url/i, /^page\s*url$/i],
  devUrl:   [/dev\s*link/i, /dev\s*url/i, /staging/i],
  figma:    [/figma/i],
  copyDoc:  [/copy\s*doc/i, /^copy$/i],
  pageType: [/page\s*type/i, /^type$/i],
}

// Human-readable labels for the error message when no sheet can be identified.
const COLUMN_LABELS = {
  pageName: 'Page Name',
  url: 'URL',
  devUrl: 'Dev Link',
  figma: 'Figma',
  copyDoc: 'Copy Doc',
  pageType: 'Page Type',
}

function mapHeader(header) {
  const out = {}
  header.forEach((cell, i) => {
    const text = String(cell || '').trim()
    if (!text) return
    for (const [key, patterns] of Object.entries(COLUMNS)) {
      if (out[key] === undefined && patterns.some(p => p.test(text))) out[key] = i
    }
  })
  return out
}

const clean = (v) => {
  const s = String(v ?? '').trim()
  return (!s || s.toUpperCase() === 'NA' || s.toUpperCase() === 'NEW PAGE') ? null : s
}

export function pickPageList(workbook) {
  let best = null
  for (const sheet of workbook.sheets) {
    if (!sheet.rows.length) continue
    const header = sheet.rows[0]
    const map = mapHeader(header)
    if (map.url === undefined && map.devUrl === undefined) continue
    const score = Object.keys(map).length * 1000 + sheet.rows.length
    if (!best || score > best.score) best = { sheet, header, map, score }
  }
  if (!best) {
    const tabNames = workbook.sheets.map(s => s.name)
    const wanted = Object.values(COLUMN_LABELS).join(', ')
    throw new Error(
      `не удалось найти лист со списком страниц: просмотрены вкладки [${tabNames.join(', ')}], ` +
      `искали колонки: ${wanted}`
    )
  }

  const at = (row, key) => (best.map[key] === undefined ? null : clean(row[best.map[key]]))
  const rows = best.sheet.rows.slice(1)
    .map(row => ({
      pageName: at(row, 'pageName'),
      url: normalizeUrl(at(row, 'url') || ''),
      devUrl: normalizeUrl(at(row, 'devUrl') || ''),
      figma: at(row, 'figma'),
      copyDoc: at(row, 'copyDoc'),
      pageType: at(row, 'pageType'),
    }))
    .filter(r => r.url || r.devUrl)

  return { sheet: best.sheet.name, header: best.header, columns: best.map, rows }
}

export async function loadStrategySheet(sheetUrl) {
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(sheetUrl)?.[1]
  if (!id) throw new Error(`не похоже на ссылку Google Sheets: ${sheetUrl}`)
  const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`

  // Download the workbook exactly once. fetchOne (Task 9) reads the body as
  // text, which would corrupt this binary ZIP -- so fetch the bytes directly
  // with global fetch and check status on that same response, instead of
  // probing status through one request and re-fetching bytes through another.
  const res = await fetch(exportUrl)
  if (!res.ok) throw new Error(`таблица недоступна: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  return pickPageList(readXlsx(buf))
}
