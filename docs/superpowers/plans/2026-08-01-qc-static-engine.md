# QC Static Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working `/qc-site` that crawls a WordPress+Elementor site, runs every static (HTML-only) rule from bucket 1, and publishes a rule-grouped HTML report — with no browser involved.

**Architecture:** A dependency-light Node ESM engine under `plugins/qc/engine`. Pure functions all the way: `fetch → parse → PageDoc → rules(page, site) → findings → report`. Every rule is its own file exporting one object with a `check()` method, so rules are added and calibrated in isolation. The Claude skill is a thin wrapper that shells out to the engine CLI and publishes the report.

**Tech Stack:** Node 24 (ESM), `node:test` + `node:assert/strict` for tests, `node-html-parser` for DOM parsing, `node:zlib` for the XLSX reader. No Playwright in this plan — the browser pass is a separate follow-up plan.

## Global Constraints

- Node ESM only (`"type": "module"`). No TypeScript, no build step.
- Runtime dependencies limited to `node-html-parser`. Everything else uses Node built-ins.
- Snapshot cache lives at `$QC_CACHE_DIR` (default `~/.qc-cache/<host>/`) — never inside the repo.
- Crawl politeness: concurrency default 6, timeout 20 s, 2 retries on network error and 5xx, auto-drop to concurrency 2 on any 429 or 503.
- Every rule sets `confidence: "high"` unless the spec marks it a heuristic.
- Severity values are exactly `critical` | `major` | `minor` | `note`.
- Rule IDs match the taxonomy in `plugins/qc/references/taxonomy.md` verbatim.
- Findings never contain secrets or full page HTML — only a selector plus short `found`/`expected` strings.
- All user-facing report copy is in Russian; code identifiers and comments are in English.

## Deviation from the spec (accepted)

The spec said "единственная зависимость — playwright". Static parsing needs a real DOM, and doing
it through Playwright would force every unit test to boot a browser. We add **`node-html-parser`**
(zero transitive deps) so rules stay pure and tests stay fast. Playwright arrives with the browser
plan and remains the only other dependency.

The spec listed `uploads/elementor/css/post-<ID>.css` as half of the template fingerprint.
Verified against the live site `cleaningny.com`: that file does not exist there because Elementor
inlines CSS. The fingerprint therefore uses **container IDs + widget skeleton**, and treats
post-CSS IDs as an optional extra signal when present. Template work lives in the browser plan;
this plan only records the raw signals in the snapshot.

## File Structure

```
plugins/qc/engine/
  package.json                    # ESM, deps: node-html-parser; scripts: test
  src/
    cli.js                        # arg parsing, subcommands: crawl, audit, report, cache
    lib/url.js                    # URL normalization / internal-vs-external
    lib/text.js                   # whitespace + phone digit helpers
    lib/env.js                    # dev/prod detection
    parse/page.js                 # raw HTML -> PageDoc
    parse/index.js                # site-wide aggregates (dup titles, dup descriptions)
    crawl/fetch.js                # polite concurrent fetcher
    crawl/discover.js             # robots.txt / sitemap / same-host crawl
    crawl/xlsx.js                 # minimal XLSX reader (zip + SpreadsheetML)
    crawl/sheet.js                # strategy sheet -> page list with dev/prod pairs
    crawl/store.js                # snapshot read/write/clear
    crawl/links.js                # link status checker
    rules/index.js                # rule registry + runner
    rules/static/E1-broken-links.js
    rules/static/E3-target-blank.js
    rules/static/E4-tel-format.js
    rules/static/E5-duplicate-plus-one.js
    rules/static/E6-mailto-and-bare-contacts.js
    rules/static/I1-h1-count.js
    rules/static/I2-heading-hierarchy.js
    rules/static/I3-h1-image.js
    rules/static/I4-noindex.js
    rules/static/I5-canonical.js
    rules/static/I6-title.js
    rules/static/I7-meta-description.js
    rules/static/I13-favicon.js
    rules/static/I14-dev-artifacts.js
    rules/static/H1-lorem.js
    rules/static/H7-image-alt.js
    rules/static/J1-landmarks.js
    rules/static/G1-privacy-checkbox.js
    rules/static/G3-required-marker.js
    rules/static/G5-phone-input-type.js
    rules/static/S1-jsonld.js
    report/json.js                # findings.json + roll-up + previous-run diff
    report/html.js                # self-contained HTML report
  test/
    fixtures/opura-office-cleaning.html   # already committed: real Elementor+Gravity page
    fixtures/*.html                       # small hand-written fixtures per rule
    lib/url.test.js
    parse/page.test.js
    rules/<rule-id>.test.js
    crawl/xlsx.test.js
plugins/qc/skills/qc-site/SKILL.md
plugins/qc/skills/qc-cache/SKILL.md
plugins/qc/.claude-plugin/plugin.json
plugins/qc/references/taxonomy.md
```

`I8` (pagination) is deliberately absent from this plan: it needs the crawled set of paginated URLs
plus their canonical/robots values, which only becomes meaningful once discovery is done. It is
added in Task 13 after the crawler exists.

---

### Task 1: Engine scaffold and URL helpers

**Files:**
- Create: `plugins/qc/engine/package.json`
- Create: `plugins/qc/engine/src/lib/url.js`
- Test: `plugins/qc/engine/test/lib/url.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeUrl(input, base) -> string|null`, `isHttpUrl(u) -> boolean`,
  `sameHost(a, b) -> boolean`, `hostOf(u) -> string|null`.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/lib/url.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl, isHttpUrl, sameHost, hostOf } from '../../src/lib/url.js'

test('normalizeUrl resolves relative against base and drops the fragment', () => {
  assert.equal(
    normalizeUrl('/about#team', 'https://ex.com/a/b'),
    'https://ex.com/about'
  )
})

test('normalizeUrl lowercases the host and drops the default port', () => {
  assert.equal(normalizeUrl('https://EX.com:443/x'), 'https://ex.com/x')
})

test('normalizeUrl keeps the query string', () => {
  assert.equal(normalizeUrl('https://ex.com/x?p=2'), 'https://ex.com/x?p=2')
})

test('normalizeUrl returns null for non-http schemes and junk', () => {
  assert.equal(normalizeUrl('mailto:a@b.com'), null)
  assert.equal(normalizeUrl('tel:+1555'), null)
  assert.equal(normalizeUrl('javascript:void(0)'), null)
  assert.equal(normalizeUrl('#top'), null)
  assert.equal(normalizeUrl(''), null)
})

test('isHttpUrl accepts only http and https', () => {
  assert.equal(isHttpUrl('https://ex.com'), true)
  assert.equal(isHttpUrl('mailto:a@b.com'), false)
})

test('sameHost ignores a leading www', () => {
  assert.equal(sameHost('https://www.ex.com/a', 'https://ex.com/b'), true)
  assert.equal(sameHost('https://ex.com/a', 'https://other.com/b'), false)
})

