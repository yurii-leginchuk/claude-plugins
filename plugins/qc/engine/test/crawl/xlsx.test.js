import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { readXlsx } from '../../src/crawl/xlsx.js'
import { pickPageList, loadStrategySheet } from '../../src/crawl/sheet.js'

const FIX = new URL('../fixtures/strategy.xlsx', import.meta.url)
const SHEET = 'https://docs.google.com/spreadsheets/d/13MQeTTUR85z6gbp1NPqVi7xJVQBn-bETZ3gTbMJu7Rc/export?format=xlsx'

async function fixture() {
  if (!existsSync(FIX)) {
    mkdirSync(new URL('../fixtures/', import.meta.url), { recursive: true })
    const res = await fetch(SHEET)
    writeFileSync(FIX, Buffer.from(await res.arrayBuffer()))
  }
  return readFileSync(FIX)
}

// --- brief's baseline tests ------------------------------------------------

test('readXlsx lists every worksheet by name', async () => {
  const wb = readXlsx(await fixture())
  const names = wb.sheets.map(s => s.name)
  assert.ok(names.includes('Phase 3 Page Design List'), `got ${names.join(', ')}`)
  assert.ok(names.includes('Phase 1'))
  // Other real tabs must show up too, not just the two the brief names --
  // pickPageList's job below is to pick the right one out of all of these.
  assert.ok(names.includes('Phases 2,3,4'))
  assert.ok(names.includes('Navigation'))
  assert.ok(names.includes('Navigation V2'))
  assert.ok(names.includes('locations'))
})

test('readXlsx returns rows as strings', async () => {
  const wb = readXlsx(await fixture())
  const s = wb.sheets.find(x => x.name === 'Phase 3 Page Design List')
  assert.ok(s.rows.length > 300)
  assert.ok(s.rows[0].includes('Page Name'))
})

test('pickPageList finds the page sheet and maps columns by meaning', async () => {
  const out = pickPageList(readXlsx(await fixture()))
  assert.equal(out.sheet, 'Phase 3 Page Design List')
  assert.ok(out.rows.length > 300)
  const withDev = out.rows.filter(r => r.devUrl)
  assert.ok(withDev.length > 40, `expected dev links, got ${withDev.length}`)
  assert.match(withDev[0].devUrl, /patest\.website/)
  assert.ok(out.rows.some(r => r.figma && r.figma.includes('figma.com')))
})

// --- ground truth about the real workbook, asserted on values, not just counts

// These ground-truth counts describe the raw sheet itself (its used range is
// literally rows 1-349, i.e. 348 data rows below the header, per the
// workbook's own _FilterDatabase defined name) -- not pickPageList's output.
// pickPageList additionally drops rows that have neither a URL nor a Dev
// Link (e.g. not-yet-built placeholder pages), which is why its returned
// `rows.length` and per-column counts are legitimately smaller than these.
// Asserting here, at the raw-sheet level, is what actually exercises
// cell-parsing correctness end to end.

test('the raw sheet has exactly 348 non-blank data rows, matching the known workbook', async () => {
  const wb = readXlsx(await fixture())
  const s = wb.sheets.find(x => x.name === 'Phase 3 Page Design List')
  const nonBlank = s.rows.slice(1).filter(row => row.some(cell => cell && String(cell).trim()))
  assert.equal(nonBlank.length, 348)
})

test('sparse columns (figma/dev/copyDoc) are counted exactly on the raw sheet, not just "some"', async () => {
  const wb = readXlsx(await fixture())
  const s = wb.sheets.find(x => x.name === 'Phase 3 Page Design List')
  const header = s.rows[0]
  const dataRows = s.rows.slice(1)
  const isReal = (v) => {
    const t = String(v || '').trim()
    return Boolean(t) && t.toUpperCase() !== 'NA' && t.toUpperCase() !== 'NEW PAGE'
  }
  const countCol = (name) => {
    const idx = header.indexOf(name)
    assert.ok(idx >= 0, `column "${name}" not found in header: ${header.join(', ')}`)
    return dataRows.filter(r => isReal(r[idx])).length
  }
  assert.equal(countCol('Figma Link'), 57)
  assert.equal(countCol('Dev Link'), 55)
  assert.equal(countCol('Copy Doc Link'), 8)
})

// Regression test for a real bug found while validating against this exact
// fixture: the initial cell regex (`<c([^>]*)>([\s\S]*?)<\/c>`) could not
// distinguish a self-closed cell (`<c r="J4" s="98"/>`, extremely common for
// any blank styled cell) from an open one. Its lazy body group would then
// keep scanning *forward*, past the self-closed cell's own "/>", swallowing
// the next one or two real cells into the wrong ref's body and desyncing
// every following ref/body pairing for the rest of the row. On this fixture
// that undercounted populated Figma-link cells by roughly 4x (14 seen vs 57
// actually present) before the fix -- a silent, wrong-column-data failure
// mode, not a crash, which is exactly the kind of bug "assert on values, not
// just counts" is meant to catch.
test('a self-closed cell in the middle of a row does not corrupt later cells in that row', async () => {
  const wb = readXlsx(await fixture())
  const s = wb.sheets.find(x => x.name === 'Phase 3 Page Design List')
  const header = s.rows[0]
  const figmaIdx = header.indexOf('Figma Link')
  const nonBlank = s.rows.slice(1).filter(row => row.some(cell => cell && String(cell).trim()))
  const withFigma = nonBlank.filter(r => r[figmaIdx] && /figma\.com/i.test(r[figmaIdx]))
  assert.equal(withFigma.length, 57, `expected 57 rows with a real figma.com value in the Figma Link column, got ${withFigma.length}`)
})

