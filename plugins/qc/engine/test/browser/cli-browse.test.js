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
let server, base, cache

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>
<link rel="canonical" href="BASE/a"><style>@media (max-width:1230px){.x{display:none}}</style>
</head><body><header>h</header><main><h1>Hi</h1><div style="width:3000px">wide</div></main></body></html>`

before(async () => {
  cache = mkdtempSync(join(tmpdir(), 'qc-cli-browse-'))
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${base}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<urlset><url><loc>${base}/a</loc></url></urlset>`)
    }
    if (req.url === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(PAGE.replaceAll('BASE', base))
    }
    res.writeHead(404); res.end('no')
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); rmSync(cache, { recursive: true, force: true }) })

const env = () => ({ ...process.env, QC_CACHE_DIR: cache })

test('browse refuses without a snapshot', async () => {
  await assert.rejects(
    () => run('node', ['src/cli.js', 'browse', 'never-crawled.example'], { cwd: CWD, env: env() }),
    (e) => /audit/.test(String(e.stderr))
  )
})

test('browse runs after audit and reports coverage', async () => {
  await run('node', ['src/cli.js', 'audit', base, '--env', 'prod'], { cwd: CWD, env: env() })
  const { stdout } = await run('node', ['src/cli.js', 'browse', base], { cwd: CWD, env: env() })
  const s = JSON.parse(stdout)
  assert.equal(s.pagesTotal, 1)
  assert.equal(s.pagesDone, 1)
  assert.ok(s.widths.includes(1230), 'expected the media width from the page CSS')
  assert.ok(s.widths.includes(1229), 'expected the far side of the boundary')
  assert.ok(s.findings.some(f => f.rule === 'C1'), 'expected the horizontal scroll finding')
})

test('a second browse does no work', async () => {
  const { stdout } = await run('node', ['src/cli.js', 'browse', base], { cwd: CWD, env: env() })
  assert.equal(JSON.parse(stdout).pagesDone, 0)
})

test('--breakpoints overrides discovery', async () => {
  const { stdout } = await run(
    'node', ['src/cli.js', 'browse', base, '--force', '--breakpoints', '375,1280'],
    { cwd: CWD, env: env() })
  assert.deepEqual(JSON.parse(stdout).widths, [375, 1280])
})