test('hostOf returns null for junk', () => {
  assert.equal(hostOf('not a url'), null)
  assert.equal(hostOf('https://Ex.com/a'), 'ex.com')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/lib/url.test.js`
Expected: FAIL — `Cannot find module '../../src/lib/url.js'`

- [ ] **Step 3: Write package.json and the implementation**

```json
{
  "name": "qc-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "qc": "./src/cli.js" },
  "scripts": { "test": "node --test test/**/*.test.js" },
  "dependencies": { "node-html-parser": "^7.0.1" }
}
```

```js
// plugins/qc/engine/src/lib/url.js
const HTTP = new Set(['http:', 'https:'])

export function normalizeUrl(input, base) {
  if (!input || typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.startsWith('#')) return null
  let u
  try {
    u = base ? new URL(raw, base) : new URL(raw)
  } catch {
    return null
  }
  if (!HTTP.has(u.protocol)) return null
  u.hash = ''
  u.hostname = u.hostname.toLowerCase()
  if ((u.protocol === 'https:' && u.port === '443') ||
      (u.protocol === 'http:' && u.port === '80')) {
    u.port = ''
  }
  return u.toString()
}

export function isHttpUrl(input) {
  try {
    return HTTP.has(new URL(input).protocol)
  } catch {
    return false
  }
}

export function hostOf(input) {
  try {
    return new URL(input).hostname.toLowerCase()
  } catch {
    return null
  }
}

const bare = (h) => (h || '').replace(/^www\./, '')

export function sameHost(a, b) {
  const ha = hostOf(a)
  const hb = hostOf(b)
  return Boolean(ha && hb && bare(ha) === bare(hb))
}
```

- [ ] **Step 4: Install the dependency and run the tests**

Run: `cd plugins/qc/engine && npm install && node --test test/lib/url.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/package.json plugins/qc/engine/package-lock.json \
        plugins/qc/engine/src/lib/url.js plugins/qc/engine/test/lib/url.test.js
git commit -m "feat(qc): engine scaffold and URL helpers"
```

---

### Task 2: Parse HTML into a PageDoc

**Files:**
- Create: `plugins/qc/engine/src/lib/text.js`
- Create: `plugins/qc/engine/src/parse/page.js`
- Test: `plugins/qc/engine/test/parse/page.test.js`
- Uses: `plugins/qc/engine/test/fixtures/opura-office-cleaning.html` (already committed)

**Interfaces:**
- Consumes: `normalizeUrl`, `sameHost` from Task 1.
- Produces: `parsePage({ url, html, status = 200, headers = {} }) -> PageDoc`, and `squash(s) -> string`
  plus `digitsOnly(s) -> string` from `lib/text.js`.

`PageDoc` shape — later tasks depend on these exact property names:

```js
{
  url, status, env: null,
  title, metaDescription, canonical, lang,
  robots: { index, follow, raw },
  headings: [{ level, text, imageOnly, selector }],
  links:    [{ raw, href, protocol, rel, target, text, internal, selector }],
  images:   [{ src, alt, hasAlt, decorative, selector }],
  forms:    [{ id, gravity, hasPrivacyCheckbox, fields: [{ inputType, required, markedRequired, selector }] }],
  jsonLd:   [{ ok, error, types }],
  favicons: [{ href, rel }],
  elementor:{ containerIds: [], locations: [], postCssIds: [], skeleton },
  landmarks:{ header: n, main: n, nav: n },
  text
}
```

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/parse/page.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePage } from '../../src/parse/page.js'

const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
const doc = parsePage({ url: 'https://cleaningny.com/services/office-cleaning/', html })

test('extracts canonical', () => {
  assert.equal(doc.canonical, 'https://cleaningny.com/services/office-cleaning/')
})

test('defaults to index,follow when no robots meta is present', () => {
  assert.equal(doc.robots.index, true)
  assert.equal(doc.robots.follow, true)
})

test('finds exactly one h1', () => {
  assert.equal(doc.headings.filter(h => h.level === 1).length, 1)
})

test('classifies internal and external links', () => {
  assert.ok(doc.links.length > 10)
  assert.ok(doc.links.some(l => l.internal === true))
  assert.ok(doc.links.every(l => typeof l.selector === 'string'))
})

test('captures tel links with their raw href', () => {
  const tel = doc.links.filter(l => l.protocol === 'tel:')
  assert.ok(tel.length >= 1)
  assert.equal(tel[0].raw, 'tel:+17189690845')
})

test('detects the Gravity form and its fields', () => {
  assert.ok(doc.forms.length >= 1)
  const gf = doc.forms.find(f => f.gravity)
  assert.ok(gf, 'expected a gravity form')
  assert.ok(gf.fields.length > 0)
})

test('records elementor container ids and locations', () => {
  assert.ok(doc.elementor.containerIds.includes('3374'))
  assert.ok(doc.elementor.locations.includes('header'))
  assert.ok(doc.elementor.locations.includes('footer'))
})

test('builds a widget skeleton that ignores text', () => {
  assert.match(doc.elementor.skeleton, /heading\.default/)
  assert.doesNotMatch(doc.elementor.skeleton, /Office Cleaning Services/)
})

test('parses images and alt presence', () => {
  assert.ok(doc.images.length > 0)
  assert.ok(doc.images.every(i => typeof i.hasAlt === 'boolean'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/parse/page.test.js`
Expected: FAIL — `Cannot find module '../../src/parse/page.js'`

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/lib/text.js
export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
export const digitsOnly = (s) => String(s ?? '').replace(/\D+/g, '')
```

```js
// plugins/qc/engine/src/parse/page.js
import { parse } from 'node-html-parser'
import { normalizeUrl, sameHost } from '../lib/url.js'
import { squash } from '../lib/text.js'

// A short, human-readable path to an element. Not a guaranteed-unique CSS selector —
// it exists so a human can find the element in devtools.
function selectorOf(el) {
  const tag = el.rawTagName || 'node'
  const id = el.getAttribute('id')
  if (id) return `${tag}#${id}`
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2)
  return cls.length ? `${tag}.${cls.join('.')}` : tag
}

function protocolOf(raw) {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec((raw || '').trim())
  return m ? m[1].toLowerCase() : null
}

function parseRobots(root) {
  const el = root.querySelector('meta[name="robots" i]')
  const raw = el ? (el.getAttribute('content') || '') : null
  const v = (raw || '').toLowerCase()
  return {
    raw,
    index: !v.includes('noindex'),
    follow: !v.includes('nofollow'),
  }
}

function parseForms(root) {
  return root.querySelectorAll('form').map((form) => {
    const wrapper = form.closest?.('.gform_wrapper') || null
    const scope = wrapper || form
    const gravity = Boolean(wrapper) || /^gform_/.test(form.getAttribute('id') || '')

    const fields = scope.querySelectorAll('.gfield').map((f) => {
      const cls = f.getAttribute('class') || ''
      const input = f.querySelector('input, textarea, select')
      return {
        inputType: input ? (input.getAttribute('type') || input.rawTagName) : null,
        required: cls.includes('gfield_contains_required'),
        markedRequired: Boolean(f.querySelector('.gfield_required')),
        selector: selectorOf(f),
      }
    })

    const hasPrivacyCheckbox = scope.querySelectorAll('.gfield').some((f) => {
      const hasCheckbox = Boolean(f.querySelector('input[type="checkbox"]'))
      const label = (f.text || '').toLowerCase()
      const linksPrivacy = f.querySelectorAll('a').some((a) =>
        /privacy/i.test(a.getAttribute('href') || '') || /privacy policy/i.test(a.text || ''))
      return hasCheckbox && (linksPrivacy || label.includes('privacy policy'))
    })

    return { id: form.getAttribute('id') || null, gravity, hasPrivacyCheckbox, fields }
  })
}

function parseElementor(root) {
  const containerIds = new Set()
  const locations = new Set()
  for (const el of root.querySelectorAll('.elementor')) {
    for (const c of (el.getAttribute('class') || '').split(/\s+/)) {
      const id = /^elementor-(\d+)$/.exec(c)
      if (id) containerIds.add(id[1])
      const loc = /^elementor-location-(.+)$/.exec(c)
      if (loc) locations.add(loc[1])
    }
  }
  const postCssIds = [...new Set(
    root.querySelectorAll('link[rel="stylesheet"]')
      .map(l => /elementor\/css\/post-(\d+)\.css/.exec(l.getAttribute('href') || ''))
      .filter(Boolean).map(m => m[1])
  )]
  const skeleton = root.querySelectorAll('[data-widget_type]')
    .map(el => el.getAttribute('data-widget_type'))
    .join('>')
  return {
    containerIds: [...containerIds],
    locations: [...locations],
    postCssIds,
    skeleton,
  }
}

export function parsePage({ url, html, status = 200, headers = {} }) {
  const root = parse(html, { blockTextElements: { script: true, style: true } })

  const canonicalEl = root.querySelector('link[rel="canonical" i]')
  const descEl = root.querySelector('meta[name="description" i]')
  const titleEl = root.querySelector('title')
  const htmlEl = root.querySelector('html')

  const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6').map((h) => ({
    level: Number(h.rawTagName.slice(1)),
    text: squash(h.text),
    imageOnly: squash(h.text) === '' && Boolean(h.querySelector('img,svg')),
    selector: selectorOf(h),
  }))

  const links = root.querySelectorAll('a[href]').map((a) => {
    const raw = (a.getAttribute('href') || '').trim()
    const href = normalizeUrl(raw, url)
    return {
      raw,
      href,
      protocol: protocolOf(raw),
      rel: a.getAttribute('rel') || null,
      target: a.getAttribute('target') || null,
      text: squash(a.text),
      internal: href ? sameHost(href, url) : false,
      selector: selectorOf(a),
    }
  })

  const images = root.querySelectorAll('img').map((img) => {
    const alt = img.getAttribute('alt')
    return {
      src: normalizeUrl(img.getAttribute('src') || img.getAttribute('data-src') || '', url),
      alt: alt == null ? null : alt,
      hasAlt: alt != null,
      decorative: alt === '' || img.getAttribute('role') === 'presentation',
      selector: selectorOf(img),
    }
  })

  const jsonLd = root.querySelectorAll('script[type="application/ld+json" i]').map((s) => {
    try {
      const data = JSON.parse(s.text)
      const arr = Array.isArray(data) ? data : [data]
      return { ok: true, error: null, types: arr.map(d => d?.['@type']).filter(Boolean) }
    } catch (e) {
      return { ok: false, error: e.message, types: [] }
    }
  })

  const favicons = root.querySelectorAll('link[rel]')
    .filter(l => /icon/i.test(l.getAttribute('rel') || ''))
    .map(l => ({ href: normalizeUrl(l.getAttribute('href') || '', url), rel: l.getAttribute('rel') }))

  return {
    url,
    status,
    env: null,
    title: titleEl ? squash(titleEl.text) : null,
    metaDescription: descEl ? squash(descEl.getAttribute('content') || '') : null,
    canonical: canonicalEl ? normalizeUrl(canonicalEl.getAttribute('href') || '', url) : null,
    lang: htmlEl ? htmlEl.getAttribute('lang') || null : null,
    robots: parseRobots(root),
    headings,
    links,
    images,
    forms: parseForms(root),
    jsonLd,
    favicons,
    elementor: parseElementor(root),
    landmarks: {
      header: root.querySelectorAll('header').length,
      main: root.querySelectorAll('main').length,
      nav: root.querySelectorAll('nav').length,
    },
    text: squash(root.querySelector('body')?.text || ''),
    contentType: headers['content-type'] || null,
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/parse/page.test.js`
Expected: PASS — 9 tests. If `closest` is unavailable on the parser's element type, replace the
`form.closest('.gform_wrapper')` call with a walk up `form.parentNode` checking for the class, and
re-run.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/lib/text.js plugins/qc/engine/src/parse/page.js \
        plugins/qc/engine/test/parse/page.test.js
git commit -m "feat(qc): parse HTML into a PageDoc"
```

---

### Task 3: Rule registry and the first rule (E4, tel format)

**Files:**
- Create: `plugins/qc/engine/src/rules/index.js`
- Create: `plugins/qc/engine/src/rules/static/E4-tel-format.js`
- Test: `plugins/qc/engine/test/rules/E4.test.js`

**Interfaces:**
- Consumes: `PageDoc` from Task 2, `digitsOnly` from `lib/text.js`.
- Produces: `runStaticRules(pages, site) -> Finding[]`, `allRules() -> Rule[]`,
  `finding(rule, page, props) -> Finding`.
  `Rule = { id, title, severity, engine, confidence?, check(page, site) -> Finding[] }`.
  `Finding = { rule, title, severity, engine, page, breakpoint, selector, found, expected, confidence }`.
  `site = { host, env, pages, index }` — `index` arrives in Task 6; rules must tolerate
  `site.index` being undefined.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/rules/E4.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import rule from '../../src/rules/static/E4-tel-format.js'

const pageWith = (raws) => ({
  url: 'https://ex.com/a',
  links: raws.map((raw, i) => ({
    raw, href: null, protocol: 'tel:', rel: null, target: null,
    text: raw, internal: false, selector: `a.phone-${i}`,
  })),
})

test('accepts a clean E.164 number', () => {
  assert.deepEqual(rule.check(pageWith(['tel:+17189690845']), {}), [])
})

test('flags dashes, spaces and dots', () => {
  const f = rule.check(pageWith(['tel:855-607-8758']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'E4')
  assert.equal(f[0].expected, 'tel:+18556078758')
  assert.equal(f[0].severity, 'major')
})

test('flags a missing country code', () => {
  const f = rule.check(pageWith(['tel:7189690845']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].expected, 'tel:+17189690845')
})

test('ignores non-tel links', () => {
  const page = { url: 'https://ex.com/a', links: [
    { raw: '/about', protocol: null, selector: 'a', text: 'About' },
  ] }
  assert.deepEqual(rule.check(page, {}), [])
})

test('does not crash on an empty tel', () => {
  assert.equal(rule.check(pageWith(['tel:']), {}).length, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/rules/E4.test.js`
Expected: FAIL — `Cannot find module '../../src/rules/static/E4-tel-format.js'`

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/rules/index.js
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function finding(rule, page, props) {
  return {
    rule: rule.id,
    title: rule.title,
    severity: rule.severity,
    engine: rule.engine,
    confidence: rule.confidence || 'high',
    page: page.url,
    breakpoint: null,
    selector: null,
    found: null,
    expected: null,
    ...props,
  }
}

let cache = null

export async function allRules() {
  if (cache) return cache
  const dir = join(here, 'static')
  const files = readdirSync(dir).filter(f => f.endsWith('.js')).sort()
  const mods = await Promise.all(
    files.map(f => import(pathToFileURL(join(dir, f)).href))
  )
  cache = mods.map(m => m.default)
  return cache
}

export async function runStaticRules(pages, site, { only = [], skip = [] } = {}) {
  const rules = (await allRules()).filter(r =>
    (only.length === 0 || only.includes(r.id)) && !skip.includes(r.id))
  const out = []
  for (const page of pages) {
    for (const rule of rules) {
      try {
        out.push(...(rule.check(page, site) || []))
      } catch (e) {
        out.push({
          rule: rule.id, title: rule.title, severity: 'note', engine: 'static',
          confidence: 'high', page: page.url, breakpoint: null, selector: null,
          found: `rule crashed: ${e.message}`, expected: null,
        })
      }
    }
  }
  return out
}
```

```js
// plugins/qc/engine/src/rules/static/E4-tel-format.js
import { finding } from '../index.js'
import { digitsOnly } from '../../lib/text.js'

const CLEAN = /^tel:\+\d{8,15}$/

function expectedFor(raw) {
  let d = digitsOnly(raw)
  if (!d) return null
  if (d.length === 10) d = `1${d}`          // US number without a country code
  return `tel:+${d}`
}

export default {
  id: 'E4',
  title: 'Формат tel: в HTML',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const link of page.links || []) {
      if (link.protocol !== 'tel:') continue
      const raw = link.raw || ''
      if (CLEAN.test(raw)) continue
      out.push(finding(this, page, {
        selector: link.selector,
        found: raw,
        expected: expectedFor(raw) || 'tel:+1XXXXXXXXXX',
      }))
    }
    return out
  },
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/rules/E4.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/rules/index.js \
        plugins/qc/engine/src/rules/static/E4-tel-format.js \
        plugins/qc/engine/test/rules/E4.test.js
git commit -m "feat(qc): rule registry and E4 tel format rule"
```

---

### Task 4: Link-shape rules (E3, E5, E6)

**Files:**
- Create: `plugins/qc/engine/src/rules/static/E3-target-blank.js`
- Create: `plugins/qc/engine/src/rules/static/E5-duplicate-plus-one.js`
- Create: `plugins/qc/engine/src/rules/static/E6-mailto-and-bare-contacts.js`
- Test: `plugins/qc/engine/test/rules/E3-E5-E6.test.js`

**Interfaces:**
- Consumes: `finding` from Task 3, `PageDoc.links`, `PageDoc.text`.
- Produces: three rule modules; no new shared functions.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/rules/E3-E5-E6.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import E3 from '../../src/rules/static/E3-target-blank.js'
import E5 from '../../src/rules/static/E5-duplicate-plus-one.js'
import E6 from '../../src/rules/static/E6-mailto-and-bare-contacts.js'

const link = (o) => ({
  raw: '', href: null, protocol: null, rel: null, target: null,
  text: '', internal: false, selector: 'a', ...o,
})
const page = (links, text = '') => ({ url: 'https://ex.com/a', links, text })

test('E3 flags an internal link opening in a new tab', () => {
  const f = E3.check(page([link({ raw: '/about', href: 'https://ex.com/about', internal: true, target: '_blank' })]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'E3')
})

test('E3 flags an external link without target and without noopener', () => {
  const f = E3.check(page([link({ raw: 'https://out.com/x', href: 'https://out.com/x', internal: false })]), {})
  assert.equal(f.length, 1)
})

test('E3 accepts a correct external link', () => {
  const ok = link({ raw: 'https://out.com/x', href: 'https://out.com/x', internal: false, target: '_blank', rel: 'noopener noreferrer' })
  assert.deepEqual(E3.check(page([ok]), {}), [])
})

test('E3 accepts a plain internal link', () => {
  const ok = link({ raw: '/about', href: 'https://ex.com/about', internal: true })
  assert.deepEqual(E3.check(page([ok]), {}), [])
})

test('E5 flags a duplicated country code', () => {
  const f = E5.check(page([link({ raw: 'tel:+1+17189690845', protocol: 'tel:' })]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'E5')
})

test('E5 flags an 11-digit number that repeats the leading 1', () => {
  const f = E5.check(page([link({ raw: 'tel:+117189690845', protocol: 'tel:' })]), {})
  assert.equal(f.length, 1)
})

test('E5 accepts a normal number', () => {
  assert.deepEqual(E5.check(page([link({ raw: 'tel:+17189690845', protocol: 'tel:' })]), {}), [])
})

test('E6 flags mailto with target=_blank', () => {
  const f = E6.check(page([link({ raw: 'mailto:a@b.com', protocol: 'mailto:', target: '_blank' })]), {})
  assert.ok(f.some(x => x.found.includes('_blank')))
})

test('E6 flags an email present in text but never linked', () => {
  const f = E6.check(page([], 'Write to us at hello@opura.com any time'), {})
  assert.ok(f.some(x => x.found === 'hello@opura.com'))
})

test('E6 does not flag an email that is linked', () => {
  const p = page([link({ raw: 'mailto:hello@opura.com', protocol: 'mailto:' })], 'Write to hello@opura.com')
  assert.deepEqual(E6.check(p, {}).filter(x => x.found === 'hello@opura.com'), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/rules/E3-E5-E6.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```js
// plugins/qc/engine/src/rules/static/E3-target-blank.js
import { finding } from '../index.js'

export default {
  id: 'E3',
  title: 'Правила target=_blank для внутренних и внешних ссылок',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const l of page.links || []) {
      if (!l.href) continue
      const blank = (l.target || '').toLowerCase() === '_blank'
      if (l.internal && blank) {
        out.push(finding(this, page, {
          selector: l.selector, found: `внутренняя ссылка с target=_blank: ${l.raw}`,
          expected: 'без target',
        }))
      }
      if (!l.internal && !blank) {
        out.push(finding(this, page, {
          selector: l.selector, found: `внешняя ссылка без target: ${l.raw}`,
          expected: 'target=_blank rel="noopener"',
        }))
      }
      if (!l.internal && blank && !/noopener/i.test(l.rel || '')) {
        out.push(finding(this, page, {
          selector: l.selector, found: `внешняя ссылка без rel=noopener: ${l.raw}`,
          expected: 'rel="noopener"',
        }))
      }
    }
    return out
  },
}
```

```js
// plugins/qc/engine/src/rules/static/E5-duplicate-plus-one.js
import { finding } from '../index.js'
import { digitsOnly } from '../../lib/text.js'

export default {
  id: 'E5',
  title: 'Задвоенный код страны в номере',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const l of page.links || []) {
      if (l.protocol !== 'tel:') continue
      const raw = l.raw || ''
      const d = digitsOnly(raw)
      const doubledPlus = (raw.match(/\+/g) || []).length > 1
      const doubledOne = d.length === 12 && d.startsWith('11')
      if (doubledPlus || doubledOne) {
        out.push(finding(this, page, {
          selector: l.selector,
          found: raw,
          expected: `tel:+${d.replace(/^11/, '1')}`,
        }))
      }
    }
    return out
  },
}
```

```js
// plugins/qc/engine/src/rules/static/E6-mailto-and-bare-contacts.js
import { finding } from '../index.js'

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

export default {
  id: 'E6',
  title: 'mailto в новой вкладке и некликабельные контакты',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    const linked = new Set()

    for (const l of page.links || []) {
      if (l.protocol !== 'mailto:') continue
      linked.add((l.raw || '').replace(/^mailto:/i, '').split('?')[0].toLowerCase())
      if ((l.target || '').toLowerCase() === '_blank') {
        out.push(finding(this, page, {
          selector: l.selector,
          found: `mailto с target=_blank: ${l.raw}`,
          expected: 'без target',
        }))
      }
    }

    for (const m of new Set((page.text || '').match(EMAIL) || [])) {
      if (!linked.has(m.toLowerCase())) {
        out.push(finding(this, page, {
          selector: 'body', found: m, expected: 'обернуть в mailto:',
        }))
      }
    }
    return out
  },
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/rules/E3-E5-E6.test.js`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/rules/static/E3-target-blank.js \
        plugins/qc/engine/src/rules/static/E5-duplicate-plus-one.js \
        plugins/qc/engine/src/rules/static/E6-mailto-and-bare-contacts.js \
        plugins/qc/engine/test/rules/E3-E5-E6.test.js
git commit -m "feat(qc): link-shape rules E3, E5, E6"
```

---

### Task 5: Heading rules (I1, I2, I3)

**Files:**
- Create: `plugins/qc/engine/src/rules/static/I1-h1-count.js`
- Create: `plugins/qc/engine/src/rules/static/I2-heading-hierarchy.js`
- Create: `plugins/qc/engine/src/rules/static/I3-h1-image.js`
- Test: `plugins/qc/engine/test/rules/I1-I2-I3.test.js`

**Interfaces:**
- Consumes: `finding`, `PageDoc.headings`.
- Produces: three rule modules.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/rules/I1-I2-I3.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import I1 from '../../src/rules/static/I1-h1-count.js'
import I2 from '../../src/rules/static/I2-heading-hierarchy.js'
import I3 from '../../src/rules/static/I3-h1-image.js'

const h = (level, text = 'x', imageOnly = false) => ({ level, text, imageOnly, selector: `h${level}` })
const page = (headings) => ({ url: 'https://ex.com/a', headings })

test('I1 flags a missing h1', () => {
  const f = I1.check(page([h(2)]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'H1 не найден')
})

test('I1 flags multiple h1', () => {
  const f = I1.check(page([h(1), h(1)]), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'H1 на странице: 2')
})

test('I1 accepts exactly one h1', () => {
  assert.deepEqual(I1.check(page([h(1), h(2)]), {}), [])
})

test('I2 flags a skipped level', () => {
  const f = I2.check(page([h(1), h(2), h(4)]), {})
  assert.equal(f.length, 1)
  assert.match(f[0].found, /h2 → h4/)
})

test('I2 accepts a clean hierarchy and allows going back up', () => {
  assert.deepEqual(I2.check(page([h(1), h(2), h(3), h(2), h(3)]), {}), [])
})

test('I3 flags an h1 that only contains an image', () => {
  const f = I3.check(page([h(1, '', true)]), {})
  assert.equal(f.length, 1)
})

test('I3 accepts a text h1', () => {
  assert.deepEqual(I3.check(page([h(1, 'Office Cleaning')]), {}), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/rules/I1-I2-I3.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```js
// plugins/qc/engine/src/rules/static/I1-h1-count.js
import { finding } from '../index.js'

export default {
  id: 'I1',
  title: 'Количество H1 на странице',
  severity: 'critical',
  engine: 'static',
  check(page, _site) {
    const h1 = (page.headings || []).filter(h => h.level === 1)
    if (h1.length === 1) return []
    return [finding(this, page, {
      selector: h1[0]?.selector || 'body',
      found: h1.length === 0 ? 'H1 не найден' : `H1 на странице: ${h1.length}`,
      expected: 'ровно один H1',
    })]
  },
}
```

```js
// plugins/qc/engine/src/rules/static/I2-heading-hierarchy.js
import { finding } from '../index.js'

export default {
  id: 'I2',
  title: 'Дыры в иерархии заголовков',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    let prev = null
    for (const h of page.headings || []) {
      if (prev !== null && h.level > prev + 1) {
        out.push(finding(this, page, {
          selector: h.selector,
          found: `пропущен уровень: h${prev} → h${h.level}`,
          expected: `h${prev + 1}`,
        }))
      }
      prev = h.level
    }
    return out
  },
}
```

```js
// plugins/qc/engine/src/rules/static/I3-h1-image.js
import { finding } from '../index.js'

export default {
  id: 'I3',
  title: 'H1 картинкой, а не текстом',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.headings || [])
      .filter(h => h.level === 1 && h.imageOnly)
      .map(h => finding(this, page, {
        selector: h.selector,
        found: 'H1 не содержит текста, только изображение',
        expected: 'текстовый H1',
      }))
  },
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/rules/I1-I2-I3.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/rules/static/I1-h1-count.js \
        plugins/qc/engine/src/rules/static/I2-heading-hierarchy.js \
        plugins/qc/engine/src/rules/static/I3-h1-image.js \
        plugins/qc/engine/test/rules/I1-I2-I3.test.js
git commit -m "feat(qc): heading rules I1, I2, I3"
```

---

### Task 6: Site index and cross-page rules (I5, I6, I7)

**Files:**
- Create: `plugins/qc/engine/src/parse/index.js`
- Create: `plugins/qc/engine/src/rules/static/I5-canonical.js`
- Create: `plugins/qc/engine/src/rules/static/I6-title.js`
- Create: `plugins/qc/engine/src/rules/static/I7-meta-description.js`
- Test: `plugins/qc/engine/test/rules/I5-I6-I7.test.js`

**Interfaces:**
- Consumes: `finding`, `PageDoc`.
- Produces: `buildIndex(pages) -> { titles: Map<string, string[]>, descriptions: Map<string, string[]> }`
  where each value is the list of page URLs sharing that exact string. Assigned to `site.index`.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/rules/I5-I6-I7.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIndex } from '../../src/parse/index.js'
import I5 from '../../src/rules/static/I5-canonical.js'
import I6 from '../../src/rules/static/I6-title.js'
import I7 from '../../src/rules/static/I7-meta-description.js'

const mk = (o) => ({ url: 'https://ex.com/a', title: 'A', metaDescription: 'D', canonical: 'https://ex.com/a', ...o })

test('buildIndex groups pages by identical title and description', () => {
  const idx = buildIndex([
    mk({ url: 'https://ex.com/a', title: 'Same', metaDescription: 'D1' }),
    mk({ url: 'https://ex.com/b', title: 'Same', metaDescription: 'D2' }),
  ])
  assert.deepEqual(idx.titles.get('Same'), ['https://ex.com/a', 'https://ex.com/b'])
  assert.equal(idx.descriptions.get('D1').length, 1)
})

test('I5 flags a missing canonical', () => {
  const f = I5.check(mk({ canonical: null }), {})
  assert.equal(f.length, 1)
})

test('I5 flags a canonical pointing elsewhere', () => {
  const f = I5.check(mk({ canonical: 'https://ex.com/other' }), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].expected, 'https://ex.com/a')
})

test('I5 flags an http canonical on an https page', () => {
  const f = I5.check(mk({ url: 'https://ex.com/a', canonical: 'http://ex.com/a' }), {})
  assert.equal(f.length, 1)
})

test('I5 accepts a self-referencing canonical', () => {
  assert.deepEqual(I5.check(mk({}), {}), [])
})

test('I6 flags an empty title', () => {
  assert.equal(I6.check(mk({ title: null }), {}).length, 1)
})

test('I6 flags a duplicate title across the site', () => {
  const pages = [mk({ url: 'https://ex.com/a', title: 'Same' }), mk({ url: 'https://ex.com/b', title: 'Same' })]
  const site = { index: buildIndex(pages) }
  const f = I6.check(pages[0], site)
  assert.equal(f.length, 1)
  assert.match(f[0].found, /дубль/)
})

test('I6 flags Home in the homepage title', () => {
  const f = I6.check(mk({ url: 'https://ex.com/', title: 'Home | Opura' }), {})
  assert.equal(f.length, 1)
})

test('I6 tolerates a missing site index', () => {
  assert.deepEqual(I6.check(mk({}), {}), [])
})

test('I7 flags an empty description', () => {
  assert.equal(I7.check(mk({ metaDescription: null }), {}).length, 1)
})

test('I7 flags a duplicate description', () => {
  const pages = [mk({ url: 'https://ex.com/a', metaDescription: 'Same' }), mk({ url: 'https://ex.com/b', metaDescription: 'Same' })]
  const site = { index: buildIndex(pages) }
  assert.equal(I7.check(pages[0], site).length, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/rules/I5-I6-I7.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```js
// plugins/qc/engine/src/parse/index.js
function group(pages, pick) {
  const m = new Map()
  for (const p of pages) {
    const v = pick(p)
    if (!v) continue
    if (!m.has(v)) m.set(v, [])
    m.get(v).push(p.url)
  }
  return m
}

export function buildIndex(pages) {
  return {
    titles: group(pages, p => p.title),
    descriptions: group(pages, p => p.metaDescription),
  }
}
```

```js
// plugins/qc/engine/src/rules/static/I5-canonical.js
import { finding } from '../index.js'

export default {
  id: 'I5',
  title: 'Canonical',
  severity: 'critical',
  engine: 'static',
  check(page, _site) {
    if (!page.canonical) {
      return [finding(this, page, {
        selector: 'head', found: 'canonical отсутствует', expected: page.url,
      })]
    }
    if (page.canonical !== page.url) {
      const httpDowngrade = page.url.startsWith('https://') && page.canonical.startsWith('http://')
      return [finding(this, page, {
        selector: 'link[rel=canonical]',
        found: httpDowngrade ? `canonical на http: ${page.canonical}` : page.canonical,
        expected: page.url,
      })]
    }
    return []
  },
}
```

```js
// plugins/qc/engine/src/rules/static/I6-title.js
import { finding } from '../index.js'

export default {
  id: 'I6',
  title: 'Title страницы',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const out = []
    if (!page.title) {
      out.push(finding(this, page, { selector: 'title', found: 'title пустой', expected: 'уникальный title' }))
      return out
    }
    const shared = site?.index?.titles?.get(page.title) || []
    if (shared.length > 1) {
      out.push(finding(this, page, {
        selector: 'title',
        found: `дубль title на ${shared.length} страницах: "${page.title}"`,
        expected: 'уникальный title',
      }))
    }
    let path
    try { path = new URL(page.url).pathname } catch { path = '' }
    if (path === '/' && /\bhome\b/i.test(page.title)) {
      out.push(finding(this, page, {
        selector: 'title', found: page.title, expected: 'title главной без слова «Home»',
      }))
    }
    return out
  },
}
```

```js
// plugins/qc/engine/src/rules/static/I7-meta-description.js
import { finding } from '../index.js'

export default {
  id: 'I7',
  title: 'Meta description',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    if (!page.metaDescription) {
      return [finding(this, page, {
        selector: 'head', found: 'description отсутствует', expected: 'уникальный description',
      })]
    }
    const shared = site?.index?.descriptions?.get(page.metaDescription) || []
    if (shared.length > 1) {
      return [finding(this, page, {
        selector: 'meta[name=description]',
        found: `дубль description на ${shared.length} страницах`,
        expected: 'уникальный description',
      })]
    }
    return []
  },
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/rules/I5-I6-I7.test.js`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/parse/index.js \
        plugins/qc/engine/src/rules/static/I5-canonical.js \
        plugins/qc/engine/src/rules/static/I6-title.js \
        plugins/qc/engine/src/rules/static/I7-meta-description.js \
        plugins/qc/engine/test/rules/I5-I6-I7.test.js
git commit -m "feat(qc): site index and cross-page rules I5, I6, I7"
```

---

### Task 7: Content, accessibility and form rules (H1, H7, J1, G1, G3, G5, S1)

**Files:**
- Create: `plugins/qc/engine/src/rules/static/H1-lorem.js`
- Create: `plugins/qc/engine/src/rules/static/H7-image-alt.js`
- Create: `plugins/qc/engine/src/rules/static/J1-landmarks.js`
- Create: `plugins/qc/engine/src/rules/static/G1-privacy-checkbox.js`
- Create: `plugins/qc/engine/src/rules/static/G3-required-marker.js`
- Create: `plugins/qc/engine/src/rules/static/G5-phone-input-type.js`
- Create: `plugins/qc/engine/src/rules/static/S1-jsonld.js`
- Test: `plugins/qc/engine/test/rules/content-forms.test.js`

**Interfaces:**
- Consumes: `finding`, `PageDoc.{text, images, landmarks, forms, jsonLd}`.
- Produces: seven rule modules.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/rules/content-forms.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import H1 from '../../src/rules/static/H1-lorem.js'
import H7 from '../../src/rules/static/H7-image-alt.js'
import J1 from '../../src/rules/static/J1-landmarks.js'
import G1 from '../../src/rules/static/G1-privacy-checkbox.js'
import G3 from '../../src/rules/static/G3-required-marker.js'
import G5 from '../../src/rules/static/G5-phone-input-type.js'
import S1 from '../../src/rules/static/S1-jsonld.js'

const base = {
  url: 'https://ex.com/a', text: '', images: [], forms: [], jsonLd: [],
  landmarks: { header: 1, main: 1, nav: 1 },
}
const p = (o) => ({ ...base, ...o })

test('H1 flags leftover lorem ipsum', () => {
  const f = H1.check(p({ text: 'Intro Lorem ipsum dolor sit amet more text' }), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('H1 ignores clean copy', () => {
  assert.deepEqual(H1.check(p({ text: 'Office cleaning in New York City' }), {}), [])
})

test('H7 flags an image with no alt attribute', () => {
  const f = H7.check(p({ images: [{ src: 'https://ex.com/i.jpg', alt: null, hasAlt: false, decorative: false, selector: 'img.hero' }] }), {})
  assert.equal(f.length, 1)
})

test('H7 accepts an explicitly decorative image', () => {
  const img = { src: 'https://ex.com/i.jpg', alt: '', hasAlt: true, decorative: true, selector: 'img' }
  assert.deepEqual(H7.check(p({ images: [img] }), {}), [])
})

test('J1 flags a missing header and main', () => {
  const f = J1.check(p({ landmarks: { header: 0, main: 0, nav: 1 } }), {})
  assert.equal(f.length, 2)
})

test('J1 accepts one header and one main', () => {
  assert.deepEqual(J1.check(p({}), {}), [])
})

test('G1 flags a gravity form without a privacy checkbox', () => {
  const f = G1.check(p({ forms: [{ id: 'gform_5', gravity: true, hasPrivacyCheckbox: false, fields: [] }] }), {})
  assert.equal(f.length, 1)
})

test('G1 ignores non-gravity forms', () => {
  assert.deepEqual(G1.check(p({ forms: [{ id: 'search', gravity: false, hasPrivacyCheckbox: false, fields: [] }] }), {}), [])
})

test('G3 flags a required field with no visible marker', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'text', required: true, markedRequired: false, selector: '.gfield-1' },
  ] }
  assert.equal(G3.check(p({ forms: [form] }), {}).length, 1)
})

test('G5 flags a phone field that is not type=tel', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'text', required: false, markedRequired: false, selector: '.gfield--type-phone' },
  ] }
  assert.equal(G5.check(p({ forms: [form] }), {}).length, 1)
})

test('G5 accepts type=tel', () => {
  const form = { id: 'gform_5', gravity: true, hasPrivacyCheckbox: true, fields: [
    { inputType: 'tel', required: false, markedRequired: false, selector: '.gfield--type-phone' },
  ] }
  assert.deepEqual(G5.check(p({ forms: [form] }), {}), [])
})

test('S1 flags unparsable JSON-LD', () => {
  const f = S1.check(p({ jsonLd: [{ ok: false, error: 'Unexpected token', types: [] }] }), {})
  assert.equal(f.length, 1)
})

test('S1 accepts valid JSON-LD', () => {
  assert.deepEqual(S1.check(p({ jsonLd: [{ ok: true, error: null, types: ['LocalBusiness'] }] }), {}), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/rules/content-forms.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```js
// plugins/qc/engine/src/rules/static/H1-lorem.js
import { finding } from '../index.js'

const LOREM = /\b(lorem ipsum|dolor sit amet|consectetur adipiscing)\b/i

export default {
  id: 'H1',
  title: 'Оставшийся Lorem ipsum',
  severity: 'critical',
  engine: 'static',
  check(page, _site) {
    const m = LOREM.exec(page.text || '')
    if (!m) return []
    const at = Math.max(0, m.index - 40)
    return [finding(this, page, {
      selector: 'body',
      found: (page.text || '').slice(at, m.index + 80).trim(),
      expected: 'реальный текст',
    })]
  },
}
```

```js
// plugins/qc/engine/src/rules/static/H7-image-alt.js
import { finding } from '../index.js'

export default {
  id: 'H7',
  title: 'Отсутствует alt у изображения',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.images || [])
      .filter(i => !i.hasAlt && !i.decorative)
      .map(i => finding(this, page, {
        selector: i.selector,
        found: `нет атрибута alt: ${i.src || '(без src)'}`,
        expected: 'осмысленный alt или alt="" для декоративных',
      }))
  },
}
```

```js
// plugins/qc/engine/src/rules/static/J1-landmarks.js
import { finding } from '../index.js'

export default {
  id: 'J1',
  title: 'Семантические лендмарки',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    const l = page.landmarks || { header: 0, main: 0 }
    if (!l.header) {
      out.push(finding(this, page, { selector: 'body', found: 'нет тега <header>', expected: 'шапка в <header>' }))
    }
    if (!l.main) {
      out.push(finding(this, page, { selector: 'body', found: 'нет тега <main>', expected: 'контент в <main>' }))
    }
    return out
  },
}
```

```js
// plugins/qc/engine/src/rules/static/G1-privacy-checkbox.js
import { finding } from '../index.js'

export default {
  id: 'G1',
  title: 'В форме нет чекбокса Privacy Policy',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.forms || [])
      .filter(f => f.gravity && !f.hasPrivacyCheckbox)
      .map(f => finding(this, page, {
        selector: `form#${f.id || '(без id)'}`,
        found: 'нет чекбокса со ссылкой на Privacy Policy',
        expected: 'обязательный чекбокс со ссылкой на политику',
      }))
  },
}
```

```js
// plugins/qc/engine/src/rules/static/G3-required-marker.js
import { finding } from '../index.js'