test('literal NA and NEW PAGE cell values are normalized to null, not left as text', async () => {
  const out = pickPageList(readXlsx(await fixture()))
  const values = out.rows.flatMap(r => [r.pageName, r.url, r.devUrl, r.figma, r.copyDoc, r.pageType])
  assert.ok(!values.includes('NA'), 'literal "NA" leaked through as a value')
  assert.ok(!values.includes('NEW PAGE'), 'literal "NEW PAGE" leaked through as a value')
})

// --- judgement call 1: column matching is by meaning, tested against real,
// confusable header pairs in the actual fixture header row.

test('URL column matches "URL" and not "Suggested URL" or "Asana Task Link"', async () => {
  const out = pickPageList(readXlsx(await fixture()))
  assert.ok(out.columns.url !== undefined, 'no url column matched at all')
  const matchedHeader = out.header[out.columns.url].trim()
  assert.equal(matchedHeader, 'URL')
  assert.notEqual(matchedHeader, 'Suggested URL')
  assert.notEqual(matchedHeader, 'Asana Task Link')
  // Both confusable columns must genuinely be present in this header row,
  // otherwise the assertion above proves nothing.
  assert.ok(out.header.includes('Suggested URL'), 'fixture header missing "Suggested URL"')
  assert.ok(out.header.includes('Asana Task Link'), 'fixture header missing "Asana Task Link"')
})

test('Dev Link column matches "Dev Link" and not "Developer"', async () => {
  const out = pickPageList(readXlsx(await fixture()))
  assert.ok(out.columns.devUrl !== undefined, 'no devUrl column matched at all')
  const matchedHeader = out.header[out.columns.devUrl].trim()
  assert.equal(matchedHeader, 'Dev Link')
  assert.notEqual(matchedHeader, 'Developer')
  assert.ok(out.header.includes('Developer'), 'fixture header missing "Developer"')
})

test('Copy Doc column matches "Copy Doc Link" and Figma matches "Figma Link", not each other', async () => {
  const out = pickPageList(readXlsx(await fixture()))
  assert.equal(out.header[out.columns.copyDoc].trim(), 'Copy Doc Link')
  assert.equal(out.header[out.columns.figma].trim(), 'Figma Link')
})

// --- judgement call 2: an unidentifiable sheet must fail loudly, naming the
// tabs it saw and the columns it looked for -- never silently return [].

test('pickPageList throws, naming tabs and sought columns, when no sheet matches', () => {
  const workbook = {
    sheets: [
      { name: 'Random Tab', rows: [['A', 'B', 'C'], ['1', '2', '3']] },
      { name: 'Notes', rows: [['Comment'], ['hi']] },
    ],
  }
  assert.throws(() => pickPageList(workbook), (err) => {
    assert.match(err.message, /Random Tab/)
    assert.match(err.message, /Notes/)
    assert.match(err.message, /URL/)
    assert.match(err.message, /Dev Link/)
    return true
  })
})

test('pickPageList throws on a workbook with no sheets at all', () => {
  assert.throws(() => pickPageList({ sheets: [] }), /URL|Dev Link/)
})

// --- judgement call 3: the ZIP reader must not trust its input.

test('readXlsx throws a clear error on random, non-zip bytes instead of hanging or reading OOB', () => {
  // Deterministic (all zero) so it can never coincidentally contain the
  // end-of-central-directory signature -- a truly random buffer would work
  // almost always too, but this removes even the theoretical flake.
  const junk = Buffer.alloc(500, 0)
  assert.throws(() => readXlsx(junk), /zip archive/i)
})

test('readXlsx throws a clear error on a tiny buffer smaller than an EOCD record', () => {
  assert.throws(() => readXlsx(Buffer.from('hi')), /zip archive/i)
})

test('readXlsx throws a clear error on a truncated real workbook', async () => {
  const buf = await fixture()
  const truncated = buf.subarray(0, Math.floor(buf.length / 3))
  assert.throws(() => readXlsx(truncated), /zip|xlsx/i)
})

test('readXlsx throws a clear error on a real workbook truncated near the very end', async () => {
  // Cuts off the last few bytes only, so the EOCD scan may or may not still
  // find a (now-corrupted-context) signature depending on comment length;
  // either way this must throw, never hang or silently return partial data.
  const buf = await fixture()
  const truncated = buf.subarray(0, buf.length - 4)
  assert.throws(() => readXlsx(truncated), /zip|xlsx/i)
})

// --- judgement call 4: shared strings with multiple <t> runs must not be
// truncated at the first run. Verified independently against the real
// fixture: this test extracts and inflates xl/sharedStrings.xml itself
// (without calling into xlsx.js) so it cannot share a bug with the
// implementation under test.

