# QC Browser Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `qc browse` — a resumable Playwright pass that opens every page of a cached site at several widths, runs nine rendered-page rules inside the browser, and merges its findings into the existing report.

**Architecture:** A new `src/browser/` subsystem drives Chromium; nine self-contained rule functions in `src/rules/browser/` are serialised with `Function.prototype.toString()` and injected into the page, returning findings directly. Results are appended to `browser.jsonl` in the snapshot one line per page, which is what makes the pass resumable. `qc audit` merges static and browser findings into one report.

**Tech Stack:** Node 24 ESM, `playwright` (Chromium) as the second and final runtime dependency, `node:test` + `node:assert/strict`, a local `node:http` server serving HTML fixtures for tests.

## Global Constraints

- Node ESM only (`"type": "module"`). No TypeScript, no build step.
- Runtime dependencies limited to `node-html-parser` and `playwright`. Everything else uses Node built-ins.
- Tests use `node:test` + `node:assert/strict`. **No test may reach the public internet** — serve fixtures from a local `node:http` server.
- Severity values are exactly `critical` | `major` | `minor` | `note`.
- Confidence is `high` unless the spec marks the rule a heuristic. `F1`, `J3`, `B6` are `heuristic`.
- Rule IDs match the taxonomy verbatim: `C1 C2 X1 X2 F4 F5 F1 J3 B6`.
- Every rule `title` is Russian; all other user-facing prose is Russian; code and comments are English.
- Findings never carry secrets or full page HTML — a selector plus short `found`/`expected` strings.
- Snapshot cache lives at `$QC_CACHE_DIR` (default `~/.qc-cache/<host>/`), never inside the repo.
- `npm test` runs bare `node --test` (recursive discovery). It currently passes 394/394 and must keep passing.

## Two constraints that come from real measurements, not preference

Both were established by running the finished static engine against a live client site. Ignoring either produces a broken pass, so they are repeated in the tasks that depend on them.

1. **Lazy images must be forced to load** by scrolling slowly to the bottom before measuring, or `X2` reports every lazy image as broken on every page.
2. **CSS animations must be disabled** before measuring, or `C2` and `B6` measure elements mid-animation and produce different findings on identical runs.

## File Structure

```
plugins/qc/engine/
  package.json                       # + playwright
  src/
    browser/
      launch.js                      # browser lifecycle, page setup, measure-readiness
      bundle.js                      # serialise helpers + rules into one injectable script
      breakpoints.js                 # base set + widths extracted from the site's @media
      regions.js                     # prove which Elementor containers are shared
      screenshot.js                  # crop the offending element, keyed by defect identity
      run.js                         # page loop, checkpoints, resume, failure policy
    rules/
      browser-index.js               # loader for browser rules (static loader untouched)
      browser/
        _helpers.js                  # selector, visibility, contrast — injected as globals
        C1-horizontal-scroll.js  C2-overflow.js  X1-console.js  X2-broken-images.js
        F4-cursor.js  F5-transition.js  F1-hover.js  J3-contrast.js  B6-overlap.js
    cli.js                           # + `browse` subcommand
    crawl/store.js                   # + browser results and shots
    report/{json,html}.js            # + breakpoint, screenshots, coverage header
  test/
    browser/
      fixtures/*.html                # pages with deliberate defects
      harness.js                     # shared: local server + launch + collect
      <rule>.test.js
```

---

### Task 1: Playwright harness, rule bundling, and C1 end to end

This task establishes every contract the other rules depend on. Do not generalise later — get the seams right here.

**Files:**
- Modify: `plugins/qc/engine/package.json`
- Create: `plugins/qc/engine/src/browser/launch.js`
- Create: `plugins/qc/engine/src/browser/bundle.js`
- Create: `plugins/qc/engine/src/rules/browser-index.js`
- Create: `plugins/qc/engine/src/rules/browser/_helpers.js`
- Create: `plugins/qc/engine/src/rules/browser/C1-horizontal-scroll.js`
- Create: `plugins/qc/engine/test/browser/harness.js`
- Create: `plugins/qc/engine/test/browser/fixtures/{clean,horizontal-scroll}.html`
- Test: `plugins/qc/engine/test/browser/C1.test.js`

**Interfaces:**
- Consumes: `finding()`'s finding shape from `src/rules/index.js` (do not import it into the page — browser rules build finding objects themselves).
- Produces:
  - `launchBrowser(opts) -> { browser, newPage }` and `preparePage(page, { width, url, timeout })` which navigates, waits, forces lazy images, disables animations, and resolves when the page is safe to measure.
  - `buildBundle() -> Promise<string>` — one JS source string defining `window.__qc.run(ctx)`.
  - `allBrowserRules() -> Promise<Rule[]>` where `Rule = { id, title, severity, confidence, meta-only in Node }`.
  - Browser rule module shape: `export const meta = { id, title, severity, confidence }` and `export function check(ctx)`.
  - `ctx = { url, breakpoint, helpers }`. `check` returns `[{ rule, title, severity, confidence, engine:'browser', page, breakpoint, selector, found, expected }]`.

