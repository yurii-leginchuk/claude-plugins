import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveFixtures, serveContent } from './harness.js'
import { launchBrowser, preparePage } from '../../src/browser/launch.js'
import { captureDefect, shotPath } from '../../src/browser/screenshot.js'

let cache
before(() => { cache = mkdtempSync(join(tmpdir(), 'qc-shot-')); process.env.QC_CACHE_DIR = cache })
after(() => rmSync(cache, { recursive: true, force: true }))

const finding = (selector) => ({
  rule: 'C2', page: 'https://ex.com/a', selector, found: 'ширина 1200px', region: null,
})

test('captures a crop of the offending element', async () => {
  const { base, close } = await serveFixtures()
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 360, url: `${base}/overflow-element.html` })
    const p = await captureDefect(page, finding('#culprit'), 'shot-host')
    assert.ok(p, 'expected a path')
    assert.ok(existsSync(p))
    assert.ok(statSync(p).size > 500, 'expected a real image')
  } finally { await browser.close(); close() }
})

test('returns null when the element cannot be found', async () => {
  const { base, close } = await serveFixtures()
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 360, url: `${base}/overflow-element.html` })
    assert.equal(await captureDefect(page, finding('#nope-not-here'), 'shot-host'), null)
  } finally { await browser.close(); close() }
})

test('the path is derived from the defect identity and is stable', () => {
  const a = shotPath('h', 'C2|https://ex.com/a|div#x|w')
  const b = shotPath('h', 'C2|https://ex.com/a|div#x|w')
  assert.equal(a, b)
  assert.notEqual(a, shotPath('h', 'C2|https://ex.com/b|div#x|w'))
})

// --- Judgement call: the lossy-selector risk (see the module comment in ---
// src/browser/screenshot.js and src/browser/run.js for the full account).
// helpers.selector()'s parent portion uses only the tag name, so two
// structurally-identical elements in different Elementor containers produce
// the SAME selector string. Re-querying with that string and grabbing the
// first DOM match would silently crop the wrong element. Decision: a single
// selector match is used directly; more than one is resolved ONLY if
// finding.containerId narrows the candidates to exactly one; any remaining
// ambiguity returns null rather than guessing.
const collisionHtml = (label) => `<!doctype html><html><head><title>collision</title></head><body>
  <div class="elementor elementor-100 elementor-location-header"><div><a class="probe" href="#">x</a></div></div>
  <div class="elementor elementor-200 elementor-location-footer"><div><a class="probe" href="#">${label}</a></div></div>
</body></html>`

test('an ambiguous selector match (no containerId to disambiguate) is not guessed -- returns null', async () => {
  const { base, close } = await serveContent(collisionHtml('y'))
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 1024, url: `${base}/` })
    const f = { rule: 'ZZ', page: `${base}/`, selector: 'div > a.probe', found: 'y', region: null }
    assert.equal(await captureDefect(page, f, 'shot-collision'), null,
      'both instances share this selector; cropping either would be a guess')
  } finally { await browser.close(); close() }
})

test('containerId narrows an ambiguous selector to exactly one element and crops it', async () => {
  const { base, close } = await serveContent(collisionHtml('y'))
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 1024, url: `${base}/` })
    const f = {
      rule: 'ZZ', page: `${base}/`, selector: 'div > a.probe', found: 'y', region: null,
      containerId: '200',
    }
    const p = await captureDefect(page, f, 'shot-collision-resolved')
    assert.ok(p, 'containerId disambiguates the shared selector to exactly one candidate')
    assert.ok(existsSync(p))
  } finally { await browser.close(); close() }
})

test('a containerId that matches neither candidate is still not guessed', async () => {
  const { base, close } = await serveContent(collisionHtml('y'))
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 1024, url: `${base}/` })
    const f = {
      rule: 'ZZ', page: `${base}/`, selector: 'div > a.probe', found: 'y', region: null,
      containerId: '999',
    }
    assert.equal(await captureDefect(page, f, 'shot-collision-nomatch'), null)
  } finally { await browser.close(); close() }
})

// --- Judgement call: elements that cannot be cropped -----------------------

test('a zero-size element is not cropped', async () => {
  const html = `<!doctype html><html><head><title>ghost</title></head><body>
    <div id="ghost" style="width:0;height:0;overflow:hidden">x</div>
  </body></html>`
  const { base, close } = await serveContent(html)
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 1024, url: `${base}/` })
    const f = { rule: 'ZZ', page: `${base}/`, selector: '#ghost', found: 'x', region: null }
    assert.equal(await captureDefect(page, f, 'shot-zero'), null)
  } finally { await browser.close(); close() }
})

