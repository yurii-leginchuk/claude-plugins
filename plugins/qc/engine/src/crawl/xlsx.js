// Minimal XLSX reader: ZIP central directory + SpreadsheetML. Enough for Google Sheets exports.
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const MIN_EOCD_SIZE = 22

// Locates the end-of-central-directory record and walks the central directory
// to extract every entry's (possibly compressed) bytes.
//
// This never trusts the input: buffers too small to hold an EOCD record, or
// missing the EOCD signature entirely, fail fast with a named error instead
// of reading out of bounds (Node's Buffer read*() already bounds-checks and
// throws, but that raw RangeError is not a useful message on its own -- any
// low-level failure while walking the central directory or inflating an
// entry is caught below and re-thrown as a single clear "corrupt or
// truncated zip archive" error).
function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_EOCD_SIZE) {
    throw new Error('not a zip archive: buffer too small')
  }

  let eocd = -1
  for (let i = buf.length - MIN_EOCD_SIZE; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive: end-of-central-directory signature not found')

  const files = new Map()
  try {
    const count = buf.readUInt16LE(eocd + 10)
    let p = buf.readUInt32LE(eocd + 16)

    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_DIR_SIGNATURE) break
      const method = buf.readUInt16LE(p + 10)
      const compSize = buf.readUInt32LE(p + 20)
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      const localOff = buf.readUInt32LE(p + 42)
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

      const lhNameLen = buf.readUInt16LE(localOff + 26)
      const lhExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      files.set(name, method === 0 ? raw : inflateRawSync(raw))

      p += 46 + nameLen + extraLen + commentLen
    }
  } catch (e) {
    throw new Error(`corrupt or truncated zip archive: ${e.message}`)
  }
  return files
}

const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&')

function sharedStrings(files) {
  const f = files.get('xl/sharedStrings.xml')
  if (!f) return []
  const xml = f.toString('utf8')
  // One <si> may hold several <t> runs (rich text); concatenate them so a
  // formatted cell doesn't come out truncated at the first run.
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decode(t[1])).join(''))
}

const colIndex = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '')
  if (!m) return 0
  return [...m[1]].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1
}

// Matches both self-closed cells (<c r="C4" s="1"/>, common for blank
// formatted cells) and open/close cells (<c r="A1" t="s"><v>0</v></c>) as two
// distinct alternatives.
//
// The brief's reference used a single pattern, <c([^>]*)>([\s\S]*?)<\/c>,
// which cannot tell a self-closed cell from an open one: its `[^>]*` attrs
// group happily swallows the trailing "/" of "/>", so the lazy body group
// then keeps consuming forward across the *next* cell's tags looking for the
// first "</c>" anywhere down the row. On a row with a self-closed cell that
// bug silently eats the following one or two real cells into the wrong
// cell's body (misparsing their inner <v> as the self-closed cell's own
// value) and desyncs every subsequent ref/body pairing for the rest of the
// row. Self-closed cells are extremely common in real spreadsheets (any
// blank cell that only carries a style), so this was not a corner case --
// it silently corrupted a large share of rows in the real strategy sheet
// fixture (verified: it undercounted populated Figma-link cells by roughly
// 4x before this fix).
const CELL_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g

function sheetRows(xml, strings) {
  return [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((rowM) => {
    const cells = []
    for (const c of rowM[1].matchAll(CELL_RE)) {
      const selfClosed = c[1] !== undefined
      const attrs = selfClosed ? c[1] : c[2]
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /t="([^"]+)"/.exec(attrs)?.[1]
      const body = selfClosed ? '' : c[3]
      let value = ''
      if (type === 's') {
        const i = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1)
        value = strings[i] ?? ''
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decode(t[1])).join('')
      } else {
        value = decode(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
      }
      cells[colIndex(ref)] = value
    }
    return Array.from(cells, (v) => v ?? '')
  })
}

export function readXlsx(buffer) {
  const files = unzip(Buffer.from(buffer))

  const wbFile = files.get('xl/workbook.xml')
  const relsFile = files.get('xl/_rels/workbook.xml.rels')
  if (!wbFile || !relsFile) {
    throw new Error('not a valid xlsx workbook: missing xl/workbook.xml or its relationships')
  }

  const strings = sharedStrings(files)
  const wbXml = wbFile.toString('utf8')
  const relsXml = relsFile.toString('utf8')

  const rels = new Map(
    [...relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
      .map(m => [m[1], m[2].replace(/^\/?xl\//, '')])
  )

  const sheets = [...wbXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(([, name, rid]) => {
    const target = rels.get(rid)
    const file = files.get(`xl/${target}`) || files.get(target)
    return { name: decode(name), rows: file ? sheetRows(file.toString('utf8'), strings) : [] }
  })

  return { sheets }
}