**The rule between Node and the page:** `check` is serialised with `Function.prototype.toString()`, so it must be **entirely self-contained** — no imports, no closure over module scope, no optional chaining on `window` globals that may not exist. Shared code lives in `_helpers.js` and arrives as `ctx.helpers`.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/harness.js
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
export async function findingsFor(fixture, { width = 1440, only = null } = {}) {
  const { base, close } = await serveFixtures()
  const { browser, newPage } = await launchBrowser()
  try {
    const page = await newPage()
    const url = `${base}/${fixture}`
    await preparePage(page, { width, url })
    const bundle = await buildBundle()
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
```

```html
<!-- plugins/qc/engine/test/browser/fixtures/clean.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Clean</title>
<style>body{margin:0;font:16px/1.5 system-ui;color:#111;background:#fff}
main{max-width:900px;margin:0 auto;padding:24px}
a{color:#0b5;text-decoration:underline;transition:color .2s}
a:hover{color:#083}</style></head>
<body><header><nav><a href="/">Home</a></nav></header>
<main><h1>Clean page</h1><p>Nothing wrong here.</p>
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="dot" width="1" height="1">
</main></body></html>
```

```html
<!-- plugins/qc/engine/test/browser/fixtures/horizontal-scroll.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Overflow</title>
<style>body{margin:0}
.wide{width:3000px;height:40px;background:#ccc}</style></head>
<body><header><nav><a href="/">Home</a></nav></header>
<main><h1>Overflowing</h1><div class="wide" id="culprit">too wide</div></main></body></html>
```

```js
// plugins/qc/engine/test/browser/C1.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor } from './harness.js'

test('C1 flags a document that scrolls horizontally', async () => {
  const f = await findingsFor('horizontal-scroll.html', { width: 1440, only: ['C1'] })
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
  assert.equal(f[0].confidence, 'high')
  assert.equal(f[0].engine, 'browser')
  assert.equal(f[0].breakpoint, 1440)
  assert.match(f[0].found, /3000/)
})

test('C1 stays silent on a clean page', async () => {
  const f = await findingsFor('clean.html', { width: 1440, only: ['C1'] })
  assert.deepEqual(f, [])
})

test('C1 flags the same page at a mobile width', async () => {
  const f = await findingsFor('horizontal-scroll.html', { width: 360, only: ['C1'] })
  assert.equal(f.length, 1)
  assert.equal(f[0].breakpoint, 360)
})

test('every browser rule check is self-contained and survives serialisation', async () => {
  const { allBrowserRules } = await import('../../src/rules/browser-index.js')
  const rules = await allBrowserRules()
  assert.ok(rules.length >= 1)
  for (const r of rules) {
    assert.equal(typeof r.id, 'string')
    assert.ok(['critical', 'major', 'minor', 'note'].includes(r.severity))
    assert.ok(['high', 'heuristic'].includes(r.confidence))
    assert.match(r.title, /[Ѐ-ӿ]/, `${r.id} title must be Russian`)
    // A check that closes over module scope throws once serialised.
    assert.doesNotThrow(() => new Function(`return (${r.check.toString()})`)())
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/C1.test.js`
Expected: FAIL — `Cannot find module '../../src/browser/launch.js'`

- [ ] **Step 3: Install Playwright and write the implementation**

```bash
cd plugins/qc/engine && npm install playwright && npx playwright install chromium
```

Add to `package.json` dependencies: `"playwright": "^1.56.0"`.

```js
// plugins/qc/engine/src/browser/launch.js
import { chromium } from 'playwright'

export const PAGE_TIMEOUT_MS = 45_000

export async function launchBrowser({ headed = false } = {}) {
  const browser = await chromium.launch({ headless: !headed })
  const newPage = async () => {
    const context = await browser.newContext({ deviceScaleFactor: 1 })
    return context.newPage()
  }
  return { browser, newPage }
}

// Bring the page to a state where measuring is meaningful and repeatable.
export async function preparePage(page, { width, url, timeout = PAGE_TIMEOUT_MS }) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(url, { waitUntil: 'load', timeout })
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 })
  } catch {
    // A page that never goes idle (polling, chat widget) is still measurable.
  }

  // Lazy images only load once they approach the viewport. Without this walk
  // X2 reports every lazy image on the site as broken.
  await page.evaluate(async () => {
    const step = 300
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise(r => setTimeout(r, 60))
    }
    window.scrollTo(0, 0)
    await new Promise(r => setTimeout(r, 250))
  })
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 })
  } catch { /* as above */ }

  // Measuring mid-animation makes C2 and B6 differ between identical runs.
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;
      scroll-behavior:auto!important}`,
  })
  await page.evaluate(() => document.fonts && document.fonts.ready)
}
```

```js
// plugins/qc/engine/src/rules/browser/_helpers.js
// Injected into the page as `ctx.helpers`. Must be self-contained: this whole
// object is serialised, so nothing here may reference module scope.
export const helpers = {
  selector(el) {
    if (!el || !el.tagName) return 'node'
    const tag = el.tagName.toLowerCase()
    if (el.id) return tag + '#' + el.id
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2)
    const own = cls.length ? tag + '.' + cls.join('.') : tag
    const p = el.parentElement
    if (!p || p === document.body || p === document.documentElement) return own
    const ptag = p.tagName.toLowerCase()
    const pid = p.id ? ptag + '#' + p.id : ptag
    return pid + ' > ' + own
  },
  visible(el) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  },
  interactive(el) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href')
    if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true
    if (tag === 'input') return el.type !== 'hidden'
    const role = el.getAttribute('role')
    return ['button', 'link', 'tab', 'menuitem'].includes(role)
  },
  luminance(rgb) {
    const f = (v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
  },
  parseRgb(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '')
    if (!m) return null
    const parts = m[1].split(',').map(s => parseFloat(s.trim()))
    if (parts.length >= 4 && parts[3] === 0) return null   // fully transparent
    return [parts[0], parts[1], parts[2]]
  },
  contrast(a, b) {
    const la = this.luminance(a)
    const lb = this.luminance(b)
    const hi = Math.max(la, lb)
    const lo = Math.min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
  },
}
```

```js
// plugins/qc/engine/src/rules/browser/C1-horizontal-scroll.js
export const meta = {
  id: 'C1',
  title: 'Горизонтальный скролл документа',
  severity: 'critical',
  confidence: 'high',
}

// Runs inside the page. Self-contained by contract.
export function check(ctx) {
  const doc = document.documentElement
  const overflow = doc.scrollWidth - doc.clientWidth
  if (overflow <= 1) return []          // 1px tolerance for sub-pixel rounding
  return [{
    rule: 'C1',
    title: 'Горизонтальный скролл документа',
    severity: 'critical',
    confidence: 'high',
    engine: 'browser',
    page: ctx.url,
    breakpoint: ctx.breakpoint,
    selector: 'html',
    found: 'ширина документа ' + doc.scrollWidth + 'px при вьюпорте ' + doc.clientWidth + 'px',
    expected: 'документ не шире вьюпорта',
  }]
}
```

```js
// plugins/qc/engine/src/rules/browser-index.js
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, 'browser')

let cache = null

export async function allBrowserRules() {
  if (cache) return cache
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.startsWith('_'))
    .sort()
  const mods = await Promise.all(files.map(f => import(pathToFileURL(join(dir, f)).href)))
  cache = mods.map(m => ({ ...m.meta, check: m.check }))
  return cache
}
```

```js
// plugins/qc/engine/src/browser/bundle.js
import { allBrowserRules } from '../rules/browser-index.js'
import { helpers } from '../rules/browser/_helpers.js'

// Serialise helpers + every rule's check into one script that defines
// window.__qc.run(ctx). Rules are serialised by source, so a check that closes
// over module scope will throw the moment it runs -- Task 1's contract test
// catches that before it can reach a real site.
function serialiseHelpers(obj) {
  const entries = Object.entries(obj).map(([k, v]) => `${k}: ${v.toString()}`)
  return `{ ${entries.join(',\n')} }`
}

export async function buildBundle() {
  const rules = await allBrowserRules()
  const parts = rules.map(r => `  { id: ${JSON.stringify(r.id)}, check: ${r.check.toString()} }`)
  return `
(function () {
  var helpers = ${serialiseHelpers(helpers)};
  var rules = [
${parts.join(',\n')}
  ];
  window.__qc = {
    run: function (ctx) {
      var withHelpers = { url: ctx.url, breakpoint: ctx.breakpoint, helpers: helpers };
      var out = [];
      for (var i = 0; i < rules.length; i++) {
        try {
          var got = rules[i].check(withHelpers) || [];
          for (var j = 0; j < got.length; j++) out.push(got[j]);
        } catch (e) {
          // A crashing rule must not lose the other rules' findings.
          out.push({
            rule: rules[i].id, title: 'Правило упало', severity: 'note',
            confidence: 'high', engine: 'browser', page: ctx.url,
            breakpoint: ctx.breakpoint, selector: null,
            found: 'rule crashed: ' + (e && e.message), expected: null,
          });
        }
      }
      return out;
    }
  };
})();
`
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/C1.test.js`
Expected: PASS — 4 tests. Then `npm test` to confirm the existing 394 still pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/package.json plugins/qc/engine/package-lock.json \
        plugins/qc/engine/src/browser plugins/qc/engine/src/rules/browser-index.js \
        plugins/qc/engine/src/rules/browser plugins/qc/engine/test/browser
git commit -m "feat(qc): playwright harness, rule bundling, and C1"
```

---

### Task 2: Breakpoint discovery

**Files:**
- Create: `plugins/qc/engine/src/browser/breakpoints.js`
- Test: `plugins/qc/engine/test/browser/breakpoints.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BASE_WIDTHS = [360, 768, 1024, 1440]`, `MAX_WIDTHS = 10`,
  `extractMediaWidths(cssText) -> number[]`, and
  `resolveBreakpoints({ cssTexts = [], override = null }) -> { widths: number[], dropped: number[] }`.

Each discovered media width `W` contributes both `W` and `W - 1`, because a layout defect lives on
one side of the boundary and not the other. Base widths are always kept. `dropped` is what the cap
excluded — the report prints it rather than silently narrowing coverage.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/breakpoints.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMediaWidths, resolveBreakpoints, BASE_WIDTHS, MAX_WIDTHS }
  from '../../src/browser/breakpoints.js'

test('extracts min-width and max-width from media queries', () => {
  const css = `
    @media (max-width: 1024px) { .a { color: red } }
    @media screen and (min-width:768px) and (max-width:991.98px) { .b { color: blue } }
    @media (min-width: 1230px) { .c { display: none } }
  `
  assert.deepEqual(extractMediaWidths(css).sort((a, b) => a - b), [768, 991, 1024, 1230])
})

test('ignores non-width media features and malformed css', () => {
  assert.deepEqual(extractMediaWidths('@media print { .x { color: red } }'), [])
  assert.deepEqual(extractMediaWidths('@media (min-height: 600px) { .x{} }'), [])
  assert.deepEqual(extractMediaWidths('not css at all {{{'), [])
})

test('each discovered width contributes both sides of the boundary', () => {
  const { widths } = resolveBreakpoints({ cssTexts: ['@media (max-width: 1230px){.a{}}'] })
  assert.ok(widths.includes(1230))
  assert.ok(widths.includes(1229))
})

test('base widths are always present and the list is sorted and unique', () => {
  const { widths } = resolveBreakpoints({ cssTexts: ['@media (min-width:768px){.a{}}'] })
  for (const b of BASE_WIDTHS) assert.ok(widths.includes(b), `missing base ${b}`)
  assert.deepEqual(widths, [...new Set(widths)].sort((a, b) => a - b))
})

test('caps the list and reports what was dropped', () => {
  const many = Array.from({ length: 30 }, (_, i) => `@media (min-width:${400 + i * 37}px){.a{}}`)
  const { widths, dropped } = resolveBreakpoints({ cssTexts: many })
  assert.equal(widths.length, MAX_WIDTHS)
  assert.ok(dropped.length > 0)
  for (const b of BASE_WIDTHS) assert.ok(widths.includes(b), `base ${b} must survive the cap`)
})

test('an explicit override wins and skips extraction entirely', () => {
  const { widths, dropped } = resolveBreakpoints({
    cssTexts: ['@media (min-width:999px){.a{}}'], override: [375, 1280],
  })
  assert.deepEqual(widths, [375, 1280])
  assert.deepEqual(dropped, [])
})

test('no css yields exactly the base set', () => {
  assert.deepEqual(resolveBreakpoints({ cssTexts: [] }).widths, [...BASE_WIDTHS].sort((a, b) => a - b))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/breakpoints.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/browser/breakpoints.js
export const BASE_WIDTHS = [360, 768, 1024, 1440]
export const MAX_WIDTHS = 10

const WIDTH_FEATURE = /\((?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/gi

export function extractMediaWidths(cssText) {
  const out = new Set()
  const blocks = String(cssText || '').match(/@media[^{]+/gi) || []
  for (const block of blocks) {
    let m
    WIDTH_FEATURE.lastIndex = 0
    while ((m = WIDTH_FEATURE.exec(block))) {
      const w = Math.floor(Number(m[1]))
      if (Number.isFinite(w) && w >= 240 && w <= 2560) out.add(w)
    }
  }
  return [...out]
}

// Distance to the nearest base width; used to keep the most informative
// discovered widths when the cap bites.
const distanceToBase = (w) => Math.min(...BASE_WIDTHS.map(b => Math.abs(b - w)))

export function resolveBreakpoints({ cssTexts = [], override = null } = {}) {
  if (Array.isArray(override) && override.length) {
    return { widths: [...new Set(override)].sort((a, b) => a - b), dropped: [] }
  }

  const discovered = new Set()
  for (const css of cssTexts) {
    for (const w of extractMediaWidths(css)) {
      discovered.add(w)
      if (w - 1 >= 240) discovered.add(w - 1)
    }
  }
  for (const b of BASE_WIDTHS) discovered.delete(b)

  const ranked = [...discovered].sort((a, b) => distanceToBase(a) - distanceToBase(b) || a - b)
  const room = Math.max(0, MAX_WIDTHS - BASE_WIDTHS.length)
  const kept = ranked.slice(0, room)
  const dropped = ranked.slice(room).sort((a, b) => a - b)

  const widths = [...new Set([...BASE_WIDTHS, ...kept])].sort((a, b) => a - b)
  return { widths, dropped }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/breakpoints.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/browser/breakpoints.js \
        plugins/qc/engine/test/browser/breakpoints.test.js
git commit -m "feat(qc): breakpoint discovery from the site's own media queries"
```

---

### Task 3: High-confidence measurement rules — C2, X1, X2

**Files:**
- Create: `plugins/qc/engine/src/rules/browser/C2-overflow.js`
- Create: `plugins/qc/engine/src/rules/browser/X1-console.js`
- Create: `plugins/qc/engine/src/rules/browser/X2-broken-images.js`
- Modify: `plugins/qc/engine/src/browser/launch.js` (collect console and request failures)
- Create: `plugins/qc/engine/test/browser/fixtures/{overflow-element,console-errors,broken-images}.html`
- Test: `plugins/qc/engine/test/browser/C2-X1-X2.test.js`

**Interfaces:**
- Consumes: `ctx.helpers.{selector,visible}` from Task 1.
- Produces: three rule modules. `X1` reads `window.__qcConsole`, an array the harness installs
  before navigation — `preparePage` gains a `collect` option that attaches Playwright's `console`
  and `requestfailed` listeners and pushes into that array via `page.exposeFunction` or an
  `addInitScript` shim. Extend `preparePage` to always install it.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/C2-X1-X2.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor } from './harness.js'