test('a fixed element parked off-canvas (left:-9999px) is not cropped', async () => {
  const { base, close } = await serveFixtures()
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 360, url: `${base}/overflow-element.html` })
    assert.equal(await captureDefect(page, finding('#offcanvas'), 'shot-offcanvas'), null)
  } finally { await browser.close(); close() }
})

test('a fixed element parked off-canvas (left:100%) is not cropped', async () => {
  const { base, close } = await serveFixtures()
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 360, url: `${base}/overflow-element.html` })
    assert.equal(await captureDefect(page, finding('#slidein'), 'shot-slidein'), null)
  } finally { await browser.close(); close() }
})

test('an element removed from the DOM before capture is not cropped, and does not crash', async () => {
  const html = `<!doctype html><html><head><title>vanish</title></head><body>
    <div id="vanish" style="width:200px;height:50px;background:#fbb">bye</div>
    <script>setTimeout(function () {
      var el = document.getElementById('vanish')
      if (el) el.remove()
    }, 10)</script>
  </body></html>`
  const { base, close } = await serveContent(html)
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    // preparePage's own networkidle wait and lazy-load scroll walk together
    // comfortably outlast the 10ms timer above, so by the time capture runs
    // the element a rule measured earlier is already gone from the DOM.
    await preparePage(page, { width: 1024, url: `${base}/` })
    const f = { rule: 'ZZ', page: `${base}/`, selector: '#vanish', found: 'bye', region: null }
    assert.equal(await captureDefect(page, f, 'shot-vanish'), null)
  } finally { await browser.close(); close() }
})

// --- Judgement call: the highlight must not leak into a later measurement --
//
// Capturing during the measurement pass means highlighting and screenshotting
// happen on the very page other rules just measured. This pins the actual
// DOM state before and after a capture: no marker attribute survives, the
// outline is fully reverted (not just hidden), the element's own measured
// box is byte-identical, and the outline did not trigger a scrollWidth
// change that a later C1 (horizontal-scroll) measurement would misread as a
// new defect.
test('the highlight is fully removed and does not change a later measurement on the same page/width', async () => {
  const { base, close } = await serveFixtures()
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 360, url: `${base}/overflow-element.html` })

    const before = await page.evaluate(() => {
      const el = document.querySelector('#culprit')
      const r = el.getBoundingClientRect()
      return {
        w: r.width, h: r.height, style: el.getAttribute('style'),
        scrollWidth: document.documentElement.scrollWidth,
      }
    })

    const p = await captureDefect(page, finding('#culprit'), 'shot-leftover')
    assert.ok(p, 'sanity: the capture itself succeeded')

    const after = await page.evaluate(() => {
      const el = document.querySelector('#culprit')
      const r = el.getBoundingClientRect()
      return {
        w: r.width, h: r.height, style: el.getAttribute('style'),
        scrollWidth: document.documentElement.scrollWidth,
        highlighted: document.querySelectorAll('[data-qc-highlight]').length,
        outline: getComputedStyle(el).outlineStyle,
      }
    })

    assert.equal(after.highlighted, 0, 'the marker attribute must not survive the capture')
    assert.equal(after.outline, 'none', 'the outline itself must be fully reverted, not just hidden')
    assert.equal(after.style, before.style, 'the style attribute is restored to its exact prior state')
    assert.equal(after.w, before.w, "the highlight must not change the element's measured width")
    assert.equal(after.h, before.h, "the highlight must not change the element's measured height")
    assert.equal(after.scrollWidth, before.scrollWidth,
      'an outline must not change scrollWidth, or a later C1 measurement would see a false defect')
  } finally { await browser.close(); close() }
})

// --- Judgement call: cost --------------------------------------------------
//
// Printed for the report, and asserted against a generous bound so a slow CI
// box fails loudly instead of silently accepting a regression.
test('cost: wall-clock and bytes for a single fresh crop', async () => {
  const { base, close } = await serveFixtures()
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    await preparePage(page, { width: 1024, url: `${base}/overflow-element.html` })
    const f = { rule: 'COST', page: `${base}/cost-probe`, selector: '#culprit', found: 'cost-probe', region: null }
    const t0 = Date.now()
    const p = await captureDefect(page, f, 'shot-cost')
    const elapsed = Date.now() - t0
    const bytes = statSync(p).size
    console.log(`[screenshot cost] single fresh crop: ${elapsed}ms, ${bytes} bytes`)
    assert.ok(elapsed < 3000, `expected a single crop well under 3s, got ${elapsed}ms`)
    assert.ok(bytes > 0 && bytes < 500_000, `expected a small cropped PNG, got ${bytes} bytes`)
  } finally { await browser.close(); close() }
})
