import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { serveFixtures } from './harness.js'
import { navSweep, navDir } from '../../src/browser/nav.js'

test('qc nav opens every dropdown by hover and tap, and measures what is wrong', async () => {
  const { base, close } = await serveFixtures()
  const host = 'nav-test.invalid'
  try {
    const { rows } = await navSweep(host, { pages: [`${base}/nav.html`], widths: [360, 1440] })
    const row = (w, item) => rows.find(r => r.width === w && r.item === item)
    assert.equal(row(1440, 'Services').opened, true)
    assert.deepEqual(row(1440, 'Services').problems, [])
    assert.match(row(1440, 'Wide').problems.join(), /past the right edge/)
    assert.equal(rows.some(r => r.width === 1440 && r.mode === 'keyboard'), false, 'focus opens them')
    assert.equal(row(360, 'Menu').opened, true)
    assert.equal(row(360, 'Areas').opened, true)
    assert.equal(row(360, 'Areas').items, 2)
    assert.match(row(360, 'Broken').problems.join(), /does not open/)
  } finally {
    close()
    rmSync(navDir(host).replace(/\/nav$/, ''), { recursive: true, force: true })
  }
})
