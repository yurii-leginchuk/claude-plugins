// Tests for the Task 9 review findings:
//   Critical -- persisting discovered breakpoint widths into snapshot meta
//     must not reset the snapshot's freshness clock (savedAt).
//   Important -- a resumed `browse` must still report the site's full
//     accumulated findings, not just what THIS invocation newly processed.
//   Important -- --only/--skip mean something different in `browse` than in
//     `audit`, and that difference must be visible to the user, not just a
//     code comment.
//
// Every test below points QC_CACHE_DIR at a fresh temp directory -- never
// the real ~/.qc-cache.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const CWD = new URL('../..', import.meta.url).pathname
const env = (cache) => ({ ...process.env, QC_CACHE_DIR: cache })

const PAGE = (base) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>
<link rel="canonical" href="${base}/a"><style>@media (max-width:1230px){.x{display:none}}</style>
</head><body><header>h</header><main><h1>Hi</h1><div style="width:3000px">wide</div></main></body></html>`

function makeServer() {
  let base
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${base}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<urlset><url><loc>${base}/a</loc></url></urlset>`)
    }
    if (req.url === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(PAGE(base))
    }
    res.writeHead(404); res.end('no')
  })
  return { server, setBase: (b) => { base = b } }
}

// --- Critical: preserving savedAt --------------------------------------

let s1, s1base, s1cache, s1setBase

before(async () => {
  s1cache = mkdtempSync(join(tmpdir(), 'qc-cli-browse-savedat-'))
  ;({ server: s1, setBase: s1setBase } = makeServer())
  await new Promise(r => s1.listen(0, r))
  s1base = `http://127.0.0.1:${s1.address().port}`
  s1setBase(s1base)
})
after(() => { s1.close(); rmSync(s1cache, { recursive: true, force: true }) })