export default {
  id: 'G3',
  title: 'Обязательное поле без пометки',
  severity: 'minor',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const form of page.forms || []) {
      if (!form.gravity) continue
      for (const f of form.fields || []) {
        if (f.required && !f.markedRequired) {
          out.push(finding(this, page, {
            selector: f.selector, found: 'поле обязательное, но без звёздочки', expected: '* в подписи поля',
          }))
        }
      }
    }
    return out
  },
}
```

```js
// plugins/qc/engine/src/rules/static/G5-phone-input-type.js
import { finding } from '../index.js'

export default {
  id: 'G5',
  title: 'Поле телефона не type=tel',
  severity: 'minor',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const form of page.forms || []) {
      if (!form.gravity) continue
      for (const f of form.fields || []) {
        const isPhone = /phone/i.test(f.selector || '')
        if (isPhone && f.inputType !== 'tel') {
          out.push(finding(this, page, {
            selector: f.selector, found: `type=${f.inputType || '(нет)'}`, expected: 'type="tel"',
          }))
        }
      }
    }
    return out
  },
}
```

```js
// plugins/qc/engine/src/rules/static/S1-jsonld.js
import { finding } from '../index.js'

export default {
  id: 'S1',
  title: 'JSON-LD не парсится',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.jsonLd || [])
      .filter(b => !b.ok)
      .map(b => finding(this, page, {
        selector: 'script[type="application/ld+json"]',
        found: b.error || 'ошибка разбора',
        expected: 'валидный JSON-LD',
      }))
  },
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/rules/content-forms.test.js`
Expected: PASS — 14 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/rules/static/H1-lorem.js \
        plugins/qc/engine/src/rules/static/H7-image-alt.js \
        plugins/qc/engine/src/rules/static/J1-landmarks.js \
        plugins/qc/engine/src/rules/static/G1-privacy-checkbox.js \
        plugins/qc/engine/src/rules/static/G3-required-marker.js \
        plugins/qc/engine/src/rules/static/G5-phone-input-type.js \
        plugins/qc/engine/src/rules/static/S1-jsonld.js \
        plugins/qc/engine/test/rules/content-forms.test.js
git commit -m "feat(qc): content, a11y and Gravity Forms rules"
```

