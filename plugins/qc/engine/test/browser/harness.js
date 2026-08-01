import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser, preparePage } from '../../src/browser/launch.js'
import { buildBundle } from '../../src/browser/bundle.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export async function serveFixtures() {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'clean.html'
    // Read before writing headers -- a missing fixture must 404 cleanly. The
    // old code called writeHead(200) first and only discovered the ENOENT
    // inside the try, so the 404 branch tried to writeHead again on the same
    // response and crashed with ERR_HTTP_HEADERS_SENT. X1/X2 fixtures
    // deliberately reference URLs that don't exist on disk (missing.png,
    // definitely-missing-asset.png) to produce real 404s, so this path is
    // no longer a rare edge case -- it's load-bearing for those tests.
    let body
    try {
      body = readFileSync(join(fixturesDir, name), 'utf8')
    } catch {
      res.writeHead(404); res.end('not found'); return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  })
  await new Promise(r => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => server.close() }
}

// Loads one fixture at one width and returns the findings of `ruleIds`.
// `extraRules` is passed straight through to buildBundle() -- it lets a test
// inject a throwing rule to pin crash isolation without adding a file to the
// production rule registry (see bundle.js's buildBundle comment).
export async function findingsFor(fixture, { width = 1440, only = null, extraRules = [] } = {}) {
  const { base, close } = await serveFixtures()
  try {
    return await findingsAt(`${base}/${fixture}`, { width, only, extraRules })
  } finally {
    close()
  }
}

// Serves arbitrary HTML content (rather than a file from fixtures/) at an
// ephemeral local origin. Used for tests that must construct a page whose
// markup embeds a URL only known at test time -- e.g. the address of a
// second local server standing in for a third-party host. Never reaches the
// public internet: both origins are 127.0.0.1 loopback servers.
export async function serveContent(html) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise(r => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => server.close() }
}

export async function findingsForContent(html, { width = 1440, only = null, extraRules = [] } = {}) {
  const { base, close } = await serveContent(html)
  try {
    return await findingsAt(`${base}/`, { width, only, extraRules })
  } finally {
    close()
  }
}

async function findingsAt(url, { width, only, extraRules }) {
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width, url })
    const bundle = await buildBundle({ extraRules })
    await page.evaluate(bundle)
    const all = await page.evaluate(
      (ctx) => window.__qc.run(ctx),
      { url, breakpoint: width }
    )
    return only ? all.filter(f => only.includes(f.rule)) : all
  } finally {
    await browser.close()
  }
}