test('a store-level saveSnapshot with preserveSavedAt keeps the existing timestamp', async () => {
  const store = await import('../../src/crawl/store.js')
  const original = process.env.QC_CACHE_DIR
  process.env.QC_CACHE_DIR = s1cache
  try {
    store.saveSnapshot('preserve-example.test', {
      meta: { host: 'preserve-example.test' }, pages: [{ url: 'https://preserve-example.test/a' }],
    })
    const before = store.loadSnapshot('preserve-example.test').meta.savedAt
    const backdated = before - 30 * 86400000 // 30 days in the past
    const metaPath = join(store.snapshotDir('preserve-example.test'), 'meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    writeFileSync(metaPath, JSON.stringify({ ...meta, savedAt: backdated }, null, 2))

    store.saveSnapshot('preserve-example.test', {
      meta: { host: 'preserve-example.test', extra: 'x' },
      pages: [{ url: 'https://preserve-example.test/a' }],
      preserveSavedAt: true,
    })
    const after = store.loadSnapshot('preserve-example.test')
    assert.equal(after.meta.savedAt, backdated, 'savedAt must be carried forward unchanged')
    assert.equal(after.meta.extra, 'x', 'the new meta fields must still be written')
  } finally {
    process.env.QC_CACHE_DIR = original
  }
})

test('browse persisting discovered widths does not reset the snapshot freshness clock', async () => {
  await run('node', ['src/cli.js', 'audit', s1base, '--env', 'prod'], { cwd: CWD, env: env(s1cache) })

  const store = await import('../../src/crawl/store.js')
  const original = process.env.QC_CACHE_DIR
  process.env.QC_CACHE_DIR = s1cache
  let backdated
  try {
    const snap = store.loadSnapshot('127.0.0.1')
    backdated = snap.meta.savedAt - 14 * 86400000 // 14 days -- past the 7-day TTL
    const metaPath = join(store.snapshotDir('127.0.0.1'), 'meta.json')
    writeFileSync(metaPath, JSON.stringify({ ...snap.meta, savedAt: backdated }, null, 2))
  } finally {
    process.env.QC_CACHE_DIR = original
  }

  // This browse call has no stored browserWidths yet, so it discovers them
  // from CSS and persists them into meta -- exactly the path under review.
  await run('node', ['src/cli.js', 'browse', s1base], { cwd: CWD, env: env(s1cache) })

  process.env.QC_CACHE_DIR = s1cache
  let savedAtAfter
  try {
    savedAtAfter = store.loadSnapshot('127.0.0.1').meta.savedAt
  } finally {
    process.env.QC_CACHE_DIR = original
  }
  assert.equal(savedAtAfter, backdated, 'browse must not have reset savedAt while persisting widths')

  // Confirm this actually matters end to end: a following plain `audit`
  // (no --fresh) must treat the snapshot as stale (past the 7-day TTL) and
  // perform a live crawl, not silently reuse two-week-old data as current.
  const { stdout } = await run('node', ['src/cli.js', 'audit', s1base, '--env', 'prod'], { cwd: CWD, env: env(s1cache) })
  const summary = JSON.parse(stdout)
  assert.equal(summary.fromCache, false, 'a snapshot older than SNAPSHOT_TTL_MS must not be reused as fresh')
})

// --- Important: resumed browse must not report zero findings ------------

let s2, s2base, s2cache, s2setBase

before(async () => {
  s2cache = mkdtempSync(join(tmpdir(), 'qc-cli-browse-resume-'))
  ;({ server: s2, setBase: s2setBase } = makeServer())
  await new Promise(r => s2.listen(0, r))
  s2base = `http://127.0.0.1:${s2.address().port}`
  s2setBase(s2base)
})
after(() => { s2.close(); rmSync(s2cache, { recursive: true, force: true }) })

test('a resumed browse reports the same findings as the first run, not an empty list', async () => {
  await run('node', ['src/cli.js', 'audit', s2base, '--env', 'prod'], { cwd: CWD, env: env(s2cache) })

  const first = JSON.parse(
    (await run('node', ['src/cli.js', 'browse', s2base], { cwd: CWD, env: env(s2cache) })).stdout
  )
  assert.ok(first.findings.length > 0, 'sanity: the first run must have found something')
  assert.ok(first.findings.some(f => f.rule === 'C1'))

  const resumed = JSON.parse(
    (await run('node', ['src/cli.js', 'browse', s2base], { cwd: CWD, env: env(s2cache) })).stdout
  )
  assert.equal(resumed.pagesDone, 0, 'sanity: the resumed run does no new page work')
  assert.deepEqual(
    resumed.findings.map(f => f.rule).sort(),
    first.findings.map(f => f.rule).sort(),
    'a resumed run must still report the previously-recorded findings, not an empty array'
  )
  assert.equal(resumed.findings.length, first.findings.length)
})

// --- Important: --only/--skip semantics differ from audit ---------------

let s3, s3base, s3cache, s3setBase

before(async () => {
  s3cache = mkdtempSync(join(tmpdir(), 'qc-cli-browse-onlyskip-'))
  ;({ server: s3, setBase: s3setBase } = makeServer())
  await new Promise(r => s3.listen(0, r))
  s3base = `http://127.0.0.1:${s3.address().port}`
  s3setBase(s3base)
})
after(() => { s3.close(); rmSync(s3cache, { recursive: true, force: true }) })

test('using --only or --skip on browse surfaces a note explaining the different meaning vs audit', async () => {
  await run('node', ['src/cli.js', 'audit', s3base, '--env', 'prod'], { cwd: CWD, env: env(s3cache) })
  const { stdout } = await run(
    'node', ['src/cli.js', 'browse', s3base, '--only', 'C1'], { cwd: CWD, env: env(s3cache) })
  const s = JSON.parse(stdout)

  assert.ok(s.findings.every(f => f.rule === 'C1'), 'the printed findings are still filtered')
  assert.ok(
    s.notes.some(n => /--only\/--skip/.test(n) && /audit/.test(n)),
    `expected a note explaining the audit-vs-browse difference, got: ${JSON.stringify(s.notes)}`
  )
})

test('the CLI usage text documents the different --only/--skip meaning for browse', async () => {
  // No subcommand -> prints USAGE and exits non-zero.
  await assert.rejects(
    () => run('node', ['src/cli.js'], { cwd: CWD, env: env(s3cache) }),
    (e) => /browse/.test(String(e.stdout)) && /audit/.test(String(e.stdout)) &&
           /--only\/--skip/.test(String(e.stdout))
  )
})
