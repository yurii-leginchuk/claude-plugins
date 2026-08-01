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
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readFileSync(join(fixturesDir, name), 'utf8'))
    } catch {
      res.writeHead(404); res.end('not found')
    }
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
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    const url = `${base}/${fixture}`
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
    close()
  }
}