---

### Task 8: Environment detection and environment-dependent rules (I4, I14)

**Files:**
- Create: `plugins/qc/engine/src/lib/env.js`
- Create: `plugins/qc/engine/src/rules/static/I4-noindex.js`
- Create: `plugins/qc/engine/src/rules/static/I14-dev-artifacts.js`
- Test: `plugins/qc/engine/test/lib/env.test.js`
- Test: `plugins/qc/engine/test/rules/I4-I14.test.js`

**Interfaces:**
- Consumes: `hostOf` from Task 1, `finding` from Task 3.
- Produces: `detectEnv({ host, pages, pairedAsDev = false, override = null }) -> { env, reason }`
  where `env` is `'dev' | 'prod' | 'unknown'`. Assigned to `site.env`.

- [ ] **Step 1: Write the failing tests**

```js
// plugins/qc/engine/test/lib/env.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEnv } from '../../src/lib/env.js'

const pages = (n, noindex) => Array.from({ length: n }, (_, i) => ({
  url: `https://h/${i}`, robots: { index: !noindex, follow: true, raw: null },
}))

test('an explicit override wins', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(3), override: 'dev' }).env, 'dev')
})

test('being paired as the dev side wins over the hostname', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(3), pairedAsDev: true }).env, 'dev')
})

test('patest.website is recognised as dev', () => {
  assert.equal(detectEnv({ host: 'starshep-dev.patest.website', pages: pages(3) }).env, 'dev')
})

test('a staging segment is recognised as dev', () => {
  assert.equal(detectEnv({ host: 'staging.ex.com', pages: pages(3) }).env, 'dev')
})

test('mostly-noindex pages read as dev', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(10, true) }).env, 'dev')
})

test('a plain host with indexable pages reads as prod', () => {
  assert.equal(detectEnv({ host: 'cleaningny.com', pages: pages(10) }).env, 'prod')
})

test('no pages yields unknown', () => {
  assert.equal(detectEnv({ host: 'cleaningny.com', pages: [] }).env, 'unknown')
})
```

```js
// plugins/qc/engine/test/rules/I4-I14.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import I4 from '../../src/rules/static/I4-noindex.js'
import I14 from '../../src/rules/static/I14-dev-artifacts.js'

const page = (o = {}) => ({
  url: 'https://ex.com/a',
  robots: { index: true, follow: true, raw: null },
  links: [], images: [], ...o,
})