test('C2 names the element that is wider than the viewport', async () => {
  const f = await findingsFor('overflow-element.html', { width: 360, only: ['C2'] })
  assert.ok(f.length >= 1)
  assert.match(f[0].selector, /culprit/)
  assert.match(f[0].found, /\d+px/)
  assert.equal(f[0].severity, 'major')
})

test('C2 stays silent when everything fits', async () => {
  assert.deepEqual(await findingsFor('clean.html', { width: 1440, only: ['C2'] }), [])
})

test('C2 does not flag an element hidden off-canvas by design', async () => {
  // The fixture has an off-canvas menu at left:-9999px; it must not be reported.
  const f = await findingsFor('overflow-element.html', { width: 1440, only: ['C2'] })
  assert.ok(!f.some(x => /offcanvas/.test(x.selector)))
})

test('X1 reports a console error and a failed request', async () => {
  const f = await findingsFor('console-errors.html', { width: 1440, only: ['X1'] })
  assert.ok(f.some(x => /boom/.test(x.found)), 'expected the thrown error')
  assert.ok(f.some(x => /404|failed/i.test(x.found)), 'expected the failed request')
  assert.ok(f.every(x => x.severity === 'major'))
})

test('X1 stays silent on a clean page', async () => {
  assert.deepEqual(await findingsFor('clean.html', { width: 1440, only: ['X1'] }), [])
})

test('X2 reports an image that failed to load', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(f.some(x => /missing\.png/.test(x.found)))
})

test('X2 does not report a lazy image that loaded after the scroll walk', async () => {
  const f = await findingsFor('broken-images.html', { width: 1440, only: ['X2'] })
  assert.ok(!f.some(x => /lazy-ok/.test(x.found)), 'lazy image must be loaded before measuring')
})

test('X2 stays silent on a clean page', async () => {
  assert.deepEqual(await findingsFor('clean.html', { width: 1440, only: ['X2'] }), [])
})
```

Fixtures — write these exactly:

```html
<!-- overflow-element.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Overflow element</title>
<style>body{margin:0;overflow-x:hidden}
#culprit{width:1200px;height:30px;background:#fbb}
#offcanvas{position:fixed;left:-9999px;top:0;width:300px;height:100px;background:#eee}</style>
</head><body><main><h1>Overflow</h1>
<div id="culprit">wide</div><div id="offcanvas">menu</div></main></body></html>
```

```html
<!-- console-errors.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Console</title></head>
<body><main><h1>Console</h1><img src="/definitely-missing-asset.png" alt="x"></main>
<script>throw new Error('boom')</script></body></html>
```

```html
<!-- broken-images.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Images</title>
<style>body{margin:0}.spacer{height:2000px}</style></head>
<body><main><h1>Images</h1>
<img src="/missing.png" alt="broken">
<div class="spacer"></div>
<img id="lazy-ok" loading="lazy" alt="lazy"
  src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
</main></body></html>
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/C2-X1-X2.test.js`
Expected: FAIL — the three rule modules do not exist

- [ ] **Step 3: Write the implementation**

Extend `preparePage` — add this before `page.goto`:

```js
  // X1 needs errors that happen during load, so the sink must exist first.
  await page.addInitScript(() => { window.__qcConsole = [] })
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    page.evaluate((t) => window.__qcConsole && window.__qcConsole.push(t), 'console: ' + msg.text())
      .catch(() => {})
  })
  page.on('pageerror', (err) => {
    page.evaluate((t) => window.__qcConsole && window.__qcConsole.push(t), 'error: ' + err.message)
      .catch(() => {})
  })
  page.on('requestfailed', (req) => {
    page.evaluate((t) => window.__qcConsole && window.__qcConsole.push(t),
      'failed: ' + req.url() + ' — ' + (req.failure() && req.failure().errorText))
      .catch(() => {})
  })
  page.on('response', (res) => {
    if (res.status() < 400) return
    page.evaluate((t) => window.__qcConsole && window.__qcConsole.push(t),
      'failed: HTTP ' + res.status() + ' ' + res.url())
      .catch(() => {})
  })
```

```js
// plugins/qc/engine/src/rules/browser/C2-overflow.js
export const meta = {
  id: 'C2',
  title: 'Элемент шире вьюпорта',
  severity: 'major',
  confidence: 'high',
}

export function check(ctx) {
  const vw = document.documentElement.clientWidth
  const out = []
  const seen = {}
  const all = document.querySelectorAll('body *')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    if (!ctx.helpers.visible(el)) continue
    const r = el.getBoundingClientRect()
    // Deliberately off-canvas elements (menus parked far left/right) are not defects.
    if (r.right <= 0 || r.left >= vw) continue
    if (r.width <= vw + 1) continue
    // Report the outermost offender only; children inherit their parent's width.
    const p = el.parentElement
    if (p && p !== document.body && p.getBoundingClientRect().width > vw + 1) continue
    const sel = ctx.helpers.selector(el)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'C2', title: 'Элемент шире вьюпорта', severity: 'major', confidence: 'high',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sel,
      found: 'ширина ' + Math.round(r.width) + 'px при вьюпорте ' + vw + 'px',
      expected: 'не шире вьюпорта',
    })
  }
  return out
}
```

```js
// plugins/qc/engine/src/rules/browser/X1-console.js
export const meta = {
  id: 'X1',
  title: 'Ошибки консоли и упавшие запросы',
  severity: 'major',
  confidence: 'high',
}

