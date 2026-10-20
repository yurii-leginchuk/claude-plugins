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

test('a clean page still gets a full-page JPEG, keyed by url and width', async () => {
  const page = await b.newPage()
  await page.setViewportSize({ width: 360, height: 900 })
  await page.goto(`${srv.base}/clean.html`)
  const s = await capturePage(page, { host: 'shot.test', url: 'http://x/clean.html', width: 360 })
  await page.close()
  assert.ok(existsSync(s.path))
  assert.match(s.path, /pages\/[0-9a-f]{16}\.jpg$/)
  assert.deepEqual([...readFileSync(s.path).subarray(0, 2)], [0xff, 0xd8], 'JPEG magic')
  assert.equal(s.cut, false)
})
