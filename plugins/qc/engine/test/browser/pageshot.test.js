import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveFixtures } from './harness.js'
import { launchBrowser } from '../../src/browser/launch.js'
import { capturePage } from '../../src/browser/pageshot.js'

let srv, b
before(async () => { process.env.QC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'qc-shot-')); srv = await serveFixtures(); b = await launchBrowser() })
after(async () => { await b?.browser.close(); srv?.close() })

test('a clean page still gets a full-page WebP, keyed by url and width', async () => {
  const page = await b.newPage()
  await page.setViewportSize({ width: 360, height: 900 })
  await page.goto(`${srv.base}/clean.html`)
  const s = await capturePage(page, { host: 'shot.test', url: 'http://x/clean.html', width: 360 })
  await page.close()
  assert.ok(existsSync(s.path))
  assert.match(s.path, /pages\/[0-9a-f]{16}\.webp$/)
  const file = readFileSync(s.path)
  assert.equal(file.subarray(0, 4).toString(), 'RIFF')
  assert.equal(file.subarray(8, 12).toString(), 'WEBP')
  assert.equal(s.cut, false)
})

test('pieces: the first screen, then sections; a section shared by two pages is one file', async () => {
  const { captureTiles } = await import('../../src/browser/pageshot.js')
  const footer = '<footer style="height:600px;background:#123;color:#fff">Footer</footer>'
  const html = (hero) => `<!doctype html><body style="margin:0"><div style="position:fixed;bottom:0;height:40px;width:100%;background:red"></div><section style="height:1300px;background:#eee">${hero}</section><section style="height:2500px;background:#ccc">Long</section>${footer}</body>`
  const shots = []
  for (const hero of ['Home', 'About']) {
    const page = await b.newPage()
    await page.setViewportSize({ width: 360, height: 900 })
    await page.setContent(html(hero))
    shots.push(await captureTiles(page, { host: 'shot.test', width: 360 }))
    await page.close()
  }
  const [a, c] = shots
  assert.equal(a[0].kind, 'screen')
  assert.deepEqual([a[0].top, a[0].bottom], [0, 900])
  // the hero straddles the first screen, the long section is split with overlap, the footer is its own piece
  assert.deepEqual(a.slice(1).map(t => [t.top, t.bottom]), [[0, 1000], [900, 1300], [1300, 2300], [2200, 3200], [3100, 3800], [3800, 4400]])
  assert.equal(a.at(-1).hash, c.at(-1).hash, 'the footer is the same picture on both pages')
  assert.notEqual(a[0].hash, c[0].hash)
  assert.ok(a.every(t => existsSync(t.path)))
})

test('one footer at sub-pixel different heights on two pages is listed as one piece', async () => {
  const { captureTiles } = await import('../../src/browser/pageshot.js')
  const { tileManifest } = await import('../../src/cli.js')
  const footer = '<footer style="height:400px;background:#123;color:#fff;font:15px sans-serif;padding:20px">Starkweather &amp; Shepley · 60 Catamore Blvd · Call 800.854.4625</footer>'
  const rows = new Map()
  for (const [url, h] of [['https://ex.com/a/', 1200.3], ['https://ex.com/b/', 1700.7]]) {
    const page = await b.newPage()
    await page.setViewportSize({ width: 360, height: 900 })
    await page.setContent(`<!doctype html><body style="margin:0"><section style="height:${h}px;background:#eee">Page ${url}</section>${footer}</body>`)
    rows.set(url, { shots: [{ width: 360, tiles: await captureTiles(page, { host: 'shot.test', width: 360 }) }] })
    await page.close()
  }
  const m = tileManifest([...rows.keys()].map(url => ({ url })), new Set(rows.keys()), rows, () => 'other')
  const shared = m.tiles.filter(t => t.places.length === 2)
  assert.equal(shared.length, 1, 'the footer')
  assert.deepEqual(shared[0].places.map(p => p.page), ['https://ex.com/a/', 'https://ex.com/b/'])
})