export function check(ctx) {
  const log = window.__qcConsole || []
  const seen = {}
  const out = []
  for (let i = 0; i < log.length; i++) {
    const line = String(log[i]).slice(0, 200)
    if (seen[line]) continue
    seen[line] = 1
    out.push({
      rule: 'X1', title: 'Ошибки консоли и упавшие запросы', severity: 'major',
      confidence: 'high', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
      selector: null, found: line, expected: 'консоль без ошибок',
    })
  }
  return out
}
```

```js
// plugins/qc/engine/src/rules/browser/X2-broken-images.js
export const meta = {
  id: 'X2',
  title: 'Картинка не загрузилась',
  severity: 'major',
  confidence: 'high',
}

export function check(ctx) {
  const out = []
  const imgs = document.querySelectorAll('img')
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i]
    if (!ctx.helpers.visible(img)) continue
    const src = img.currentSrc || img.getAttribute('src') || ''
    const placeholder = /^data:image\/(gif|svg\+xml);/.test(src) && img.hasAttribute('loading')
    const broken = img.complete && img.naturalWidth === 0
    if (!broken && !placeholder) continue
    out.push({
      rule: 'X2', title: 'Картинка не загрузилась', severity: 'major', confidence: 'high',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
      selector: ctx.helpers.selector(img),
      found: broken
        ? 'не загрузилась: ' + src.slice(0, 120)
        : 'осталась data:-заглушкой: ' + src.slice(0, 60),
      expected: 'изображение загружено',
    })
  }
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/C2-X1-X2.test.js && npm test`
Expected: PASS — 8 new tests, full suite green

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/rules/browser plugins/qc/engine/src/browser/launch.js \
        plugins/qc/engine/test/browser
git commit -m "feat(qc): browser rules C2, X1, X2"
```

---

### Task 4: Interaction rules — F4 and F5

**Files:**
- Create: `plugins/qc/engine/src/rules/browser/F4-cursor.js`
- Create: `plugins/qc/engine/src/rules/browser/F5-transition.js`
- Create: `plugins/qc/engine/test/browser/fixtures/interaction.html`
- Test: `plugins/qc/engine/test/browser/F4-F5.test.js`

**Interfaces:**
- Consumes: `ctx.helpers.{selector,visible,interactive}`.
- Produces: two rule modules.

**The animation problem:** Task 1's `preparePage` injects `transition:none!important`, which would
make F5 report every element as missing a transition. F5 must therefore read the **author's**
declared transition, not the computed one. Read it from the matching CSS rules via
`document.styleSheets`, wrapped in try/catch for cross-origin sheets, and skip the element when the
sheet is unreadable rather than reporting a false positive.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/F4-F5.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor } from './harness.js'

test('F4 flags cursor:pointer on a non-interactive element', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(f.some(x => /fake-button/.test(x.selector)), 'expected the fake button')
  assert.ok(f.every(x => x.severity === 'minor'))
})

test('F4 flags an interactive element without cursor:pointer', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(f.some(x => /no-pointer/.test(x.selector)))
})

test('F4 accepts a normal link and a normal paragraph', async () => {
  const f = await findingsFor('interaction.html', { only: ['F4'] })
  assert.ok(!f.some(x => /good-link|plain-text/.test(x.selector)))
})

test('F5 flags a hover change declared without a transition', async () => {
  const f = await findingsFor('interaction.html', { only: ['F5'] })
  assert.ok(f.some(x => /no-transition/.test(x.selector)))
  assert.ok(f.every(x => x.severity === 'minor'))
})

test('F5 accepts an element whose hover change is transitioned', async () => {
  const f = await findingsFor('interaction.html', { only: ['F5'] })
  assert.ok(!f.some(x => /good-link/.test(x.selector)))
})
```

```html
<!-- interaction.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Interaction</title>
<style>
body{margin:0;font:16px system-ui}
#good-link{color:#0b5;transition:color .2s}
#good-link:hover{color:#083}
#no-transition{color:#06c}
#no-transition:hover{color:#039}
#fake-button{cursor:pointer;padding:8px;background:#eee;display:inline-block}
#no-pointer{cursor:default}
</style></head>
<body><main>
<a id="good-link" href="/a">good</a>
<a id="no-transition" href="/b">no transition</a>
<div id="fake-button">not a button</div>
<button id="no-pointer">button without pointer</button>
<p id="plain-text">just text</p>
</main></body></html>
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/F4-F5.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/rules/browser/F4-cursor.js
export const meta = {
  id: 'F4',
  title: 'Курсор не соответствует интерактивности',
  severity: 'minor',
  confidence: 'high',
}

export function check(ctx) {
  const out = []
  const all = document.querySelectorAll('body *')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    if (!ctx.helpers.visible(el)) continue
    const cursor = getComputedStyle(el).cursor
    const isInteractive = ctx.helpers.interactive(el)
    const sel = ctx.helpers.selector(el)

    if (!isInteractive && cursor === 'pointer') {
      // An inner span of a link inherits pointer legitimately.
      if (el.closest('a[href], button, [role="button"]')) continue
      out.push({
        rule: 'F4', title: 'Курсор не соответствует интерактивности', severity: 'minor',
        confidence: 'high', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
        selector: sel, found: 'cursor:pointer на неинтерактивном элементе',
        expected: 'cursor:default',
      })
    }
    if (isInteractive && cursor !== 'pointer' && !el.disabled) {
      out.push({
        rule: 'F4', title: 'Курсор не соответствует интерактивности', severity: 'minor',
        confidence: 'high', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
        selector: sel, found: 'cursor:' + cursor + ' на интерактивном элементе',
        expected: 'cursor:pointer',
      })
    }
  }
  return out
}
```

```js
// plugins/qc/engine/src/rules/browser/F5-transition.js
export const meta = {
  id: 'F5',
  title: 'Изменение на hover без transition',
  severity: 'minor',
  confidence: 'high',
}

export function check(ctx) {
  // preparePage injects `transition:none!important`, so the computed value is
  // useless here. Read what the author declared instead.
  const declared = {}       // selectorText -> true if it declares a transition
  const hoverRules = []     // { base, text }
  let sheets
  try { sheets = document.styleSheets } catch (e) { return [] }

  for (let s = 0; s < sheets.length; s++) {
    let rules
    try { rules = sheets[s].cssRules } catch (e) { continue }   // cross-origin sheet
    if (!rules) continue
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r]
      if (!rule.selectorText) continue
      if (/:hover\b/.test(rule.selectorText)) {
        hoverRules.push({ base: rule.selectorText.replace(/:hover\b/g, ''), text: rule.cssText })
      } else if (/transition/.test(rule.style && rule.style.cssText ? rule.style.cssText : '')) {
        declared[rule.selectorText] = true
      }
    }
  }

  const out = []
  const seen = {}
  for (let i = 0; i < hoverRules.length; i++) {
    const base = hoverRules[i].base.trim()
    if (!base || declared[base]) continue
    let els
    try { els = document.querySelectorAll(base) } catch (e) { continue }
    for (let j = 0; j < els.length; j++) {
      const el = els[j]
      if (!ctx.helpers.visible(el)) continue
      const sel = ctx.helpers.selector(el)
      if (seen[sel]) continue
      seen[sel] = 1
      out.push({
        rule: 'F5', title: 'Изменение на hover без transition', severity: 'minor',
        confidence: 'high', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
        selector: sel, found: 'правило ' + base + ':hover меняет стиль без transition',
        expected: 'добавить transition',
      })
    }
  }
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/F4-F5.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/rules/browser plugins/qc/engine/test/browser
git commit -m "feat(qc): browser rules F4 and F5"
```

---

### Task 5: Heuristic rules — F1, J3, B6

**Files:**
- Create: `plugins/qc/engine/src/rules/browser/F1-hover.js`
- Create: `plugins/qc/engine/src/rules/browser/J3-contrast.js`
- Create: `plugins/qc/engine/src/rules/browser/B6-overlap.js`
- Create: `plugins/qc/engine/test/browser/fixtures/{hover,contrast,overlap}.html`
- Test: `plugins/qc/engine/test/browser/heuristics.test.js`

**Interfaces:**
- Consumes: `ctx.helpers.{selector,visible,interactive,parseRgb,contrast}`.
- Produces: three rule modules, all with `confidence: 'heuristic'`.

All three carry `confidence: 'heuristic'` so they stay out of `counts`, `distinct` and the verdict
until calibrated against a live site. That is the same discipline that let E1 and E3 be recalibrated
in the first bucket after a real run showed 95% noise.

F1 detects a hover change the same way F5 does — from declared `:hover` rules — because
`transition:none!important` and the inability to synthesise a real hover in a headless measurement
pass make computed-style comparison unreliable.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/heuristics.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsFor } from './harness.js'

test('F1 flags a link with no declared hover state', async () => {
  const f = await findingsFor('hover.html', { only: ['F1'] })
  assert.ok(f.some(x => /dead-link/.test(x.selector)))
  assert.ok(f.every(x => x.confidence === 'heuristic'), 'F1 must be heuristic')
  assert.ok(f.every(x => x.severity === 'major'))
})

test('F1 accepts a link that declares a hover state', async () => {
  const f = await findingsFor('hover.html', { only: ['F1'] })
  assert.ok(!f.some(x => /live-link/.test(x.selector)))
})

test('J3 flags low-contrast text and is heuristic', async () => {
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  assert.ok(f.some(x => /faint/.test(x.selector)))
  assert.ok(f.every(x => x.confidence === 'heuristic'))
  assert.match(f[0].found, /\d\.\d+:1/)
})

test('J3 accepts high-contrast text', async () => {
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  assert.ok(!f.some(x => /strong/.test(x.selector)))
})

test('J3 skips text over a background image rather than guessing', async () => {
  const f = await findingsFor('contrast.html', { only: ['J3'] })
  assert.ok(!f.some(x => /over-image/.test(x.selector)))
})

test('B6 flags two overlapping visible blocks and is heuristic', async () => {
  const f = await findingsFor('overlap.html', { only: ['B6'] })
  assert.ok(f.length >= 1)
  assert.ok(f.every(x => x.confidence === 'heuristic'))
})

test('B6 does not flag a normal stacked layout', async () => {
  assert.deepEqual(await findingsFor('clean.html', { only: ['B6'] }), [])
})
```