test('I4 is critical on prod', () => {
  const p = page({ robots: { index: false, follow: true, raw: 'noindex' } })
  const f = I4.check(p, { env: 'prod' })
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('I4 stays silent on dev', () => {
  const p = page({ robots: { index: false, follow: true, raw: 'noindex' } })
  assert.deepEqual(I4.check(p, { env: 'dev' }), [])
})

test('I4 downgrades to a heuristic when the environment is unknown', () => {
  const p = page({ robots: { index: false, follow: true, raw: 'noindex' } })
  const f = I4.check(p, { env: 'unknown' })
  assert.equal(f[0].confidence, 'heuristic')
})

test('I14 flags a dev link on prod', () => {
  const p = page({ links: [{ raw: 'https://x.patest.website/a', href: 'https://x.patest.website/a', selector: 'a.x' }] })
  const f = I14.check(p, { env: 'prod' })
  assert.equal(f.length, 1)
})

test('I14 flags a dev image src on prod', () => {
  const p = page({ images: [{ src: 'https://x-dev.example.com/i.jpg', selector: 'img' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 1)
})

test('I14 stays silent on dev', () => {
  const p = page({ links: [{ raw: 'https://x.patest.website/a', href: 'https://x.patest.website/a', selector: 'a' }] })
  assert.deepEqual(I14.check(p, { env: 'dev' }), [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/qc/engine && node --test test/lib/env.test.js test/rules/I4-I14.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```js
// plugins/qc/engine/src/lib/env.js
const DEV_HOST = /(^|\.)patest\.website$|(^|[-.])(dev|stage|staging|test)([-.]|$)/i

export function detectEnv({ host, pages = [], pairedAsDev = false, override = null }) {
  if (override === 'dev' || override === 'prod') {
    return { env: override, reason: 'задано флагом --env' }
  }
  if (pairedAsDev) {
    return { env: 'dev', reason: 'хост стоит в колонке Dev Link' }
  }
  if (host && DEV_HOST.test(host)) {
    return { env: 'dev', reason: `имя хоста указывает на дев: ${host}` }
  }
  if (pages.length === 0) {
    return { env: 'unknown', reason: 'нет страниц для оценки' }
  }
  const noindex = pages.filter(p => p.robots && p.robots.index === false).length
  if (noindex / pages.length > 0.8) {
    return { env: 'dev', reason: `noindex на ${noindex} из ${pages.length} страниц` }
  }
  return { env: 'prod', reason: 'боевой хост, страницы индексируются' }
}
```

```js
// plugins/qc/engine/src/rules/static/I4-noindex.js
import { finding } from '../index.js'

export default {
  id: 'I4',
  title: 'Страница закрыта от индексации',
  severity: 'critical',
  engine: 'static',
  check(page, site) {
    if (page.robots?.index !== false) return []
    if (site?.env === 'dev') return []
    const unknown = site?.env !== 'prod'
    return [{
      ...finding(this, page, {
        selector: 'meta[name=robots]',
        found: page.robots.raw || 'noindex',
        expected: 'index, follow',
      }),
      severity: unknown ? 'major' : 'critical',
      confidence: unknown ? 'heuristic' : 'high',
    }]
  },
}
```

```js
// plugins/qc/engine/src/rules/static/I14-dev-artifacts.js
import { finding } from '../index.js'

const DEV_URL = /(^|\/\/|\.)(?:[\w-]*(?:-dev|dev)\.)?patest\.website|\/\/[\w-]*-dev\./i

export default {
  id: 'I14',
  title: 'Следы дев-окружения на проде',
  severity: 'critical',
  engine: 'static',
  check(page, site) {
    if (site?.env !== 'prod') return []
    const out = []
    for (const l of page.links || []) {
      if (l.href && DEV_URL.test(l.href)) {
        out.push(finding(this, page, {
          selector: l.selector, found: `ссылка на дев: ${l.href}`, expected: 'боевой домен',
        }))
      }
    }
    for (const i of page.images || []) {
      if (i.src && DEV_URL.test(i.src)) {
        out.push(finding(this, page, {
          selector: i.selector, found: `картинка с дева: ${i.src}`, expected: 'боевой домен',
        }))
      }
    }
    return out
  },
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/lib/env.test.js test/rules/I4-I14.test.js`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/lib/env.js \
        plugins/qc/engine/src/rules/static/I4-noindex.js \
        plugins/qc/engine/src/rules/static/I14-dev-artifacts.js \
        plugins/qc/engine/test/lib/env.test.js \
        plugins/qc/engine/test/rules/I4-I14.test.js
git commit -m "feat(qc): environment detection with rules I4 and I14"
```

---

### Task 9: Polite fetcher

**Files:**
- Create: `plugins/qc/engine/src/crawl/fetch.js`
- Test: `plugins/qc/engine/test/crawl/fetch.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `fetchAll(urls, opts) -> Promise<Map<string, FetchResult>>` and
  `fetchOne(url, opts) -> Promise<FetchResult>`, where
  `FetchResult = { url, finalUrl, status, ok, headers, body, error, redirects }`.
  `opts = { concurrency = 6, timeout = 20000, retries = 2, method = 'GET', onProgress }`.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/crawl/fetch.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fetchAll, fetchOne } from '../../src/crawl/fetch.js'

let server, base
let hits = 0

before(async () => {
  server = createServer((req, res) => {
    hits++
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>ok</h1>') }
    if (req.url === '/missing') { res.writeHead(404); return res.end('nope') }
    if (req.url === '/moved') { res.writeHead(301, { location: '/ok' }); return res.end() }
    if (req.url === '/flaky') {
      if (hits % 2 === 1) { res.writeHead(503); return res.end() }
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>recovered</h1>')
    }
    res.writeHead(200); res.end('x')
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

test('fetchOne returns the body and status', async () => {
  const r = await fetchOne(`${base}/ok`)
  assert.equal(r.status, 200)
  assert.match(r.body, /<h1>ok<\/h1>/)
  assert.equal(r.ok, true)
})

test('fetchOne reports a 404 without throwing', async () => {
  const r = await fetchOne(`${base}/missing`)
  assert.equal(r.status, 404)
  assert.equal(r.ok, false)
})

test('fetchOne follows a redirect and records the final URL', async () => {
  const r = await fetchOne(`${base}/moved`)
  assert.equal(r.status, 200)
  assert.ok(r.finalUrl.endsWith('/ok'))
})

test('fetchOne retries a 503 and succeeds', async () => {
  hits = 0
  const r = await fetchOne(`${base}/flaky`, { retries: 2 })
  assert.equal(r.status, 200)
})

test('fetchAll returns one entry per unique url', async () => {
  const map = await fetchAll([`${base}/ok`, `${base}/missing`, `${base}/ok`], { concurrency: 2 })
  assert.equal(map.size, 2)
  assert.equal(map.get(`${base}/ok`).status, 200)
})

test('fetchAll reports progress', async () => {
  const seen = []
  await fetchAll([`${base}/ok`, `${base}/missing`], { concurrency: 1, onProgress: (d, t) => seen.push([d, t]) })
  assert.equal(seen.at(-1)[0], 2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/crawl/fetch.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/crawl/fetch.js
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 qc-engine'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export async function fetchOne(url, { timeout = 20000, retries = 2, method = 'GET' } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(url, {
        method, redirect: 'follow', signal: ac.signal,
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      })
      const retryable = res.status >= 500 || res.status === 429
      if (retryable && attempt < retries) {
        await sleep(400 * (attempt + 1))
        continue
      }
      const headers = Object.fromEntries(res.headers.entries())
      const body = method === 'HEAD' ? '' : await res.text()
      return {
        url, finalUrl: res.url || url, status: res.status, ok: res.ok,
        headers, body, error: null, redirects: (res.url && res.url !== url) ? 1 : 0,
      }
    } catch (e) {
      lastError = e
      if (attempt < retries) await sleep(400 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    url, finalUrl: url, status: 0, ok: false, headers: {}, body: '',
    error: lastError ? lastError.message : 'unknown error', redirects: 0,
  }
}

export async function fetchAll(urls, opts = {}) {
  const { concurrency = 6, onProgress } = opts
  const queue = [...new Set(urls)]
  const out = new Map()
  let active = Math.max(1, concurrency)
  let done = 0
  const total = queue.length

  async function worker() {
    while (queue.length) {
      const url = queue.shift()
      const res = await fetchOne(url, opts)
      // Back off site-wide the moment the server complains about load.
      if (res.status === 429 || res.status === 503) active = 2
      out.set(url, res)
      done++
      if (onProgress) onProgress(done, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(active, Math.max(total, 1)) }, worker))
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/crawl/fetch.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/crawl/fetch.js plugins/qc/engine/test/crawl/fetch.test.js
git commit -m "feat(qc): polite concurrent fetcher"
```

---

### Task 10: Page discovery (robots, sitemap, crawl fallback)

**Files:**
- Create: `plugins/qc/engine/src/crawl/discover.js`
- Test: `plugins/qc/engine/test/crawl/discover.test.js`

**Interfaces:**
- Consumes: `fetchOne`, `fetchAll` from Task 9; `normalizeUrl`, `sameHost` from Task 1.
- Produces: `discoverPages(siteUrl, opts) -> Promise<{ urls: string[], source: 'sitemap'|'crawl' }>`.
  `opts = { maxPages = 2000, maxDepth = 3, fetchImpl }` — `fetchImpl` exists so tests inject a stub.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/crawl/discover.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverPages } from '../../src/crawl/discover.js'

const res = (body, status = 200) => ({ status, ok: status < 400, body, headers: {}, error: null, finalUrl: '' })

test('reads a sitemap index and its child sitemaps', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('User-agent: *\nSitemap: https://ex.com/sitemap_index.xml'),
    'https://ex.com/sitemap_index.xml': res(
      `<sitemapindex><sitemap><loc>https://ex.com/page-sitemap.xml</loc></sitemap></sitemapindex>`),
    'https://ex.com/page-sitemap.xml': res(
      `<urlset><url><loc>https://ex.com/a</loc></url><url><loc>https://ex.com/b</loc></url></urlset>`),
  }
  const out = await discoverPages('https://ex.com', {
    fetchImpl: async (u) => routes[u] || res('', 404),
  })
  assert.equal(out.source, 'sitemap')
  assert.deepEqual(out.urls.sort(), ['https://ex.com/a', 'https://ex.com/b'])
})

test('falls back to a same-host crawl when no sitemap exists', async () => {
  const routes = {
    'https://ex.com/robots.txt': res('', 404),
    'https://ex.com/sitemap_index.xml': res('', 404),
    'https://ex.com/sitemap.xml': res('', 404),
    'https://ex.com/': res('<a href="/a">A</a><a href="https://out.com/x">out</a>'),
    'https://ex.com/a': res('<a href="/b">B</a>'),
    'https://ex.com/b': res('<a href="/">home</a>'),
  }
  const out = await discoverPages('https://ex.com/', {
    fetchImpl: async (u) => routes[u] || res('', 404),
  })
  assert.equal(out.source, 'crawl')
  assert.ok(out.urls.includes('https://ex.com/a'))
  assert.ok(out.urls.includes('https://ex.com/b'))
  assert.ok(!out.urls.some(u => u.includes('out.com')))
})

test('honours maxPages', async () => {
  const routes = { 'https://ex.com/robots.txt': res('Sitemap: https://ex.com/s.xml'),
    'https://ex.com/s.xml': res(`<urlset>${Array.from({ length: 50 }, (_, i) => `<url><loc>https://ex.com/p${i}</loc></url>`).join('')}</urlset>`) }
  const out = await discoverPages('https://ex.com', { maxPages: 10, fetchImpl: async (u) => routes[u] || res('', 404) })
  assert.equal(out.urls.length, 10)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/crawl/discover.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/crawl/discover.js
import { fetchOne } from './fetch.js'
import { normalizeUrl, sameHost } from '../lib/url.js'

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1])
const isIndex = (xml) => /<sitemapindex/i.test(xml)

async function fromSitemaps(siteUrl, get, maxPages) {
  const robots = await get(new URL('/robots.txt', siteUrl).toString())
  const declared = robots.ok
    ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1])
    : []
  const candidates = declared.length ? declared : [
    new URL('/sitemap_index.xml', siteUrl).toString(),
    new URL('/sitemap.xml', siteUrl).toString(),
  ]

  const seen = new Set()
  const urls = new Set()
  const queue = [...candidates]

  while (queue.length && urls.size < maxPages) {
    const sm = queue.shift()
    if (seen.has(sm)) continue
    seen.add(sm)
    const res = await get(sm)
    if (!res.ok || !/<(urlset|sitemapindex)/i.test(res.body)) continue
    if (isIndex(res.body)) {
      queue.push(...locs(res.body))
    } else {
      for (const loc of locs(res.body)) {
        const n = normalizeUrl(loc)
        if (n && sameHost(n, siteUrl)) urls.add(n)
        if (urls.size >= maxPages) break
      }
    }
  }
  return [...urls]
}

async function byCrawling(siteUrl, get, maxPages, maxDepth) {
  const start = normalizeUrl(siteUrl)
  const seen = new Set([start])
  const out = []
  let frontier = [[start, 0]]

  while (frontier.length && out.length < maxPages) {
    const next = []
    for (const [url, depth] of frontier) {
      if (out.length >= maxPages) break
      const res = await get(url)
      if (!res.ok) continue
      out.push(url)
      if (depth >= maxDepth) continue
      for (const m of res.body.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
        const n = normalizeUrl(m[1], url)
        if (!n || seen.has(n) || !sameHost(n, siteUrl)) continue
        seen.add(n)
        next.push([n, depth + 1])
      }
    }
    frontier = next
  }
  return out
}

export async function discoverPages(siteUrl, { maxPages = 2000, maxDepth = 3, fetchImpl } = {}) {
  const get = fetchImpl || ((u) => fetchOne(u))
  const fromMap = await fromSitemaps(siteUrl, get, maxPages)
  if (fromMap.length) return { urls: fromMap, source: 'sitemap' }
  return { urls: await byCrawling(siteUrl, get, maxPages, maxDepth), source: 'crawl' }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/crawl/discover.test.js`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/crawl/discover.js plugins/qc/engine/test/crawl/discover.test.js
git commit -m "feat(qc): page discovery via sitemap with crawl fallback"
```

---

### Task 11: Minimal XLSX reader and strategy-sheet input

**Files:**
- Create: `plugins/qc/engine/src/crawl/xlsx.js`
- Create: `plugins/qc/engine/src/crawl/sheet.js`
- Test: `plugins/qc/engine/test/crawl/xlsx.test.js`

**Interfaces:**
- Consumes: `fetchOne` from Task 9.
- Produces:
  - `readXlsx(buffer) -> { sheets: [{ name, rows: string[][] }] }`
  - `pickPageList(workbook) -> { sheet, header, rows: [{ pageName, url, devUrl, figma, copyDoc, pageType }] }`
  - `loadStrategySheet(sheetUrl) -> Promise<same as pickPageList>`

- [ ] **Step 1: Write the failing test**

The real strategy workbook is downloaded once into the fixtures directory by the test itself, so the
test works offline after the first run.

```js
// plugins/qc/engine/test/crawl/xlsx.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readXlsx, } from '../../src/crawl/xlsx.js'
import { pickPageList } from '../../src/crawl/sheet.js'

const FIX = new URL('../fixtures/strategy.xlsx', import.meta.url)
const SHEET = 'https://docs.google.com/spreadsheets/d/13MQeTTUR85z6gbp1NPqVi7xJVQBn-bETZ3gTbMJu7Rc/export?format=xlsx'

async function fixture() {
  if (!existsSync(FIX)) {
    mkdirSync(new URL('../fixtures/', import.meta.url), { recursive: true })
    const res = await fetch(SHEET)
    writeFileSync(FIX, Buffer.from(await res.arrayBuffer()))
  }
  return readFileSync(FIX)
}

test('readXlsx lists every worksheet by name', async () => {
  const wb = readXlsx(await fixture())
  const names = wb.sheets.map(s => s.name)
  assert.ok(names.includes('Phase 3 Page Design List'), `got ${names.join(', ')}`)
  assert.ok(names.includes('Phase 1'))
})

test('readXlsx returns rows as strings', async () => {
  const wb = readXlsx(await fixture())
  const s = wb.sheets.find(x => x.name === 'Phase 3 Page Design List')
  assert.ok(s.rows.length > 300)
  assert.ok(s.rows[0].includes('Page Name'))
})

test('pickPageList finds the page sheet and maps columns by meaning', async () => {
  const out = pickPageList(readXlsx(await fixture()))
  assert.equal(out.sheet, 'Phase 3 Page Design List')
  assert.ok(out.rows.length > 300)
  const withDev = out.rows.filter(r => r.devUrl)
  assert.ok(withDev.length > 40, `expected dev links, got ${withDev.length}`)
  assert.match(withDev[0].devUrl, /patest\.website/)
  assert.ok(out.rows.some(r => r.figma && r.figma.includes('figma.com')))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/crawl/xlsx.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```js
// plugins/qc/engine/src/crawl/xlsx.js
// Minimal XLSX reader: ZIP central directory + SpreadsheetML. Enough for Google Sheets exports.
import { inflateRawSync } from 'node:zlib'

function unzip(buf) {
  const files = new Map()
  // End of central directory record.
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    const lhNameLen = buf.readUInt16LE(localOff + 26)
    const lhExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    files.set(name, method === 0 ? raw : inflateRawSync(raw))

    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&')

function sharedStrings(files) {
  const f = files.get('xl/sharedStrings.xml')
  if (!f) return []
  const xml = f.toString('utf8')
  // One <si> may hold several <t> runs; concatenate them.
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decode(t[1])).join(''))
}

const colIndex = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '')
  if (!m) return 0
  return [...m[1]].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1
}

function sheetRows(xml, strings) {
  return [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((rowM) => {
    const cells = []
    for (const c of rowM[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = c[1]
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /t="([^"]+)"/.exec(attrs)?.[1]
      const body = c[2]
      let value = ''
      if (type === 's') {
        const i = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1)
        value = strings[i] ?? ''
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decode(t[1])).join('')
      } else {
        value = decode(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
      }
      cells[colIndex(ref)] = value
    }
    return Array.from(cells, (v) => v ?? '')
  })
}

export function readXlsx(buffer) {
  const files = unzip(Buffer.from(buffer))
  const strings = sharedStrings(files)
  const wbXml = files.get('xl/workbook.xml').toString('utf8')
  const relsXml = files.get('xl/_rels/workbook.xml.rels').toString('utf8')

  const rels = new Map(
    [...relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
      .map(m => [m[1], m[2].replace(/^\/?xl\//, '')])
  )

  const sheets = [...wbXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(([, name, rid]) => {
    const target = rels.get(rid)
    const file = files.get(`xl/${target}`) || files.get(target)
    return { name: decode(name), rows: file ? sheetRows(file.toString('utf8'), strings) : [] }
  })

  return { sheets }
}
```

```js
// plugins/qc/engine/src/crawl/sheet.js
import { readXlsx } from './xlsx.js'
import { fetchOne } from './fetch.js'
import { normalizeUrl } from '../lib/url.js'

// Column headers differ per client, so match on meaning rather than exact text.
const COLUMNS = {
  pageName: [/^page\s*name$/i, /^name$/i],
  url:      [/^url$/i, /live\s*url/i, /^page\s*url$/i],
  devUrl:   [/dev\s*link/i, /dev\s*url/i, /staging/i],
  figma:    [/figma/i],
  copyDoc:  [/copy\s*doc/i, /^copy$/i],
  pageType: [/page\s*type/i, /^type$/i],
}

function mapHeader(header) {
  const out = {}
  header.forEach((cell, i) => {
    const text = String(cell || '').trim()
    if (!text) return
    for (const [key, patterns] of Object.entries(COLUMNS)) {
      if (out[key] === undefined && patterns.some(p => p.test(text))) out[key] = i
    }
  })
  return out
}

const clean = (v) => {
  const s = String(v ?? '').trim()
  return (!s || s.toUpperCase() === 'NA' || s.toUpperCase() === 'NEW PAGE') ? null : s
}

export function pickPageList(workbook) {
  let best = null
  for (const sheet of workbook.sheets) {
    if (!sheet.rows.length) continue
    const header = sheet.rows[0]
    const map = mapHeader(header)
    if (map.url === undefined && map.devUrl === undefined) continue
    const score = Object.keys(map).length * 1000 + sheet.rows.length
    if (!best || score > best.score) best = { sheet, header, map, score }
  }
  if (!best) throw new Error('во вкладках не найден список страниц с колонкой URL или Dev Link')

  const at = (row, key) => (best.map[key] === undefined ? null : clean(row[best.map[key]]))
  const rows = best.sheet.rows.slice(1)
    .map(row => ({
      pageName: at(row, 'pageName'),
      url: normalizeUrl(at(row, 'url') || ''),
      devUrl: normalizeUrl(at(row, 'devUrl') || ''),
      figma: at(row, 'figma'),
      copyDoc: at(row, 'copyDoc'),
      pageType: at(row, 'pageType'),
    }))
    .filter(r => r.url || r.devUrl)

  return { sheet: best.sheet.name, header: best.header, columns: best.map, rows }
}

export async function loadStrategySheet(sheetUrl) {
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(sheetUrl)?.[1]
  if (!id) throw new Error('не похоже на ссылку Google Sheets')
  const res = await fetchOne(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`)
  if (!res.ok) throw new Error(`таблица недоступна: HTTP ${res.status}`)
  // fetchOne returns text; re-fetch as bytes for the binary workbook.
  const bin = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`)
  return pickPageList(readXlsx(Buffer.from(await bin.arrayBuffer())))
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/crawl/xlsx.test.js`
Expected: PASS — 3 tests. Add `test/fixtures/strategy.xlsx` to git so CI runs offline.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/crawl/xlsx.js plugins/qc/engine/src/crawl/sheet.js \
        plugins/qc/engine/test/crawl/xlsx.test.js plugins/qc/engine/test/fixtures/strategy.xlsx
git commit -m "feat(qc): minimal XLSX reader and strategy sheet input"
```

---

### Task 12: Snapshot store

**Files:**
- Create: `plugins/qc/engine/src/crawl/store.js`
- Test: `plugins/qc/engine/test/crawl/store.test.js`

**Interfaces:**
- Consumes: `hostOf` from Task 1.
- Produces: `snapshotDir(host)`, `saveSnapshot(host, { meta, pages, links })`,
  `loadSnapshot(host) -> { meta, pages, links } | null`, `listSnapshots() -> [{ host, pages, ageDays, bytes }]`,
  `clearSnapshot(host) -> boolean`, `clearAll() -> number`, `saveRun(host, findings, reportHtml) -> string`,
  `previousRun(host) -> { findings } | null`.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/crawl/store.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let store, dir

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qc-store-'))
  process.env.QC_CACHE_DIR = dir
  store = await import('../../src/crawl/store.js')
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('saves and reloads a snapshot', () => {
  store.saveSnapshot('ex.com', {
    meta: { host: 'ex.com', env: 'dev' },
    pages: [{ url: 'https://ex.com/a', title: 'A' }],
    links: [{ url: 'https://ex.com/a', status: 200 }],
  })
  const s = store.loadSnapshot('ex.com')
  assert.equal(s.meta.env, 'dev')
  assert.equal(s.pages.length, 1)
  assert.equal(s.pages[0].title, 'A')
})

test('loadSnapshot returns null for an unknown host', () => {
  assert.equal(store.loadSnapshot('nope.com'), null)
})

test('listSnapshots reports the host and page count', () => {
  const list = store.listSnapshots()
  const row = list.find(r => r.host === 'ex.com')
  assert.equal(row.pages, 1)
  assert.equal(typeof row.ageDays, 'number')
})

test('saveRun and previousRun round-trip findings', () => {
  store.saveRun('ex.com', [{ rule: 'E4', page: 'https://ex.com/a' }], '<html></html>')
  const prev = store.previousRun('ex.com')
  assert.equal(prev.findings[0].rule, 'E4')
})

test('clearSnapshot removes the host', () => {
  assert.equal(store.clearSnapshot('ex.com'), true)
  assert.equal(store.loadSnapshot('ex.com'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/crawl/store.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/crawl/store.js
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const root = () => process.env.QC_CACHE_DIR || join(homedir(), '.qc-cache')

export const snapshotDir = (host) => join(root(), host)

const jsonl = (rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const readJsonl = (p) => existsSync(p)
  ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : []

export function saveSnapshot(host, { meta, pages, links = [] }) {
  const dir = snapshotDir(host)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, savedAt: Date.now() }, null, 2))
  writeFileSync(join(dir, 'pages.jsonl'), jsonl(pages))
  writeFileSync(join(dir, 'links.jsonl'), jsonl(links))
  return dir
}

export function loadSnapshot(host) {
  const dir = snapshotDir(host)
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) return null
  return {
    meta: JSON.parse(readFileSync(metaPath, 'utf8')),
    pages: readJsonl(join(dir, 'pages.jsonl')),
    links: readJsonl(join(dir, 'links.jsonl')),
  }
}

function dirBytes(dir) {
  let total = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    total += st.isDirectory() ? dirBytes(p) : st.size
  }
  return total
}

export function listSnapshots() {
  const base = root()
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter(h => existsSync(join(base, h, 'meta.json')))
    .map((host) => {
      const s = loadSnapshot(host)
      return {
        host,
        pages: s.pages.length,
        ageDays: (Date.now() - (s.meta.savedAt || 0)) / 86400000,
        bytes: dirBytes(join(base, host)),
      }
    })
}

export function clearSnapshot(host) {
  const dir = snapshotDir(host)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

export function clearAll() {
  const n = listSnapshots().length
  rmSync(root(), { recursive: true, force: true })
  return n
}

export function saveRun(host, findings, reportHtml) {
  const dir = join(snapshotDir(host), 'runs', String(Date.now()))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(findings, null, 2))
  if (reportHtml) writeFileSync(join(dir, 'report.html'), reportHtml)
  return dir
}

export function previousRun(host) {
  const runs = join(snapshotDir(host), 'runs')
  if (!existsSync(runs)) return null
  const dirs = readdirSync(runs).sort()
  if (!dirs.length) return null
  const p = join(runs, dirs.at(-1), 'findings.json')
  if (!existsSync(p)) return null
  return { findings: JSON.parse(readFileSync(p, 'utf8')) }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/crawl/store.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/crawl/store.js plugins/qc/engine/test/crawl/store.test.js
git commit -m "feat(qc): snapshot store with run history"
```

---

### Task 13: Link checker and rules E1 and I13, plus pagination rule I8

**Files:**
- Create: `plugins/qc/engine/src/crawl/links.js`
- Create: `plugins/qc/engine/src/rules/static/E1-broken-links.js`
- Create: `plugins/qc/engine/src/rules/static/I13-favicon.js`
- Create: `plugins/qc/engine/src/rules/static/I8-pagination.js`
- Test: `plugins/qc/engine/test/rules/E1-I8-I13.test.js`

**Interfaces:**
- Consumes: `fetchAll` from Task 9, `finding` from Task 3.
- Produces: `checkLinks(pages, opts) -> Promise<Map<string, { status, ok, error }>>`.
  The result is attached to `site.linkStatus` before rules run.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/rules/E1-I8-I13.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import E1 from '../../src/rules/static/E1-broken-links.js'
import I8 from '../../src/rules/static/I8-pagination.js'
import I13 from '../../src/rules/static/I13-favicon.js'

const page = (o = {}) => ({
  url: 'https://ex.com/a', links: [], favicons: [],
  robots: { index: true, follow: true, raw: null }, canonical: 'https://ex.com/a', ...o,
})

test('E1 flags an internal link returning 404', () => {
  const p = page({ links: [{ raw: '/gone', href: 'https://ex.com/gone', internal: true, selector: 'a.x' }] })
  const site = { linkStatus: new Map([['https://ex.com/gone', { status: 404, ok: false }]]) }
  const f = E1.check(p, site)
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
})

test('E1 flags a double slash in the path', () => {
  const p = page({ links: [{ raw: '//about', href: 'https://ex.com//about', internal: true, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://ex.com//about', { status: 200, ok: true }]]) }
  assert.ok(E1.check(p, site).some(x => /двойной слэш/.test(x.found)))
})

test('E1 stays silent for healthy links', () => {
  const p = page({ links: [{ raw: '/ok', href: 'https://ex.com/ok', internal: true, selector: 'a' }] })
  const site = { linkStatus: new Map([['https://ex.com/ok', { status: 200, ok: true }]]) }
  assert.deepEqual(E1.check(p, site), [])
})

test('E1 tolerates a missing link status map', () => {
  const p = page({ links: [{ raw: '/ok', href: 'https://ex.com/ok', internal: true, selector: 'a' }] })
  assert.deepEqual(E1.check(p, {}), [])
})

test('I8 flags a paged URL whose canonical points at page one', () => {
  const p = page({ url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/' })
  const f = I8.check(p, {})
  assert.equal(f.length, 1)
})

test('I8 accepts a self-canonical paged URL', () => {
  const p = page({ url: 'https://ex.com/blog/page/2/', canonical: 'https://ex.com/blog/page/2/' })
  assert.deepEqual(I8.check(p, {}), [])
})

test('I8 ignores non-paged URLs', () => {
  assert.deepEqual(I8.check(page(), {}), [])
})

test('I13 flags a missing favicon', () => {
  assert.equal(I13.check(page({ favicons: [] }), {}).length, 1)
})

test('I13 flags a favicon that does not return 200', () => {
  const p = page({ favicons: [{ href: 'https://ex.com/fav.ico', rel: 'icon' }] })
  const site = { linkStatus: new Map([['https://ex.com/fav.ico', { status: 404, ok: false }]]) }
  assert.equal(I13.check(p, site).length, 1)
})

test('I13 accepts a working favicon', () => {
  const p = page({ favicons: [{ href: 'https://ex.com/fav.ico', rel: 'icon' }] })
  const site = { linkStatus: new Map([['https://ex.com/fav.ico', { status: 200, ok: true }]]) }
  assert.deepEqual(I13.check(p, site), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/rules/E1-I8-I13.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```js
// plugins/qc/engine/src/crawl/links.js
import { fetchAll } from './fetch.js'

export async function checkLinks(pages, opts = {}) {
  const targets = new Set()
  for (const p of pages) {
    for (const l of p.links || []) if (l.href) targets.add(l.href)
    for (const f of p.favicons || []) if (f.href) targets.add(f.href)
  }
  // HEAD first; many WordPress hosts answer 405, so retry those with GET.
  const head = await fetchAll([...targets], { ...opts, method: 'HEAD' })
  const needGet = [...head.entries()]
    .filter(([, r]) => r.status === 405 || r.status === 0 || r.status === 403)
    .map(([u]) => u)
  const get = needGet.length ? await fetchAll(needGet, { ...opts, method: 'GET' }) : new Map()

  const out = new Map()
  for (const [url, r] of head) {
    const best = get.get(url) || r
    out.set(url, { status: best.status, ok: best.ok, error: best.error })
  }
  return out
}
```

```js
// plugins/qc/engine/src/rules/static/E1-broken-links.js
import { finding } from '../index.js'

export default {
  id: 'E1',
  title: 'Битые ссылки',
  severity: 'critical',
  engine: 'static',
  check(page, site) {
    const status = site?.linkStatus
    const out = []
    for (const l of page.links || []) {
      if (!l.href) continue
      let path = ''
      try { path = new URL(l.href).pathname } catch { path = '' }
      if (path.includes('//')) {
        out.push(finding(this, page, {
          selector: l.selector, found: `двойной слэш в URL: ${l.href}`, expected: 'корректный путь',
        }))
      }
      if (!status) continue
      const s = status.get(l.href)
      if (!s || s.ok) continue
      if (!l.internal && s.status === 0) continue      // external timeouts are not our bug
      out.push(finding(this, page, {
        selector: l.selector,
        found: `HTTP ${s.status || 'нет ответа'}: ${l.href}`,
        expected: 'рабочая ссылка',
      }))
    }
    return out
  },
}
```

```js
// plugins/qc/engine/src/rules/static/I13-favicon.js
import { finding } from '../index.js'

export default {
  id: 'I13',
  title: 'Favicon',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    const icons = page.favicons || []
    if (!icons.length) {
      return [finding(this, page, { selector: 'head', found: 'favicon не объявлен', expected: '<link rel="icon">' })]
    }
    const status = site?.linkStatus
    if (!status) return []
    const broken = icons.filter(i => i.href && status.get(i.href) && !status.get(i.href).ok)
    return broken.map(i => finding(this, page, {
      selector: 'link[rel=icon]',
      found: `HTTP ${status.get(i.href).status}: ${i.href}`,
      expected: 'favicon отдаёт 200',
    }))
  },
}
```

```js
// plugins/qc/engine/src/rules/static/I8-pagination.js
import { finding } from '../index.js'

const PAGED = /\/page\/(\d+)\/?$|[?&]paged?=(\d+)/i

export default {
  id: 'I8',
  title: 'Пагинация: canonical и индексация',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    if (!PAGED.test(page.url)) return []
    const out = []
    if (page.canonical && page.canonical !== page.url) {
      out.push(finding(this, page, {
        selector: 'link[rel=canonical]',
        found: `canonical страницы пагинации ведёт на ${page.canonical}`,
        expected: page.url,
      }))
    }
    return out
  },
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/rules/E1-I8-I13.test.js`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/crawl/links.js \
        plugins/qc/engine/src/rules/static/E1-broken-links.js \
        plugins/qc/engine/src/rules/static/I13-favicon.js \
        plugins/qc/engine/src/rules/static/I8-pagination.js \
        plugins/qc/engine/test/rules/E1-I8-I13.test.js
git commit -m "feat(qc): link checker with rules E1, I8, I13"
```

---

### Task 14: Findings roll-up and run diff

**Files:**
- Create: `plugins/qc/engine/src/report/json.js`
- Test: `plugins/qc/engine/test/report/json.test.js`

**Interfaces:**
- Consumes: `Finding` from Task 3.
- Produces:
  - `rollUp(findings) -> [{ rule, title, severity, confidence, count, pages: string[], example: Finding }]`
    sorted by severity then descending count.
  - `verdict(findings) -> 'Fail' | 'Needs fixes' | 'Pass'` — ignores `confidence: 'heuristic'`.
  - `diffRuns(current, previous) -> { fixed: [], remaining: [], added: [] }` keyed by
    `rule|page|selector|found`.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/report/json.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollUp, verdict, diffRuns } from '../../src/report/json.js'

const f = (o) => ({
  rule: 'E4', title: 'tel', severity: 'major', engine: 'static', confidence: 'high',
  page: 'https://ex.com/a', selector: 'a', found: 'x', expected: 'y', breakpoint: null, ...o,
})

test('rollUp groups by rule and counts affected pages', () => {
  const r = rollUp([f({ page: 'https://ex.com/a' }), f({ page: 'https://ex.com/b' }), f({ rule: 'I1', severity: 'critical' })])
  assert.equal(r.length, 2)
  assert.equal(r[0].rule, 'I1')          // critical first
  const e4 = r.find(x => x.rule === 'E4')
  assert.equal(e4.count, 2)
  assert.deepEqual(e4.pages, ['https://ex.com/a', 'https://ex.com/b'])
})

test('verdict is Fail when any critical exists', () => {
  assert.equal(verdict([f({ severity: 'critical' })]), 'Fail')
})

test('verdict is Needs fixes when only majors exist', () => {
  assert.equal(verdict([f({ severity: 'major' })]), 'Needs fixes')
})

test('verdict is Pass when only minors exist', () => {
  assert.equal(verdict([f({ severity: 'minor' })]), 'Pass')
})

test('heuristics never change the verdict', () => {
  assert.equal(verdict([f({ severity: 'critical', confidence: 'heuristic' })]), 'Pass')
})

test('diffRuns splits fixed, remaining and added', () => {
  const prev = [f({ found: 'old' }), f({ found: 'both' })]
  const cur = [f({ found: 'both' }), f({ found: 'new' })]
  const d = diffRuns(cur, prev)
  assert.equal(d.fixed.length, 1)
  assert.equal(d.remaining.length, 1)
  assert.equal(d.added.length, 1)
  assert.equal(d.added[0].found, 'new')
})

test('diffRuns treats a missing previous run as all-new', () => {
  const d = diffRuns([f({})], null)
  assert.equal(d.added.length, 1)
  assert.equal(d.fixed.length, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/report/json.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/report/json.js
const ORDER = { critical: 0, major: 1, minor: 2, note: 3 }

export function rollUp(findings) {
  const groups = new Map()
  for (const f of findings) {
    if (!groups.has(f.rule)) {
      groups.set(f.rule, {
        rule: f.rule, title: f.title, severity: f.severity,
        confidence: f.confidence, count: 0, pages: [], example: f,
      })
    }
    const g = groups.get(f.rule)
    g.count++
    if (!g.pages.includes(f.page)) g.pages.push(f.page)
    if (ORDER[f.severity] < ORDER[g.severity]) g.severity = f.severity
  }
  return [...groups.values()].sort((a, b) =>
    (ORDER[a.severity] - ORDER[b.severity]) || (b.count - a.count))
}

export function verdict(findings) {
  const solid = findings.filter(f => f.confidence !== 'heuristic')
  if (solid.some(f => f.severity === 'critical')) return 'Fail'
  if (solid.some(f => f.severity === 'major')) return 'Needs fixes'
  return 'Pass'
}

const key = (f) => [f.rule, f.page, f.selector, f.found].join('|')

export function diffRuns(current, previous) {
  const prev = new Map((previous || []).map(f => [key(f), f]))
  const cur = new Map(current.map(f => [key(f), f]))
  return {
    fixed: [...prev.values()].filter(f => !cur.has(key(f))),
    remaining: [...cur.values()].filter(f => prev.has(key(f))),
    added: [...cur.values()].filter(f => !prev.has(key(f))),
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/report/json.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/report/json.js plugins/qc/engine/test/report/json.test.js
git commit -m "feat(qc): findings roll-up, verdict and run diff"
```

---

### Task 15: HTML report

**Files:**
- Create: `plugins/qc/engine/src/report/html.js`
- Test: `plugins/qc/engine/test/report/html.test.js`

**Interfaces:**
- Consumes: `rollUp`, `verdict`, `diffRuns` from Task 14.
- Produces: `renderReport({ host, env, envReason, pages, findings, diff, snapshotAgeDays, source }) -> string`.
  Output is a complete self-contained HTML document: no external requests, light and dark themes.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/report/html.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../../src/report/html.js'

const findings = [
  { rule: 'E4', title: 'Формат tel:', severity: 'major', engine: 'static', confidence: 'high',
    page: 'https://ex.com/a', selector: 'a.phone', found: 'tel:855-607-8758',
    expected: 'tel:+18556078758', breakpoint: null },
  { rule: 'I1', title: 'Количество H1', severity: 'critical', engine: 'static', confidence: 'high',
    page: 'https://ex.com/b', selector: 'body', found: 'H1 не найден', expected: 'ровно один H1',
    breakpoint: null },
]

const html = renderReport({
  host: 'ex.com', env: 'dev', envReason: 'имя хоста', pages: 12, findings,
  diff: { fixed: [], remaining: [], added: findings }, snapshotAgeDays: 0.2, source: 'sitemap',
})

test('renders a complete document', () => {
  assert.match(html, /<!doctype html>/i)
  assert.match(html, /<\/html>/i)
})

test('shows the verdict', () => {
  assert.match(html, /Fail/)
})

test('groups by rule and shows the count', () => {
  assert.match(html, /E4/)
  assert.match(html, /Формат tel:/)
  assert.match(html, /tel:\+18556078758/)
})

test('escapes user content', () => {
  const evil = renderReport({
    host: 'ex.com', env: 'dev', envReason: '', pages: 1, snapshotAgeDays: 0, source: 'sitemap',
    findings: [{ rule: 'X', title: 'T', severity: 'minor', engine: 'static', confidence: 'high',
      page: 'https://ex.com/a', selector: 's', found: '<script>alert(1)</script>', expected: '',
      breakpoint: null }],
    diff: { fixed: [], remaining: [], added: [] },
  })
  assert.doesNotMatch(evil, /<script>alert\(1\)<\/script>/)
  assert.match(evil, /&lt;script&gt;/)
})

test('makes no external requests', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i)
  assert.doesNotMatch(html, /<link[^>]+href="https?:/i)
})

test('states the environment', () => {
  assert.match(html, /dev/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/report/html.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// plugins/qc/engine/src/report/html.js
import { rollUp, verdict } from './json.js'

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const CHIP = { critical: 'crit', major: 'maj', minor: 'min', note: 'note' }
const LABEL = { critical: 'Critical', major: 'Major', minor: 'Minor', note: 'Note' }

const CSS = `
:root{--bg:#fff;--fg:#12151a;--mut:#5d6672;--line:#e4e7ec;--card:#f7f8fa;
--crit:#c0243a;--maj:#b7621b;--min:#5a6674;--note:#5d6672}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e8eaed;--mut:#9aa3ad;
--line:#242a31;--card:#161a20;--crit:#ff6b81;--maj:#e0954a;--min:#9aa3ad}}
:root[data-theme=dark]{--bg:#0f1216;--fg:#e8eaed;--mut:#9aa3ad;--line:#242a31;--card:#161a20;
--crit:#ff6b81;--maj:#e0954a;--min:#9aa3ad}
:root[data-theme=light]{--bg:#fff;--fg:#12151a;--mut:#5d6672;--line:#e4e7ec;--card:#f7f8fa;
--crit:#c0243a;--maj:#b7621b;--min:#5a6674}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 12px}
.sub{color:var(--mut);font-size:13px;margin-bottom:24px}
.verdict{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:600;
border:1px solid var(--line)}
.v-Fail{color:var(--crit)}.v-Needs{color:var(--maj)}.v-Pass{color:#2e7d4f}
.tiles{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 8px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:96px}
.tile b{display:block;font-size:20px}.tile span{color:var(--mut);font-size:12px}
.rule{border:1px solid var(--line);border-radius:10px;margin:10px 0;background:var(--card)}
.rule>summary{cursor:pointer;padding:12px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.chip{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
padding:2px 8px;border-radius:6px;border:1px solid currentColor}
.chip.crit{color:var(--crit)}.chip.maj{color:var(--maj)}.chip.min{color:var(--min)}.chip.note{color:var(--note)}
.cnt{margin-left:auto;color:var(--mut);font-size:13px}
.body{padding:0 14px 14px;font-size:14px}
.kv{margin:8px 0}.kv code{background:var(--bg);border:1px solid var(--line);
border-radius:5px;padding:1px 6px;font-size:13px;word-break:break-all}
ul.pages{margin:8px 0 0;padding-left:18px;color:var(--mut);font-size:13px}
ul.pages li{word-break:break-all}
.note-box{border-left:3px solid var(--maj);padding:8px 12px;background:var(--card);
border-radius:0 8px 8px 0;font-size:13px;color:var(--mut);margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
.scroll{overflow-x:auto}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
`

export function renderReport({ host, env, envReason, pages, findings, diff, snapshotAgeDays, source }) {
  const groups = rollUp(findings.filter(f => f.confidence !== 'heuristic'))
  const heur = rollUp(findings.filter(f => f.confidence === 'heuristic'))
  const v = verdict(findings)
  const vClass = v === 'Fail' ? 'v-Fail' : v === 'Pass' ? 'v-Pass' : 'v-Needs'
  const by = (s) => findings.filter(f => f.severity === s && f.confidence !== 'heuristic').length

  const renderGroup = (g) => `
  <details class="rule">
    <summary>
      <span class="chip ${CHIP[g.severity]}">${LABEL[g.severity]}</span>
      <b>${esc(g.rule)}</b> · ${esc(g.title)}
      <span class="cnt">${g.pages.length} страниц · ${g.count} находок</span>
    </summary>
    <div class="body">
      <div class="kv">найдено: <code>${esc(g.example.found)}</code></div>
      ${g.example.expected ? `<div class="kv">ожидается: <code>${esc(g.example.expected)}</code></div>` : ''}
      <div class="kv">селектор: <code>${esc(g.example.selector)}</code></div>
      <ul class="pages">${g.pages.slice(0, 200).map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      ${g.pages.length > 200 ? `<p class="kv">…и ещё ${g.pages.length - 200}</p>` : ''}
    </div>
  </details>`

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QC ${esc(host)}</title><style>${CSS}</style></head><body><div class="wrap">
<h1>QC · ${esc(host)}</h1>
<p class="sub">среда: <b>${esc(env)}</b>${envReason ? ` (${esc(envReason)})` : ''} ·
страниц: ${pages} · источник списка: ${esc(source)} ·
снапшот: ${snapshotAgeDays < 1 ? 'свежий' : `${snapshotAgeDays.toFixed(0)} дн.`}</p>
<p><span class="verdict ${vClass}">${v}</span></p>
${snapshotAgeDays > 7 ? `<div class="note-box">Снапшот старше 7 дней — данные могли устареть. Перезапустите с <code>--fresh</code>.</div>` : ''}
<div class="tiles">
  <div class="tile"><b>${by('critical')}</b><span>Critical</span></div>
  <div class="tile"><b>${by('major')}</b><span>Major</span></div>
  <div class="tile"><b>${by('minor')}</b><span>Minor</span></div>
  <div class="tile"><b>${diff?.added?.length ?? 0}</b><span>новых</span></div>
  <div class="tile"><b>${diff?.fixed?.length ?? 0}</b><span>починено</span></div>
</div>
<h2>Находки по правилам</h2>
${groups.length ? groups.map(renderGroup).join('') : '<p class="sub">Нарушений не найдено.</p>'}
${heur.length ? `<h2>Требует взгляда</h2>
<div class="note-box">Эвристики: возможны ложные срабатывания, на вердикт не влияют.</div>
${heur.map(renderGroup).join('')}` : ''}
<h2>Страницы</h2>
<div class="scroll"><table><tr><th>Страница</th><th>Находок</th></tr>
${[...new Set(findings.map(f => f.page))].slice(0, 500).map(p =>
  `<tr><td>${esc(p)}</td><td>${findings.filter(f => f.page === p).length}</td></tr>`).join('')}
</table></div>
</div></body></html>`
}
```

- [ ] **Step 4: Run the tests**

Run: `cd plugins/qc/engine && node --test test/report/html.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/report/html.js plugins/qc/engine/test/report/html.test.js
git commit -m "feat(qc): self-contained HTML report"
```

---

### Task 16: CLI wiring and a real end-to-end run

**Files:**
- Create: `plugins/qc/engine/src/cli.js`
- Test: `plugins/qc/engine/test/cli.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: executable `qc` with subcommands
  `audit <site-url|sheet-url> [flags]`, `cache list`, `cache clear <host>`, `cache clear --all`.
  `audit` writes the run directory and prints a JSON summary to stdout:
  `{ host, env, pages, verdict, counts, runDir, reportPath }`.

- [ ] **Step 1: Write the failing test**

```js
// plugins/qc/engine/test/cli.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
let server, base, cache

const PAGE = (extra = '') => `<!doctype html><html lang="en"><head>
<title>Test page</title><link rel="canonical" href="BASE/a">
</head><body><header>h</header><main><h1>Hello</h1>
<a href="tel:855-607-8758">call</a>${extra}</main></body></html>`

before(async () => {
  cache = mkdtempSync(join(tmpdir(), 'qc-cli-'))
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200); return res.end(`Sitemap: ${base}/sitemap.xml`) }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<urlset><url><loc>${base}/a</loc></url></urlset>`)
    }
    if (req.url === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(PAGE().replaceAll('BASE', base))
    }
    res.writeHead(404); res.end('nope')
  })
  await new Promise(r => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); rmSync(cache, { recursive: true, force: true }) })

test('audit crawls, finds the tel defect and writes a report', async () => {
  const { stdout } = await run('node', ['src/cli.js', 'audit', base, '--env', 'prod'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, QC_CACHE_DIR: cache },
  })
  const out = JSON.parse(stdout)
  assert.equal(out.pages, 1)
  assert.equal(out.env, 'prod')
  assert.ok(out.counts.major >= 1, 'expected the E4 tel finding')
  assert.ok(existsSync(out.reportPath))
})

test('cache list shows the crawled host', async () => {
  const { stdout } = await run('node', ['src/cli.js', 'cache', 'list'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, QC_CACHE_DIR: cache },
  })
  assert.match(stdout, /127\.0\.0\.1/)
})

test('cache clear --all empties the cache', async () => {
  await run('node', ['src/cli.js', 'cache', 'clear', '--all'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, QC_CACHE_DIR: cache },
  })
  const { stdout } = await run('node', ['src/cli.js', 'cache', 'list'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, QC_CACHE_DIR: cache },
  })
  assert.match(stdout, /пусто|\[\]/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/qc/engine && node --test test/cli.test.js`
Expected: FAIL — `Cannot find module src/cli.js`

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
// plugins/qc/engine/src/cli.js
import { hostOf } from './lib/url.js'
import { detectEnv } from './lib/env.js'
import { discoverPages } from './crawl/discover.js'
import { fetchAll } from './crawl/fetch.js'
import { checkLinks } from './crawl/links.js'
import { loadStrategySheet } from './crawl/sheet.js'
import { parsePage } from './parse/page.js'
import { buildIndex } from './parse/index.js'
import { runStaticRules } from './rules/index.js'
import { diffRuns, verdict } from './report/json.js'
import { renderReport } from './report/html.js'
import {
  saveSnapshot, loadSnapshot, listSnapshots, clearSnapshot, clearAll, saveRun, previousRun,
} from './crawl/store.js'
import { join } from 'node:path'

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { flags[name] = next; i++ } else { flags[name] = true }
    } else rest.push(a)
  }
  return { flags, rest }
}

const list = (v) => (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [])

async function resolveTargets(input) {
  if (/docs\.google\.com\/spreadsheets/.test(input)) {
    const sheet = await loadStrategySheet(input)
    const urls = sheet.rows.map(r => r.devUrl || r.url).filter(Boolean)
    const pairs = new Map(sheet.rows.filter(r => r.devUrl && r.url).map(r => [r.devUrl, r.url]))
    return { urls: [...new Set(urls)], source: `sheet:${sheet.sheet}`, pairs, pairedAsDev: pairs.size > 0 }
  }
  const found = await discoverPages(input)
  return { urls: found.urls, source: found.source, pairs: new Map(), pairedAsDev: false }
}

async function audit(input, flags) {
  const concurrency = Number(flags.concurrency || 6)
  const target = await resolveTargets(input)
  if (!target.urls.length) throw new Error('не найдено ни одной страницы')

  const host = hostOf(target.urls[0])
  const fetched = await fetchAll(target.urls, { concurrency })
  const pages = []
  for (const [url, res] of fetched) {
    if (!res.body) continue
    pages.push(parsePage({ url, html: res.body, status: res.status, headers: res.headers }))
  }

  const { env, reason } = detectEnv({
    host, pages, pairedAsDev: target.pairedAsDev, override: typeof flags.env === 'string' ? flags.env : null,
  })

  const linkStatus = await checkLinks(pages, { concurrency })
  const site = { host, env, pages, index: buildIndex(pages), linkStatus }

  const findings = await runStaticRules(pages, site, {
    only: list(flags.only), skip: list(flags.skip),
  })

  const prev = previousRun(host)
  const diff = diffRuns(findings, prev?.findings || null)

  saveSnapshot(host, {
    meta: { host, env, envReason: reason, source: target.source, pageCount: pages.length },
    pages,
    links: [...linkStatus.entries()].map(([url, s]) => ({ url, ...s })),
  })

  const html = renderReport({
    host, env, envReason: reason, pages: pages.length, findings, diff,
    snapshotAgeDays: 0, source: target.source,
  })
  const runDir = saveRun(host, findings, html)

  const counts = { critical: 0, major: 0, minor: 0, note: 0 }
  for (const f of findings) if (f.confidence !== 'heuristic') counts[f.severity]++

  return {
    host, env, envReason: reason, pages: pages.length, source: target.source,
    verdict: verdict(findings), counts,
    diff: { added: diff.added.length, fixed: diff.fixed.length, remaining: diff.remaining.length },
    runDir, reportPath: join(runDir, 'report.html'),
  }
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2))
  const [cmd, ...args] = rest

  if (cmd === 'audit') {
    console.log(JSON.stringify(await audit(args[0], flags), null, 2))
    return
  }
  if (cmd === 'cache') {
    const [sub, who] = args
    if (sub === 'list') {
      const rows = listSnapshots()
      console.log(rows.length ? JSON.stringify(rows, null, 2) : 'пусто')
      return
    }
    if (sub === 'clear') {
      if (flags.all || who === '--all') { console.log(`удалено снапшотов: ${clearAll()}`); return }
      console.log(clearSnapshot(who) ? `удалён: ${who}` : `не найден: ${who}`)
      return
    }
  }
  console.log(`qc audit <site-url|sheet-url> [--env dev|prod] [--only IDs] [--skip IDs] [--concurrency n]
qc cache list
qc cache clear <host> | --all`)
  process.exitCode = 1
}

main().catch((e) => { console.error(e.message); process.exitCode = 1 })
```

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `cd plugins/qc/engine && node --test test/cli.test.js && npm test`
Expected: CLI 3 tests PASS, then the full suite green.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/cli.js plugins/qc/engine/test/cli.test.js
git commit -m "feat(qc): CLI with audit and cache subcommands"
```

---

### Task 17: Claude plugin and skills

**Files:**
- Create: `plugins/qc/.claude-plugin/plugin.json`
- Create: `plugins/qc/skills/qc-site/SKILL.md`
- Create: `plugins/qc/skills/qc-cache/SKILL.md`
- Move: `research/markup-io-resolved-taxonomy.md` → `plugins/qc/references/taxonomy.md`

**Interfaces:**
- Consumes: the `qc` CLI from Task 16.
- Produces: user-invocable `/qc-site` and `/qc-cache`.

- [ ] **Step 1: Verify the CLI runs against a real site**

Run:
```bash
cd plugins/qc/engine && node src/cli.js audit https://cleaningny.com --concurrency 4
```
Expected: JSON summary with `pages` > 10, a verdict, and a `reportPath` that exists.
Open the report and sanity-check that the rule groups read sensibly. Note any rule producing
obvious nonsense — that is calibration input, recorded in Step 4.

- [ ] **Step 2: Write the plugin manifest and skills**

```json
{
  "name": "qc",
  "version": "0.1.0",
  "description": "QC of WordPress + Elementor + Gravity Forms sites: static bucket-1 checks with a rule-grouped report"
}
```

```markdown
---
name: qc-site
description: Run a static QC audit over a whole WordPress/Elementor site and publish a rule-grouped HTML report. Accepts a site URL or a Google Sheets strategy link (uses the Dev Link column when present). Use when the user says "qc site", "qc сайта", "проверь сайт", or gives a site URL plus a strategy spreadsheet.
argument-hint: <site-url|google-sheet-url> [--env dev|prod] [--fresh] [--only IDs] [--skip IDs]
---

# /qc-site — static QC of a whole site

The engine does all the checking. Your job is to run it, read the JSON, and present the result.

## Steps

1. Resolve the engine path: `<plugin-root>/engine`. If `node_modules` is missing there, run
   `npm install --omit=dev` in that directory once.
2. Run the audit, passing through any flags the user gave:

   ```bash
   node <plugin-root>/engine/src/cli.js audit "<input>" [flags]
   ```

   Crawling a few hundred pages takes minutes — run it in the background and report progress.
3. Read the JSON summary from stdout. It has `host`, `env`, `envReason`, `pages`, `source`,
   `verdict`, `counts`, `diff`, `runDir`, `reportPath`.
4. Read `reportPath` and publish it with the Artifact tool (favicon `✅`, title `QC · <host>`).
   Load the `artifact-design` skill first — it is mandatory before authoring or publishing artifact HTML.
5. Summarise in chat: verdict, counts per severity, the top 5 rule groups by affected page count,
   and the run directory. State the detected environment and why — the user needs to know whether
   `noindex` findings were suppressed.

## Rules

- Never re-implement a check yourself. If a rule seems wrong, say so and propose a fix to the
  rule file; do not paper over it in the summary.
- If the input is a Figma link only, tell the user this command needs a site URL — design
  comparison is not part of this version.
- If the sheet's column mapping looks ambiguous (the JSON reports a `source` of `sheet:<name>`
  but a page count far off what the user expects), show the detected sheet and column mapping
  and confirm before continuing.
```

```markdown
---
name: qc-cache
description: Inspect or clear the QC snapshot cache used by /qc-site. Use when the user says "qc cache", "очисти кэш qc", "покажи снапшоты", or wants a fresh crawl.
argument-hint: list | clear <host> | clear --all
---

# /qc-cache — manage QC snapshots

Snapshots live in `$QC_CACHE_DIR` (default `~/.qc-cache/<host>/`).

- `list` → `node <plugin-root>/engine/src/cli.js cache list`
  Present as a table: host, pages, age in days, size. Flag anything older than 7 days.
- `clear <host>` → `node <plugin-root>/engine/src/cli.js cache clear <host>`
- `clear --all` → `node <plugin-root>/engine/src/cli.js cache clear --all`

Clearing deletes crawled HTML and all stored run history for that host, so the next audit loses
its "fixed since last run" comparison. Say this before clearing, and confirm when the user asks
for `--all`.
```

- [ ] **Step 3: Move the taxonomy into the plugin**

```bash
mkdir -p plugins/qc/references
git mv research/markup-io-resolved-taxonomy.md plugins/qc/references/taxonomy.md
rmdir research 2>/dev/null || true
```

- [ ] **Step 4: Record calibration notes**

Append a short "Calibration log" section to `plugins/qc/references/taxonomy.md` listing every rule
that misfired during the Step 1 real run, with the page and what it reported. This is the input for
the next tuning pass — do not silently loosen rules now.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/.claude-plugin/plugin.json plugins/qc/skills plugins/qc/references
git commit -m "feat(qc): claude plugin manifest, qc-site and qc-cache skills"
```

---

## Self-Review

**Spec coverage.** Every spec item is claimed by a task: commands (17), snapshot layout and purge
(12, 17), politeness (9), environment detection (8), discovery including sheet input (10, 11),
static rule catalogue (3–8, 13), report with rule grouping and run diff (14, 15), tests on real
fixtures (2, 11, and every rule task), taxonomy move (17).

Three spec items are deliberately deferred and stated as such in "Границы этой итерации" of the
spec: the browser pass, template proof, and the prod-diff pass. `/qc-page` also moves to the
browser plan, because without browser checks it would only re-run static rules that `/qc-site`
already covers for every page — shipping it now would add a command with no distinct value.
Two rules in the spec's static catalogue (`I8` pagination robots directives beyond canonical, and
raw-HTML gzip storage) are reduced: `I8` checks canonical only, and the snapshot stores parsed
pages rather than gzipped HTML. Both are noted here so the next plan can restore them.

**Placeholder scan.** No "TBD"/"TODO"/"similar to Task N" remain; every code step carries runnable
code and every test step carries real assertions.

**Type consistency.** `PageDoc` property names used by rules in Tasks 3–8 and 13 match the shape
produced in Task 2 (`links[].raw/protocol/internal/selector`, `robots.index`, `headings[].imageOnly`,
`forms[].gravity/hasPrivacyCheckbox/fields[].markedRequired`, `landmarks.header/main`, `favicons[].href`).
`finding()` is defined once in Task 3 and imported everywhere. `site` carries `env` (Task 8),
`index` (Task 6) and `linkStatus` (Task 13); every rule that reads them tolerates their absence,
and that tolerance is asserted by tests in Tasks 6 and 13.
