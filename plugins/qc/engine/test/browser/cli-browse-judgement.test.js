// Tests for the judgement calls Task 9's brief left open:
//   1. --concurrency is accepted but the browser page loop stays sequential
//      -- must be reported, never silently swallowed.
//   2. `unparseable` media conditions from resolveBreakpoints must reach the
//      summary, not vanish.
//   3. Breakpoint discovery samples more than just the snapshot's first
//      page, so a breakpoint that only shows up on an inner template is not
//      missed.
//
// Each area gets its own local http server / cache dir, isolated from the
// brief's own cli-browse.test.js.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const CWD = new URL('../..', import.meta.url).pathname

const env = (cache) => ({ ...process.env, QC_CACHE_DIR: cache })

// --- Judgement call 1: --concurrency --------------------------------------

let ccServer, ccBase, ccCache

before(async () => {
  ccCache = mkdtempSync(join(tmpdir(), 'qc-cli-browse-cc-'))
  ccServer = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${ccBase}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<urlset><url><loc>${ccBase}/a</loc></url></urlset>`)
    }
    if (req.url === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!doctype html><html><head><title>t</title></head><body><h1>hi</h1></body></html>')
    }
    res.writeHead(404); res.end('no')
  })
  await new Promise(r => ccServer.listen(0, r))
  ccBase = `http://127.0.0.1:${ccServer.address().port}`
})
after(() => { ccServer.close(); rmSync(ccCache, { recursive: true, force: true }) })

test('--concurrency is validated and reported, not silently ignored', async () => {
  await run('node', ['src/cli.js', 'audit', ccBase, '--env', 'prod'], { cwd: CWD, env: env(ccCache) })

  const { stdout } = await run(
    'node', ['src/cli.js', 'browse', ccBase, '--concurrency', '4'],
    { cwd: CWD, env: env(ccCache) })
  const s = JSON.parse(stdout)

  assert.equal(s.pagesDone, 1, 'the run still completes normally with the flag set')
  assert.equal(s.concurrencyIgnored, true, 'summary must say the page loop itself never saw the flag')
  assert.ok(
    s.notes.some(n => /--concurrency/.test(n) && /sequential/.test(n)),
    `expected a note explaining --concurrency was not applied to the page loop, got: ${JSON.stringify(s.notes)}`
  )
})

test('an invalid --concurrency value fails loudly instead of silently coercing', async () => {
  await assert.rejects(
    () => run('node', ['src/cli.js', 'browse', ccBase, '--concurrency', 'nope'], { cwd: CWD, env: env(ccCache) }),
    (e) => /--concurrency/.test(String(e.stderr))
  )
})

// --- Judgement calls 2 & 3: unparseable media conditions + multi-page sample

let mpServer, mpBase, mpCache

const HOME = (base) => `<!doctype html><html><head><title>home</title>
<style>@media (max-width: 900px){.a{color:red}}</style>
</head><body><h1>home</h1></body></html>`

// The inner/last page carries a media condition this engine CAN resolve
// (601px, distinct from the home page's 900px, so its presence in the
// summary proves this page's CSS was actually read) alongside one it
// CANNOT (a `vw` unit) -- the case resolveBreakpoints's `unparseable` exists
// for.
const INNER = () => `<!doctype html><html><head><title>inner</title>
<style>
  @media (max-width: 601px){.b{color:blue}}
  @media (max-width: 50vw){.c{display:none}}
</style>
</head><body><h1>inner</h1></body></html>`

before(async () => {
  mpCache = mkdtempSync(join(tmpdir(), 'qc-cli-browse-mp-'))
  mpServer = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${mpBase}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(
        `<urlset><url><loc>${mpBase}/a</loc></url><url><loc>${mpBase}/z</loc></url></urlset>`
      )
    }
    if (req.url === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(HOME(mpBase))
    }
    if (req.url === '/z') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(INNER())
    }
    res.writeHead(404); res.end('no')
  })
  await new Promise(r => mpServer.listen(0, r))
  mpBase = `http://127.0.0.1:${mpServer.address().port}`
})
after(() => { mpServer.close(); rmSync(mpCache, { recursive: true, force: true }) })

test('breakpoint discovery reads more than just the first page, and unparseable conditions surface', async () => {
  await run('node', ['src/cli.js', 'audit', mpBase, '--env', 'prod'], { cwd: CWD, env: env(mpCache) })
  const { stdout } = await run('node', ['src/cli.js', 'browse', mpBase], { cwd: CWD, env: env(mpCache) })
  const s = JSON.parse(stdout)

  assert.equal(s.pagesTotal, 2)
  assert.ok(s.widths.includes(900), 'expected the home page width')
  assert.ok(s.widths.includes(601), 'expected the inner/last page width -- proves more than page 1 was sampled')
  assert.ok(s.widths.includes(600), 'expected the far side of the inner page boundary')

  assert.ok(
    s.unparseableWidths.some(u => /50vw/.test(u)),
    `expected the vw condition to survive into unparseableWidths, got: ${JSON.stringify(s.unparseableWidths)}`
  )
  assert.ok(
    s.notes.some(n => /could not parse/.test(n)),
    `expected a human-readable note about the unparseable condition, got: ${JSON.stringify(s.notes)}`
  )
})