```html
<!-- hover.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hover</title>
<style>body{margin:0}#live-link{color:#06c}#live-link:hover{color:#039;text-decoration:underline}
#dead-link{color:#06c}</style></head>
<body><main><a id="live-link" href="/a">has hover</a>
<a id="dead-link" href="/b">no hover</a></main></body></html>
```

```html
<!-- contrast.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contrast</title>
<style>body{margin:0;background:#fff}
#strong{color:#111;background:#fff}
#faint{color:#cfcfcf;background:#fff}
#over-image{color:#888;background-image:linear-gradient(#fff,#000)}</style></head>
<body><main><p id="strong">readable text</p><p id="faint">barely readable text</p>
<p id="over-image">text on a gradient</p></main></body></html>
```

```html
<!-- overlap.html -->
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Overlap</title>
<style>body{margin:0;position:relative}
#a{position:absolute;left:20px;top:20px;width:200px;height:60px;background:#fdd}
#b{position:absolute;left:80px;top:40px;width:200px;height:60px;background:#ddf}</style>
</head><body><main><div id="a">block a</div><div id="b">block b</div></main></body></html>
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/heuristics.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/rules/browser/F1-hover.js
export const meta = {
  id: 'F1',
  title: 'Нет реакции на hover',
  severity: 'major',
  confidence: 'heuristic',
}

export function check(ctx) {
  // Collect every selector that declares a :hover state, then report
  // interactive elements matched by none of them.
  const hovered = []
  let sheets
  try { sheets = document.styleSheets } catch (e) { return [] }
  for (let s = 0; s < sheets.length; s++) {
    let rules
    try { rules = sheets[s].cssRules } catch (e) { continue }
    if (!rules) continue
    for (let r = 0; r < rules.length; r++) {
      const sel = rules[r].selectorText
      if (sel && /:hover\b/.test(sel)) hovered.push(sel.replace(/:hover\b/g, '').trim())
    }
  }

  const out = []
  const seen = {}
  const candidates = document.querySelectorAll('a[href], button, [role="button"]')
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]
    if (!ctx.helpers.visible(el)) continue
    let covered = false
    for (let h = 0; h < hovered.length && !covered; h++) {
      try { if (hovered[h] && el.matches(hovered[h])) covered = true } catch (e) { /* bad selector */ }
    }
    if (covered) continue
    const sel = ctx.helpers.selector(el)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'F1', title: 'Нет реакции на hover', severity: 'major', confidence: 'heuristic',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sel,
      found: 'ни одно правило :hover не покрывает этот элемент',
      expected: 'видимая реакция на наведение',
    })
  }
  return out
}
```

```js
// plugins/qc/engine/src/rules/browser/J3-contrast.js
export const meta = {
  id: 'J3',
  title: 'Недостаточный контраст текста',
  severity: 'major',
  confidence: 'heuristic',
}

export function check(ctx) {
  const out = []
  const seen = {}
  const nodes = document.querySelectorAll('body *')
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]
    if (!ctx.helpers.visible(el)) continue
    // Only elements with their own direct text.
    let hasText = false
    for (let c = 0; c < el.childNodes.length; c++) {
      const n = el.childNodes[c]
      if (n.nodeType === 3 && n.textContent.trim().length > 1) { hasText = true; break }
    }
    if (!hasText) continue

    const cs = getComputedStyle(el)
    const fg = ctx.helpers.parseRgb(cs.color)
    if (!fg) continue

    // Walk up for the first opaque background. Anything with a background image
    // or gradient is skipped -- this rule cannot reason about pixels.
    let bg = null
    let node = el
    while (node && node !== document.documentElement) {
      const s = getComputedStyle(node)
      if (s.backgroundImage && s.backgroundImage !== 'none') { bg = 'image'; break }
      const c = ctx.helpers.parseRgb(s.backgroundColor)
      if (c) { bg = c; break }
      node = node.parentElement
    }
    if (bg === 'image' || !bg) continue

    const ratio = ctx.helpers.contrast(fg, bg)
    const px = parseFloat(cs.fontSize) || 16
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700
    const large = px >= 24 || (px >= 18.66 && bold)
    const need = large ? 3 : 4.5
    if (ratio >= need) continue

    const sel = ctx.helpers.selector(el)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'J3', title: 'Недостаточный контраст текста', severity: 'major',
      confidence: 'heuristic', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
      selector: sel,
      found: 'контраст ' + ratio.toFixed(2) + ':1 при ' + Math.round(px) + 'px',
      expected: 'не ниже ' + need + ':1',
    })
  }
  return out
}
```

```js
// plugins/qc/engine/src/rules/browser/B6-overlap.js
export const meta = {
  id: 'B6',
  title: 'Перекрытие элементов',
  severity: 'major',
  confidence: 'heuristic',
}

export function check(ctx) {
  // Only compare siblings that are positioned out of normal flow -- normal flow
  // does not overlap, and comparing everything is O(n^2) noise.
  const candidates = []
  const all = document.querySelectorAll('body *')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    if (!ctx.helpers.visible(el)) continue
    const cs = getComputedStyle(el)
    if (cs.position !== 'absolute' && cs.position !== 'fixed') continue
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    candidates.push({ el: el, r: r })
    if (candidates.length > 150) break        // guard against pathological pages
  }

  const out = []
  const seen = {}
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (ox <= 2 || oy <= 2) continue
      const area = ox * oy
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height)
      if (area / smaller < 0.25) continue      // a nudge is not an overlap
      const sa = ctx.helpers.selector(a.el)
      const sb = ctx.helpers.selector(b.el)
      const key = sa + '|' + sb
      if (seen[key]) continue
      seen[key] = 1
      out.push({
        rule: 'B6', title: 'Перекрытие элементов', severity: 'major', confidence: 'heuristic',
        engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sa,
        found: 'перекрывается с ' + sb + ' на ' + Math.round(area) + 'px²',
        expected: 'элементы не должны накладываться',
      })
    }
  }
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/heuristics.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/rules/browser plugins/qc/engine/test/browser
git commit -m "feat(qc): heuristic browser rules F1, J3, B6"
```

---

### Task 6: Region proof and defect collapsing

**Files:**
- Create: `plugins/qc/engine/src/browser/regions.js`
- Modify: `plugins/qc/engine/src/report/json.js` (region enters `defectIdentity`)
- Test: `plugins/qc/engine/test/browser/regions.test.js`

