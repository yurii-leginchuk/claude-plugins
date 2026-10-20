import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { serveFixtures } from './harness.js'
import { launchBrowser } from '../../src/browser/launch.js'
import { sweepPage } from '../../src/browser/sweep.js'

let srv, b
before(async () => { srv = await serveFixtures(); b = await launchBrowser() })
after(async () => { await b?.browser.close(); srv?.close() })

test('the resize sweep finds an overflow that exists only between two breakpoints', async () => {
  const page = await b.newPage()
  await page.goto(`${srv.base}/sweep-range.html`)
  const f = await sweepPage(page, { url: 'http://x/sweep-range.html', host: 'sweep.test', sweep: { from: 1400, to: 800, step: 50 } })
  await page.close()
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'C8')
  assert.equal(f[0].selector, '.elementor-element-abc123')
  assert.match(f[0].where, /^ширины 1000–1200 px/)
  assert.match(f[0].where, /под заголовком «Pricing»/)
})