function independentlyExtractZipEntry(buf, targetName) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const compSize = buf.readUInt32LE(p + 20)
    const method = buf.readUInt16LE(p + 10)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === targetName) {
      const lhNameLen = buf.readUInt16LE(localOff + 26)
      const lhExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      return method === 0 ? raw : inflateRawSync(raw)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

const independentDecode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&')

test('rich-text shared strings (multiple <t> runs in one <si>) are not truncated at the first run', async () => {
  const buf = await fixture()
  const raw = independentlyExtractZipEntry(buf, 'xl/sharedStrings.xml')
  assert.ok(raw, 'xl/sharedStrings.xml not found in fixture by the independent extractor')
  const xml = raw.toString('utf8')

  const multiRunJoined = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => independentDecode(t[1])))
    .filter(runs => runs.length > 1)
    .map(runs => runs.join(''))
    .filter(joined => joined.trim().length > 0)

  assert.ok(multiRunJoined.length > 0, 'fixture has no multi-run <si> entries to verify truncation against')

  const wb = readXlsx(buf)
  const allValues = new Set()
  for (const s of wb.sheets) for (const row of s.rows) for (const v of row) if (v) allValues.add(v)

  for (const joined of multiRunJoined) {
    assert.ok(
      allValues.has(joined),
      `expected a rich-text value to appear intact and unsplit: ${JSON.stringify(joined.slice(0, 80))}`
    )
  }
})

// --- loadStrategySheet: downloads the workbook exactly once ---------------
//
// The brief's reference implementation checked status via fetchOne (which
// reads the body as text) and then re-fetched the bytes via a second global
// fetch call -- two downloads of a multi-hundred-row binary workbook for
// every strategy-sheet load. That is wrong: fetchOne's text body would also
// have corrupted the binary ZIP had it been used for the real bytes. The
// fix fetches bytes directly with a single global fetch call and checks
// `response.ok` on that same response. This test proves it: it stubs global
// fetch (serving the cached fixture bytes, so it stays offline-safe) and
// counts how many times it is invoked.

test('loadStrategySheet downloads the workbook exactly once', async () => {
  const buf = await fixture()
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++
    assert.match(String(url), /export\?format=xlsx/)
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      },
    }
  }
  try {
    const out = await loadStrategySheet(SHEET)
    assert.equal(calls, 1, `expected exactly one fetch call, got ${calls}`)
    assert.equal(out.sheet, 'Phase 3 Page Design List')
    // Must match pickPageList(readXlsx(bytes)) on the very same bytes exactly
    // -- loadStrategySheet is not allowed to do anything different with the
    // response than that pipeline.
    const expected = pickPageList(readXlsx(buf))
    assert.equal(out.rows.length, expected.rows.length)
    assert.deepEqual(out.rows[0], expected.rows[0])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('loadStrategySheet surfaces a non-ok response as a clear error, without a second request', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: false, status: 403, async arrayBuffer() { return new ArrayBuffer(0) } }
  }
  try {
    await assert.rejects(() => loadStrategySheet(SHEET), /403/)
    assert.equal(calls, 1, `expected exactly one fetch call even on failure, got ${calls}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('loadStrategySheet rejects a URL that is not a Google Sheets link', async () => {
  await assert.rejects(() => loadStrategySheet('https://example.com/not-a-sheet'), /Google Sheets/)
})

// --- loadStrategySheet: the download is bounded, never an unbounded hang --
//
// Every other network call in this engine runs through fetchOne's 20s
// timeout. loadStrategySheet's single download bypasses fetchOne (on
// purpose -- fetchOne decodes bodies as text, which would corrupt the
// binary ZIP) but must still be bounded the same way, or an unattended QC
// run across a portfolio of sites can hang forever on one stalled
// connection to Google's export endpoint.
//
// The stub below deliberately ignores the AbortSignal it's given (as a
// naive `fetch` implementation might) and never settles, so this test only
// passes if loadStrategySheet enforces the bound itself rather than relying
// entirely on the callee to honour the signal.
test('loadStrategySheet is bounded by a timeout and never hangs on a stalled connection', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => {
    calls++
    return new Promise(() => {}) // never settles, ignores any signal passed in
  }
  const started = Date.now()
  try {
    await assert.rejects(
      () => loadStrategySheet(SHEET, { timeout: 50 }),
      /(таймаут|время ожидания|timed? ?out)/i
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `expected the call to reject quickly after the 50ms timeout, took ${elapsed}ms`)
    assert.equal(calls, 1, `expected exactly one fetch call even on timeout, got ${calls}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

// The existing single-download guarantee must survive the timeout fix.
test('loadStrategySheet still downloads exactly once when the timeout path is not hit', async () => {
  const buf = await fixture()
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      },
    }
  }
  try {
    const out = await loadStrategySheet(SHEET, { timeout: 5000 })
    assert.equal(calls, 1, `expected exactly one fetch call, got ${calls}`)
    assert.equal(out.sheet, 'Phase 3 Page Design List')
  } finally {
    globalThis.fetch = realFetch
  }
})