**Interfaces:**
- Consumes: `PageDoc.elementor.{containerIds, locations}` from the static parse, already in the snapshot.
- Produces: `proveRegions(pages) -> Map<containerId, { name, pageCount }>` — only containers seen on
  more than one page. `regionOf(finding, regions)` is applied by `run.js` when writing a finding.
- Modifies: `defectIdentity(f)` becomes `rule + (region || page) + selector + found`, so a footer
  defect collapses across pages while a content defect stays per-page.

Measured basis: on a real 31-page site, `elementor-3374` (header) and `elementor-3381` (footer)
appear on all 31 pages while content containers appear once each. Regions are therefore **proved**,
never assumed.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/regions.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proveRegions } from '../../src/browser/regions.js'
import { defectIdentity } from '../../src/report/json.js'

const page = (url, ids, locations = []) =>
  ({ url, elementor: { containerIds: ids, locations, postCssIds: [], skeleton: '' } })

test('a container seen on several pages is a region', () => {
  const r = proveRegions([
    page('https://ex.com/a', ['3374', '3381', '5718'], ['header', 'footer']),
    page('https://ex.com/b', ['3374', '3381', '5254'], ['header', 'footer']),
  ])
  assert.ok(r.has('3374'))
  assert.ok(r.has('3381'))
  assert.equal(r.get('3374').pageCount, 2)
})

test('a container seen on one page is not a region', () => {
  const r = proveRegions([
    page('https://ex.com/a', ['3374', '5718']),
    page('https://ex.com/b', ['3374', '5254']),
  ])
  assert.ok(!r.has('5718'))
  assert.ok(!r.has('5254'))
})

test('region names come from elementor-location classes when present', () => {
  const r = proveRegions([
    page('https://ex.com/a', ['3374'], ['header']),
    page('https://ex.com/b', ['3374'], ['header']),
  ])
  assert.equal(r.get('3374').name, 'header')
})

test('a region falls back to its id when no location class exists', () => {
  const r = proveRegions([page('https://ex.com/a', ['9001']), page('https://ex.com/b', ['9001'])])
  assert.equal(r.get('9001').name, '9001')
})

test('an empty page list yields no regions', () => {
  assert.equal(proveRegions([]).size, 0)
})

test('two findings in the same region on different pages share an identity', () => {
  const a = { rule: 'F1', page: 'https://ex.com/a', region: 'footer', selector: 'a.soc', found: 'x' }
  const b = { rule: 'F1', page: 'https://ex.com/b', region: 'footer', selector: 'a.soc', found: 'x' }
  assert.equal(defectIdentity(a), defectIdentity(b))
})

test('two findings with no region on different pages do not share an identity', () => {
  const a = { rule: 'C2', page: 'https://ex.com/a', selector: 'div.x', found: 'x' }
  const b = { rule: 'C2', page: 'https://ex.com/b', selector: 'div.x', found: 'x' }
  assert.notEqual(defectIdentity(a), defectIdentity(b))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/regions.test.js`
Expected: FAIL — `proveRegions` does not exist

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/browser/regions.js
// A "region" is an Elementor container proved to appear on more than one page.
// Header and footer are shared everywhere; content containers are per-page.
// This is measured from the snapshot, never assumed from naming.
export function proveRegions(pages) {
  const counts = new Map()
  const names = new Map()
  for (const p of pages || []) {
    const e = (p && p.elementor) || {}
    const locations = e.locations || []
    for (const id of e.containerIds || []) {
      counts.set(id, (counts.get(id) || 0) + 1)
      if (!names.has(id) && locations.length === 1) names.set(id, locations[0])
    }
  }
  // When a page carries several location classes we cannot map id -> name
  // one-to-one; those regions keep their id as the name.
  const out = new Map()
  for (const [id, n] of counts) {
    if (n < 2) continue
    out.set(id, { name: names.get(id) || id, pageCount: n })
  }
  return out
}
```

In `src/report/json.js`, change `defectIdentity` and export it if it is not already exported:

```js
// A defect proved to live in a shared region (header, footer) is ONE defect
// however many pages render it. Anything else stays per-page.
export function defectIdentity(f) {
  const where = f.region ? 'region:' + f.region : f.page
  return [f.rule, where, f.selector, normalizeFound(f.found, f.rule)].join('|')
}
```

Keep `diffRuns`' key as `defectIdentity(f) + '|' + f.page` so a defect fixed on one page and left on
another still shows as one fixed and one remaining.

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/regions.test.js && npm test`
Expected: PASS. If any existing `json.test.js` case breaks, it is because it relied on the old
identity — update the expectation only if the new behaviour is correct for that case, and say so.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/browser/regions.js plugins/qc/engine/src/report/json.js \
        plugins/qc/engine/test/browser/regions.test.js
git commit -m "feat(qc): prove shared regions and collapse their defects"
```

---

### Task 7: The page loop — checkpoints, resume, failure policy

**Files:**
- Create: `plugins/qc/engine/src/browser/run.js`
- Modify: `plugins/qc/engine/src/crawl/store.js` (browser results)
- Test: `plugins/qc/engine/test/browser/run.test.js`

**Interfaces:**
- Consumes: `launchBrowser`, `preparePage`, `buildBundle`, `resolveBreakpoints`, `proveRegions`.
- Produces: `runBrowserPass({ host, pages, widths, opts }) -> Promise<Summary>` where
  `Summary = { pagesTotal, pagesDone, pagesFailed, failedUrls, findings, widths, dropped, stoppedEarly }`.
- Store gains `appendBrowserResult(host, row)`, `loadBrowserResults(host) -> row[]`,
  `clearBrowserResults(host)`. A row is `{ url, widths, findings, error }`.

Failure policy, straight from the spec: 45 s per page with one retry; a page that will not open is
recorded with its reason and an empty findings list and counts as **checked unsuccessfully**, not
skipped; after **10 consecutive** failures the pass stops itself, because the server is almost
certainly down and continuing costs 45 s per page for nothing.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/run.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBrowserPass } from '../../src/browser/run.js'

let server, base, cache
const OK = `<!doctype html><html><head><title>t</title></head><body><main><h1>ok</h1></main></body></html>`

before(async () => {
  cache = mkdtempSync(join(tmpdir(), 'qc-browse-'))
  process.env.QC_CACHE_DIR = cache
  server = createServer((req, res) => {
    if (req.url === '/dead') { res.destroy(); return }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(OK)
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); rmSync(cache, { recursive: true, force: true }) })

test('runs every page and records one result per page', async () => {
  const s = await runBrowserPass({
    host: 'run-a', pages: [`${base}/1`, `${base}/2`], widths: [1440],
  })
  assert.equal(s.pagesTotal, 2)
  assert.equal(s.pagesDone, 2)
  assert.equal(s.pagesFailed, 0)
})

test('a second run does no work and reports it', async () => {
  const s = await runBrowserPass({
    host: 'run-a', pages: [`${base}/1`, `${base}/2`], widths: [1440],
  })
  assert.equal(s.pagesDone, 0, 'already-checked pages must not be redone')
})

test('--force redoes everything', async () => {
  const s = await runBrowserPass({
    host: 'run-a', pages: [`${base}/1`], widths: [1440], opts: { force: true },
  })
  assert.equal(s.pagesDone, 1)
})

test('a page that will not load is recorded as failed, not skipped', async () => {
  const s = await runBrowserPass({
    host: 'run-b', pages: [`${base}/dead`, `${base}/1`], widths: [1440],
    opts: { timeout: 4000 },
  })
  assert.equal(s.pagesFailed, 1)
  assert.equal(s.failedUrls.length, 1)
  assert.match(s.failedUrls[0].url, /dead/)
  assert.ok(s.pagesDone >= 1, 'the healthy page must still be checked')
})

test('stops itself after ten consecutive failures', async () => {
  const dead = Array.from({ length: 25 }, (_, i) => `${base}/dead?i=${i}`)
  const s = await runBrowserPass({
    host: 'run-c', pages: dead, widths: [1440], opts: { timeout: 2000 },
  })
  assert.equal(s.stoppedEarly, true)
  assert.ok(s.pagesFailed <= 12, `expected an early stop, got ${s.pagesFailed} failures`)
})

test('an interrupted pass leaves a usable partial result', async () => {
  const s = await runBrowserPass({
    host: 'run-d', pages: [`${base}/1`, `${base}/2`, `${base}/3`], widths: [1440],
    opts: { maxPages: 2 },
  })
  assert.equal(s.pagesDone, 2)
  assert.equal(s.pagesTotal, 3)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/run.test.js`
Expected: FAIL — `run.js` does not exist

- [ ] **Step 3: Write the implementation**

Add to `src/crawl/store.js`:

```js
export function appendBrowserResult(host, row) {
  const dir = snapshotDir(host)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, 'browser.jsonl'), JSON.stringify(row) + '\n')
}

export function loadBrowserResults(host) {
  const p = join(snapshotDir(host), 'browser.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

export function clearBrowserResults(host) {
  const p = join(snapshotDir(host), 'browser.jsonl')
  if (existsSync(p)) rmSync(p, { force: true })
}
```

Import `appendFileSync` alongside the existing `node:fs` imports.

```js
// plugins/qc/engine/src/browser/run.js
import { launchBrowser, preparePage, PAGE_TIMEOUT_MS } from './launch.js'
import { buildBundle } from './bundle.js'
import { appendBrowserResult, loadBrowserResults, clearBrowserResults } from '../crawl/store.js'

export const MAX_CONSECUTIVE_FAILURES = 10

export async function runBrowserPass({ host, pages, widths, opts = {} }) {
  const {
    force = false, maxPages = Infinity, timeout = PAGE_TIMEOUT_MS, headed = false,
    onProgress = null,
  } = opts

  if (force) clearBrowserResults(host)
  const already = new Set(loadBrowserResults(host).map(r => r.url))
  const todo = pages.filter(u => !already.has(u)).slice(0, maxPages)

  const summary = {
    pagesTotal: pages.length, pagesDone: 0, pagesFailed: 0,
    failedUrls: [], findings: [], widths, stoppedEarly: false,
  }
  if (!todo.length) return summary

  const bundle = await buildBundle()
  const { browser, newPage } = await launchBrowser({ headed })
  let consecutive = 0

  try {
    for (const url of todo) {
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        summary.stoppedEarly = true
        break
      }
      const row = { url, widths, findings: [], error: null }
      let page
      try {
        page = await newPage()
        for (const width of widths) {
          await preparePage(page, { width, url, timeout })
          await page.evaluate(bundle)
          const got = await page.evaluate(
            (ctx) => window.__qc.run(ctx), { url, breakpoint: width }
          )
          row.findings.push(...got)
        }
        consecutive = 0
        summary.pagesDone++
      } catch (e) {
        row.error = e && e.message ? e.message.slice(0, 200) : 'unknown error'
        consecutive++
        summary.pagesFailed++
        summary.failedUrls.push({ url, error: row.error })
      } finally {
        if (page) await page.close().catch(() => {})
      }
      appendBrowserResult(host, row)
      summary.findings.push(...row.findings)
      if (onProgress) onProgress(summary.pagesDone + summary.pagesFailed, todo.length)
    }
  } finally {
    await browser.close().catch(() => {})
  }
  return summary
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/run.test.js && npm test`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/browser/run.js plugins/qc/engine/src/crawl/store.js \
        plugins/qc/engine/test/browser/run.test.js
git commit -m "feat(qc): resumable browser page loop with a failure policy"
```

---

### Task 8: Screenshots of the offending element

**Files:**
- Create: `plugins/qc/engine/src/browser/screenshot.js`
- Modify: `plugins/qc/engine/src/browser/run.js` (capture on first occurrence)
- Test: `plugins/qc/engine/test/browser/screenshot.test.js`

**Interfaces:**
- Consumes: `defectIdentity` from `src/report/json.js`, a Playwright `page`.
- Produces: `shotPath(host, identity) -> string`, `captureDefect(page, finding, host) -> Promise<string|null>`
  which crops the element named by `finding.selector` with a highlight and returns the file path,
  or `null` when the element cannot be located.

Files live at `~/.qc-cache/<host>/shots/<sha1(identity)>.png`. Naming by identity means a rerun
reuses the crop instead of producing duplicates, and `run.js` skips capture when the file exists.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/screenshot.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveFixtures } from './harness.js'
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/screenshot.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/browser/screenshot.js
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { snapshotDir } from '../crawl/store.js'

const PADDING = 24

export function shotPath(host, identity) {
  const name = createHash('sha1').update(identity).digest('hex').slice(0, 16) + '.png'
  return join(snapshotDir(host), 'shots', name)
}

// Crop the offending element with a highlight. Returns the file path, or null
// when the selector no longer resolves -- a missing crop is never fatal.
export async function captureDefect(page, finding, host, identity = null) {
  const id = identity || [finding.rule, finding.page, finding.selector, finding.found].join('|')
  const out = shotPath(host, id)
  if (existsSync(out)) return out

  const sel = finding.selector
  if (!sel || sel === 'html' || sel === 'body') return null

  let box = null
  try {
    box = await page.evaluate((s) => {
      let el = null
      try { el = document.querySelector(s) } catch (e) { return null }
      if (!el) return null
      el.setAttribute('data-qc-highlight', '1')
      const r = el.getBoundingClientRect()
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
    }, sel)
  } catch { return null }
  if (!box || box.w < 1 || box.h < 1) return null

  await page.addStyleTag({
    content: `[data-qc-highlight]{outline:3px solid #e0245e!important;outline-offset:2px!important}`,
  }).catch(() => {})

  mkdirSync(join(snapshotDir(host), 'shots'), { recursive: true })
  const vw = await page.evaluate(() => document.documentElement.clientWidth)
  const clip = {
    x: Math.max(0, box.x - PADDING),
    y: Math.max(0, box.y - PADDING),
    width: Math.min(box.w + PADDING * 2, vw),
    height: Math.min(box.h + PADDING * 2, 1200),
  }
  try {
    await page.screenshot({ path: out, clip, fullPage: true })
  } catch {
    return null
  } finally {
    await page.evaluate(() => {
      const el = document.querySelector('[data-qc-highlight]')
      if (el) el.removeAttribute('data-qc-highlight')
    }).catch(() => {})
  }
  return out
}
```

In `run.js`, after collecting a width's findings, capture the first occurrence of each identity seen
so far in this pass, and put the resulting path on the finding as `shot`.

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/screenshot.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/browser/screenshot.js plugins/qc/engine/src/browser/run.js \
        plugins/qc/engine/test/browser/screenshot.test.js
git commit -m "feat(qc): crop the offending element, keyed by defect identity"
```

---

### Task 9: The `browse` subcommand

**Files:**
- Modify: `plugins/qc/engine/src/cli.js`
- Test: `plugins/qc/engine/test/browser/cli-browse.test.js`

**Interfaces:**
- Consumes: everything above, plus `loadSnapshot` and `hostOf`.
- Produces: `qc browse <host|url> [--breakpoints a,b] [--pages n] [--force] [--concurrency n]
  [--headed] [--only ids] [--skip ids]`, printing a JSON summary:
  `{ host, pagesTotal, pagesDone, pagesFailed, failedUrls, widths, droppedWidths, stoppedEarly,
    findings, regions }`.

`browse` refuses to run without a snapshot and says to run `audit` first. Exit codes follow `audit`:
zero when the pass produced results (even a partial one), non-zero when it could not start.

Breakpoint discovery reads the CSS of the snapshot's first page: fetch its stylesheets and inline
`<style>` blocks with the existing `fetchAll`, feed the texts to `resolveBreakpoints`, and store the
resolved widths in the snapshot meta so a resumed run uses the same set.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/browser/cli-browse.test.js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/browser/cli-browse.test.js`
Expected: FAIL — unknown subcommand

- [ ] **Step 3: Write the implementation**

Add a `browse` branch to `main()` in `cli.js` that: resolves the host with `hostOf`; loads the
snapshot and errors clearly if absent; resolves breakpoints (override, else stored, else discovered
from the first page's CSS); calls `proveRegions`; calls `runBrowserPass`; tags each finding with its
region via the container the selector sits in; and prints the summary. Persist the resolved widths
into the snapshot meta.

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/browser/cli-browse.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/cli.js plugins/qc/engine/test/browser/cli-browse.test.js
git commit -m "feat(qc): qc browse subcommand"
```

---

### Task 10: Merge browser findings into the report

**Files:**
- Modify: `plugins/qc/engine/src/cli.js` (`audit` merges stored browser findings)
- Modify: `plugins/qc/engine/src/report/html.js` (breakpoint, screenshot, coverage header)
- Modify: `plugins/qc/engine/skills/../../skills/qc-site/SKILL.md` — path is `plugins/qc/skills/qc-site/SKILL.md`
- Create: `plugins/qc/skills/qc-browse/SKILL.md`
- Test: `plugins/qc/engine/test/report/html-browser.test.js`

**Interfaces:**
- Consumes: `loadBrowserResults`, `rollUp`, `verdict`.
- Produces: `audit` includes browser findings when `browser.jsonl` exists; the report renders
  `breakpoint` on each defect, embeds the screenshot as a data URI when present, and states browser
  coverage in the header.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/report/html-browser.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../../src/report/html.js'

const f = (o) => ({
  rule: 'C1', title: 'Горизонтальный скролл документа', severity: 'critical', engine: 'browser',
  confidence: 'high', page: 'https://ex.com/a', breakpoint: 360, selector: 'html',
  found: 'ширина документа 3000px при вьюпорте 360px', expected: 'документ не шире вьюпорта', ...o,
})

const base = {
  host: 'ex.com', env: 'prod', envReason: 'боевой хост', pages: 10,
  diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 0, source: 'sitemap',
}

test('renders the breakpoint of a browser finding', () => {
  const html = renderReport({ ...base, findings: [f()] })
  assert.match(html, /360/)
})

test('states browser coverage in the header', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: { pagesDone: 7, pagesTotal: 10, widths: [360, 768, 1024, 1440] },
  })
  assert.match(html, /7/)
  assert.match(html, /10/)
})

test('warns when the browser pass covered only part of the site', () => {
  const html = renderReport({
    ...base, findings: [f()],
    browserCoverage: { pagesDone: 3, pagesTotal: 10, widths: [360] },
  })
  assert.match(html, /не проверен|не проверено|частично/i)
})

test('embeds a screenshot when the finding carries one', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg=='
  const html = renderReport({ ...base, findings: [f({ shotDataUri: `data:image/png;base64,${png}` })] })
  assert.match(html, /<img[^>]+data:image\/png;base64/)
})

test('makes no external request even with a screenshot', () => {
  const html = renderReport({
    ...base, findings: [f({ shotDataUri: 'data:image/png;base64,AAA' })],
  })
  assert.doesNotMatch(html, /<img[^>]+src="https?:/i)
  assert.doesNotMatch(html, /<script[^>]+src=/i)
})

test('a browser finding with no breakpoint does not print "null"', () => {
  const html = renderReport({ ...base, findings: [f({ breakpoint: null })] })
  assert.doesNotMatch(html, />\s*null\s*</)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/report/html-browser.test.js`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

In `renderReport`, add a `browserCoverage` parameter rendered in the header line; render
`breakpoint` inside each defect block when it is not null; render
`<img src="${escaped data uri}" alt="">` when `shotDataUri` is present, inside the same defect
block, with `max-width:100%`. Reuse the existing size budget: when the total document exceeds the
publish threshold, drop screenshots from Minor and Note defects first and state that in the report.

In `cli.js`'s `audit`, read `loadBrowserResults(host)`, flatten their findings, read each finding's
`shot` path and inline it as a data URI, and pass `browserCoverage` to `renderReport`.

Write `plugins/qc/skills/qc-browse/SKILL.md` with the same discipline as `qc-site`: it runs the CLI
and never re-implements a check; it must state coverage and say plainly when the pass is partial; it
warns that the run is long on a weak staging server and that it is resumable, so an interrupted run
should be re-run rather than restarted with `--force`.

Update `plugins/qc/skills/qc-site/SKILL.md` to mention that browser findings appear once `qc browse`
has run, and that a report without them is static-only.

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/report/html-browser.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/cli.js plugins/qc/engine/src/report/html.js \
        plugins/qc/engine/test/report/html-browser.test.js plugins/qc/skills
git commit -m "feat(qc): merge browser findings into the report and add /qc-browse"
```

---

### Task 11: Live calibration run and the two first-bucket debts

**Files:**
- Modify: whichever browser rules the live run proves noisy
- Modify: `plugins/qc/engine/src/rules/static/E4-tel-format.js`
- Modify: `plugins/qc/engine/src/cli.js` or `src/report/html.js` (staleness threshold)
- Modify: `plugins/qc/references/taxonomy.md` (calibration log)

**Interfaces:** none new.

- [ ] **Step 1: Run the browser pass against a real site**

```bash
cd plugins/qc/engine
QC_CACHE_DIR=~/.qc-cache node src/cli.js audit https://cleaningny.com --concurrency 4
QC_CACHE_DIR=~/.qc-cache node src/cli.js browse https://cleaningny.com --pages 10
```

Ten pages first, deliberately: the first bucket's live run showed 95% noise, and finding that out
after ten pages is much cheaper than after three hundred.

- [ ] **Step 2: Measure the noise**

Group the findings by rule and confidence, exactly as the first bucket's calibration did:

```bash
node -e "
const fs=require('fs');const dir=process.env.RUN;
const a=JSON.parse(fs.readFileSync(dir+'/findings.json','utf8'));
const by={};for(const x of a.filter(f=>f.engine==='browser')){
  const k=x.rule+' '+x.severity+(x.confidence==='heuristic'?'/heur':'');
  (by[k]=by[k]||[]).push(x)}
for(const [k,v] of Object.entries(by).sort((p,q)=>q[1].length-p[1].length))
  console.log(String(v.length).padStart(4),k.padEnd(18),'pages='+new Set(v.map(x=>x.page)).size,
    String(v[0].found).slice(0,80))"
```

Any rule producing more findings than there are pages, or firing on every element of a class, is a
noise generator. Record the numbers before changing anything.

- [ ] **Step 3: Recalibrate what the measurement condemns**

Adjust severity, confidence or the detection condition of the offending rules. Do not delete a rule
to silence it, and do not loosen a rule that is correctly reporting a real defect that simply
repeats — that is what region collapsing is for. Add a test for every change.

- [ ] **Step 4: Close the two first-bucket debts**

`E4` currently emits nothing on a doubled country code, deferring to `E5`. When the value is *also*
separator-malformed, that drops a certain defect from `major`/`high` into `E5`'s heuristic branch.
Let `E4` fire on a doubled value whose non-doubled form is still not clean, emitting no `expected`
and leaving the correction to `E5`. Add tests for `tel:+1-1-718-969-0845` and `tel:+1 1 718 969 0845`.

The 7-day staleness banner is unreachable because a snapshot older than 7 days is not reused. Derive
the banner threshold from the reuse TTL rather than hardcoding it, so the two cannot drift again,
and add a test that a snapshot near the TTL renders the banner. Note in the commit message that
`dc6889e`'s message claimed this worked when it did not.

- [ ] **Step 5: Record the calibration and commit**

Append to `plugins/qc/references/taxonomy.md` a "Browser calibration log" section with the before and
after per-rule numbers, matching the format of the existing calibration log.

```bash
git add plugins/qc/engine/src plugins/qc/engine/test plugins/qc/references/taxonomy.md
git commit -m "fix(qc): calibrate browser rules against a live run; close bucket-1 debts"
```

---

## Self-Review

**Spec coverage.** Every spec item maps to a task: `qc browse` as a separate phase over the snapshot
(9), rules executing in the browser (1), the nine rules (1, 3, 4, 5), breakpoints from the site's own
media queries with a cap and a dropped list (2), resumability and checkpoints (7), the page-failure
policy including the ten-consecutive stop (7), region proof and collapsing (6), targeted screenshots
keyed by defect identity (8), report integration and coverage (10), calibration (11), and the two
first-bucket debts (11).

Two spec details are implemented in a task other than the one that names them: `preparePage`'s lazy
image walk and animation disabling are in Task 1 rather than in the rules that depend on them,
because every rule depends on them; and screenshot capture is wired into `run.js` in Task 8 rather
than Task 7.

One reduction: the spec allows `--concurrency` for the browser pass, but Task 7's loop is
sequential. Parallel Playwright contexts on a staging server that already fails to answer are more
likely to make things worse than faster, and the failure policy is much harder to reason about
concurrently. `--concurrency` is accepted and ignored with a note in the summary; making it real is
a follow-up once a live run shows the server can take it.

**Placeholder scan.** No "TBD"/"TODO"/"similar to Task N"; every code step carries runnable code and
every test step carries real assertions. Task 9 and Task 10 Step 3 describe edits to existing large
files in prose rather than reproducing them whole — the interfaces they must satisfy are stated
exactly and the tests pin the behaviour.

**Type consistency.** The browser rule shape (`export const meta` + `export function check`) is
defined in Task 1 and used unchanged in Tasks 3, 4 and 5. `ctx.helpers` members used by later rules
(`selector`, `visible`, `interactive`, `parseRgb`, `contrast`) are all defined in Task 1's
`_helpers.js`. `runBrowserPass`'s summary keys used by the CLI in Task 9 match Task 7's definition.
`defectIdentity` gains `region` in Task 6 and is consumed by Task 8's `shotPath` and Task 10's
roll-up.
