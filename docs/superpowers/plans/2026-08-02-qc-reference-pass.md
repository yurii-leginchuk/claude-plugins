# QC Reference Pass (bucket 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic comparison of a page against its copy doc and Figma design (rules `H2 A1 A5 A6 A3`), a `qc refs` verb to install references into the snapshot, single-page mode for `audit`/`browse`, agentic findings merge, and the `/qc-page` skill that orchestrates all of it.

**Architecture:** References (`copy.md`, `figma.json`, section renders) are acquired agentically by the skill and installed into the snapshot by `qc refs`. A third rule class in `src/rules/reference/` runs inside `qc audit` off those files plus `styles.jsonl` — computed-style/section facts that `qc browse` captures when references exist. The skill's own visual judgments (A2/A4, GBP) land in `agentic.jsonl`; `qc audit` merges all four sources into one report.

**Tech Stack:** Node 24 ESM, `node-html-parser` + `playwright` (no new dependencies), `node:test` + `node:assert/strict`, local `node:http` fixture servers.

## Global Constraints

- Node ESM only (`"type": "module"`). No TypeScript, no build step.
- Runtime dependencies limited to `node-html-parser` and `playwright`. Everything else uses Node built-ins.
- Tests use `node:test` + `node:assert/strict`. **No test may reach the public internet.**
- Severity values are exactly `critical` | `major` | `minor` | `note`.
- Rule IDs match the taxonomy verbatim: `H2 A1 A5 A6 A3`. `H2` is `high` confidence; all A-rules are `heuristic` until live calibration.
- Every rule `title` is Russian; all user-facing prose (errors, notes, report) is Russian; code and comments are English.
- Findings never carry secrets or full page HTML — a selector plus short `found`/`expected` strings (≤200 chars).
- Snapshot cache lives at `$QC_CACHE_DIR` (default `~/.qc-cache/<host>/`), never inside the repo.
- `npm test` runs bare `node --test` and must keep passing throughout.
- Reference rules read only files (snapshot); the engine makes zero network requests for them.

## Interfaces established by this plan (single source of truth)

```js
// src/lib/url.js (added)
pageSlug(url)                     // '/deep-cleaning/nyc/' -> 'deep-cleaning-nyc', '/' -> 'home'

// src/crawl/store.js (added)
saveReferences(host, pageUrl, { copyMd = null, figma = null, rendersSrcDir = null }) // -> dir
loadReferences(host, pageUrl)     // -> null | { slug, dir, savedAt, pageUrl, copyMd, figma }
listReferencedUrls(host)          // -> string[] of pageUrl values with saved references
appendFactsRow(host, row)         // appends to styles.jsonl; row = { url, width, texts, sections }
latestFactsByUrl(host)            // -> Map<url, row> (last row per url wins)
loadAgenticFindings(host)         // -> { findings: [], skipped: number } from agentic.jsonl

// src/parse/copy.js
parseCopyBlocks(md)               // -> [{ type: 'h1'|'h2'|'h3'|'p'|'li'|'cta'|'faq-q'|'faq-a', text }]

// src/lib/figma-schema.js
validateFigma(obj)                // -> string[] of Russian error messages; [] means valid

// src/rules/reference-index.js
allReferenceRules()               // -> [{ id, title, severity, engine:'reference', confidence, check }]
runReferenceRules(pages, refsByUrl, factsByUrl, { only = [], skip = [], rules = null })
// rule.check(page, refs, facts) -> findings[]
//   page  = PageDoc from parsePage (url, headings, text, ...)
//   refs  = { copyBlocks: []|null, figma: object|null, savedAt, dir }
//   facts = styles.jsonl row for this url, or null

// src/rules/reference/_match.js
normText(s)                       // lowercase, unify typographic chars, strip punct, collapse ws
tokens(s)                         // normText(s).split(' ').filter(Boolean)
diceTokens(a, b)                  // multiset token Dice coefficient, 0..1
lcsPositions(positions)           // indices of the longest strictly-increasing subsequence
markDiff(expTokens, gotTokens)    // { expected, found } excerpts with differing tokens in ⟦⟧
excerpt(s, max = 200)             // trim to max chars with '…'

// src/rules/reference/_color.js
hexToLab(hex)                     // '#rrggbb' -> { L, a, b }
deltaE(hex1, hex2)                // CIE76 distance
DELTA_E_THRESHOLD                 // 10 (calibratable)

// src/browser/facts.js
collectFacts                      // serialisable page-side function -> { texts, sections }

// src/cli.js (added / extended)
refs(pageUrl, flags)              // qc refs verb; prints { host, slug, dir, copy, figma, renders }
audit(input, flags)               // + flags.page, + summary.referenceCoverage, summary.pageMode
browse(input, flags)              // + flags.page; captures facts for referenced urls

// styles.jsonl row
{ url, width, texts: [{ text, fontSize, fontWeight, color }],
  sections: [{ heading, groups: [{ sig, count }] }] }

// agentic.jsonl row: engine finding shape with engine: 'agent'
{ rule: 'A2'|'A4'|'GBP', title, severity, confidence: 'high'|'heuristic', page,
  breakpoint: null, selector: null, found, expected, shot: null|path, refShot: null|path }
```

---

### Task 1: Store — references, facts, agentic findings

**Files:**
- Modify: `plugins/qc/engine/src/lib/url.js`
- Modify: `plugins/qc/engine/src/crawl/store.js`
- Test: `plugins/qc/engine/test/lib/page-slug.test.js`
- Test: `plugins/qc/engine/test/crawl/references.test.js`

**Interfaces:**
- Consumes: existing `snapshotDir(host)`, `sanitizeHost` conventions from store.js.
- Produces: `pageSlug`, `saveReferences`, `loadReferences`, `listReferencedUrls`, `appendFactsRow`, `latestFactsByUrl`, `loadAgenticFindings` — exactly as in the interfaces block above.

- [ ] **Step 1: Write failing tests for `pageSlug`**

```js
// test/lib/page-slug.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { pageSlug } from '../../src/lib/url.js'

test('root path is "home"', () => {
  assert.equal(pageSlug('https://x.com/'), 'home')
  assert.equal(pageSlug('https://x.com'), 'home')
})

test('path segments join with hyphens, lowercased, sanitized', () => {
  assert.equal(pageSlug('https://x.com/Deep-Cleaning/NYC/'), 'deep-cleaning-nyc')
  assert.equal(pageSlug('https://x.com/a/b?utm=1#frag'), 'a-b')
})

test('slug is capped at 80 chars and never empty', () => {
  const long = 'https://x.com/' + 'a'.repeat(200)
  assert.ok(pageSlug(long).length <= 80)
  assert.equal(pageSlug('https://x.com/%%%/'), 'home')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test plugins/qc/engine/test/lib/page-slug.test.js`
Expected: FAIL — `pageSlug` is not exported.

- [ ] **Step 3: Implement `pageSlug` in `src/lib/url.js`**

```js
// A stable directory name for one page's references inside the snapshot.
// Derived from the pathname only -- query/hash never distinguish pages we QC.
export function pageSlug(url) {
  let path = ''
  try { path = new URL(url).pathname } catch { path = String(url || '') }
  const slug = path.toLowerCase()
    .split('/').filter(Boolean).join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'home'
}
```

- [ ] **Step 4: Write failing tests for the store additions**

```js
// test/crawl/references.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  saveReferences, loadReferences, listReferencedUrls,
  appendFactsRow, latestFactsByUrl, loadAgenticFindings, snapshotDir,
} from '../../src/crawl/store.js'

function freshCache() { process.env.QC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'qc-refs-')) }

test('saveReferences + loadReferences round-trip copy and figma', () => {
  freshCache()
  const figma = { source: 'https://figma.com/design/x', sections: [{ order: 1, heading: 'Hero' }] }
  saveReferences('site.test', 'https://site.test/about/', { copyMd: '# Hi\n\nText.', figma })
  const r = loadReferences('site.test', 'https://site.test/about/')
  assert.equal(r.slug, 'about')
  assert.equal(r.copyMd, '# Hi\n\nText.')
  assert.deepEqual(r.figma.sections[0], { order: 1, heading: 'Hero' })
  assert.equal(typeof r.savedAt, 'number')
  assert.deepEqual(listReferencedUrls('site.test'), ['https://site.test/about/'])
})

test('loadReferences returns null when nothing saved', () => {
  freshCache()
  assert.equal(loadReferences('site.test', 'https://site.test/nope/'), null)
})

test('renders directory is copied into the reference dir', () => {
  freshCache()
  const src = mkdtempSync(join(tmpdir(), 'qc-renders-'))
  writeFileSync(join(src, '01-hero.png'), 'png-bytes')
  saveReferences('site.test', 'https://site.test/', {
    figma: { source: 'x', sections: [{ order: 1, heading: 'H', render: 'renders/01-hero.png' }] },
    rendersSrcDir: src,
  })
  const r = loadReferences('site.test', 'https://site.test/')
  assert.equal(readFileSync(join(r.dir, 'renders', '01-hero.png'), 'utf8'), 'png-bytes')
})

test('facts rows: last row per url wins', () => {
  freshCache()
  appendFactsRow('site.test', { url: 'https://site.test/', width: 1440, texts: [], sections: [] })
  appendFactsRow('site.test', { url: 'https://site.test/', width: 1440, texts: [{ text: 'v2' }], sections: [] })
  const m = latestFactsByUrl('site.test')
  assert.equal(m.get('https://site.test/').texts[0].text, 'v2')
})

test('agentic findings: valid rows load, broken rows are skipped and counted', () => {
  freshCache()
  const dir = snapshotDir('site.test'); mkdirSync(dir, { recursive: true })
  const good = { rule: 'A2', title: 'Секция свёрстана иначе', severity: 'major', page: 'https://site.test/' }
  appendFileSync(join(dir, 'agentic.jsonl'),
    JSON.stringify(good) + '\n' + 'not json\n' + JSON.stringify({ rule: 'A4' }) + '\n')
  const { findings, skipped } = loadAgenticFindings('site.test')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].engine, 'agent')
  assert.equal(findings[0].confidence, 'high')
  assert.equal(skipped, 2)
})
```

- [ ] **Step 5: Run to verify failure**

Run: `node --test plugins/qc/engine/test/crawl/references.test.js`
Expected: FAIL — functions not exported.

- [ ] **Step 6: Implement in `src/crawl/store.js`**

Add `cpSync` to the existing `node:fs` import, and `pageSlug` from `../lib/url.js`.

```js
// --- Bucket 3: per-page references, browse-captured facts, agentic findings ---

const refsDir = (host, pageUrl) => join(snapshotDir(host), 'references', pageSlug(pageUrl))

// copyMd / figma may each be null -- a source the skill could not obtain is
// simply absent, and the rules that need it stay silent. rendersSrcDir, when
// given, is copied whole into <refs>/renders/.
export function saveReferences(host, pageUrl, { copyMd = null, figma = null, rendersSrcDir = null }) {
  const dir = refsDir(host, pageUrl)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'refs.json'), JSON.stringify({ pageUrl, savedAt: Date.now() }, null, 2))
  if (copyMd !== null) writeFileSync(join(dir, 'copy.md'), copyMd)
  if (figma !== null) writeFileSync(join(dir, 'figma.json'), JSON.stringify(figma, null, 2))
  if (rendersSrcDir !== null) cpSync(rendersSrcDir, join(dir, 'renders'), { recursive: true })
  return dir
}

export function loadReferences(host, pageUrl) {
  const dir = refsDir(host, pageUrl)
  const metaPath = join(dir, 'refs.json')
  if (!existsSync(metaPath)) return null
  let meta
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { return null }
  let figma = null
  if (existsSync(join(dir, 'figma.json'))) {
    try { figma = JSON.parse(readFileSync(join(dir, 'figma.json'), 'utf8')) } catch { figma = null }
  }
  const copyPath = join(dir, 'copy.md')
  const copyMd = existsSync(copyPath) ? readFileSync(copyPath, 'utf8') : null
  return { slug: pageSlug(pageUrl), dir, savedAt: meta.savedAt ?? 0, pageUrl: meta.pageUrl, copyMd, figma }
}

export function listReferencedUrls(host) {
  const base = join(snapshotDir(host), 'references')
  if (!existsSync(base)) return []
  const urls = []
  for (const slug of readdirSync(base)) {
    const p = join(base, slug, 'refs.json')
    if (!existsSync(p)) continue
    try {
      const meta = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof meta.pageUrl === 'string') urls.push(meta.pageUrl)
    } catch { /* a broken refs.json is simply not listed */ }
  }
  return urls.sort()
}

// styles.jsonl mirrors browser.jsonl's append-only + latest-row-wins contract.
export function appendFactsRow(host, row) {
  const dir = snapshotDir(host)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, 'styles.jsonl'), JSON.stringify(row) + '\n')
}

export function latestFactsByUrl(host) {
  const p = join(snapshotDir(host), 'styles.jsonl')
  const byUrl = new Map()
  if (!existsSync(p)) return byUrl
  for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line)
      if (row && typeof row.url === 'string') byUrl.set(row.url, row)
    } catch { /* a torn tail line from an interrupted append is not data */ }
  }
  return byUrl
}

const SEVERITIES = ['critical', 'major', 'minor', 'note']

// agentic.jsonl is written by the /qc-page skill, i.e. by a model -- every
// row is validated and a broken one is skipped and COUNTED, never fatal.
export function loadAgenticFindings(host) {
  const p = join(snapshotDir(host), 'agentic.jsonl')
  if (!existsSync(p)) return { findings: [], skipped: 0 }
  const findings = []
  let skipped = 0
  for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    let row
    try { row = JSON.parse(line) } catch { skipped++; continue }
    const ok = row && typeof row.rule === 'string' && row.rule.trim()
      && typeof row.title === 'string' && row.title.trim()
      && SEVERITIES.includes(row.severity)
      && typeof row.page === 'string' && row.page.trim()
      && (row.confidence === undefined || ['high', 'heuristic'].includes(row.confidence))
    if (!ok) { skipped++; continue }
    findings.push({
      breakpoint: null, selector: null, found: null, expected: null,
      ...row, engine: 'agent', confidence: row.confidence ?? 'high',
    })
  }
  return { findings, skipped }
}
```

- [ ] **Step 7: Run both test files, then the full suite**

Run: `node --test plugins/qc/engine/test/lib/page-slug.test.js plugins/qc/engine/test/crawl/references.test.js` → PASS.
Run: `cd plugins/qc/engine && npm test` → all pass.

- [ ] **Step 8: Commit**

```bash
git add plugins/qc/engine/src/lib/url.js plugins/qc/engine/src/crawl/store.js \
  plugins/qc/engine/test/lib/page-slug.test.js plugins/qc/engine/test/crawl/references.test.js
git commit -m "feat(qc): snapshot stores per-page references, facts rows, agentic findings"
```

---

### Task 2: Copy-doc normalizer

**Files:**
- Create: `plugins/qc/engine/src/parse/copy.js`
- Create: `plugins/qc/engine/test/fixtures/copy-export.md`
- Test: `plugins/qc/engine/test/parse/copy.test.js`

**Interfaces:**
- Produces: `parseCopyBlocks(md) -> [{ type, text }]`, types exactly `h1|h2|h3|p|li|cta|faq-q|faq-a`.

- [ ] **Step 1: Create the fixture** — a realistic Google Doc md export shape (Google escapes punctuation with backslashes and uses `**bold**` button labels):

```markdown
# Deep Cleaning Services in NYC

Our team has cleaned over 2,000 homes\. We bring everything needed\.

**Get a Free Quote**

## Why Choose Us

- Licensed and insured
- Same\-day booking

## FAQ

### How much does deep cleaning cost?

Prices start at $199 for a one\-bedroom apartment\.

### Do I need to be home?

No, many clients provide a key or door code\.
```

Save as `test/fixtures/copy-export.md`.

- [ ] **Step 2: Write the failing test**

```js
// test/parse/copy.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCopyBlocks } from '../../src/parse/copy.js'

const here = dirname(fileURLToPath(import.meta.url))
const md = readFileSync(join(here, '..', 'fixtures', 'copy-export.md'), 'utf8')

test('google-doc export parses into typed ordered blocks', () => {
  const blocks = parseCopyBlocks(md)
  assert.deepEqual(blocks[0], { type: 'h1', text: 'Deep Cleaning Services in NYC' })
  assert.equal(blocks[1].type, 'p')
  assert.equal(blocks[1].text, 'Our team has cleaned over 2,000 homes. We bring everything needed.')
  assert.deepEqual(blocks[2], { type: 'cta', text: 'Get a Free Quote' })
  assert.deepEqual(blocks[3], { type: 'h2', text: 'Why Choose Us' })
  assert.deepEqual(blocks[4], { type: 'li', text: 'Licensed and insured' })
  assert.deepEqual(blocks[5], { type: 'li', text: 'Same-day booking' })
})

test('headings after a FAQ heading become faq-q, their paragraphs faq-a', () => {
  const blocks = parseCopyBlocks(md)
  const q = blocks.find(b => b.type === 'faq-q')
  assert.equal(q.text, 'How much does deep cleaning cost?')
  const a = blocks[blocks.indexOf(q) + 1]
  assert.equal(a.type, 'faq-a')
  assert.match(a.text, /^Prices start at \$199/)
})

test('inline markdown is stripped, wrapped lines join into one paragraph', () => {
  const blocks = parseCopyBlocks('Some *emphasised* [link text](https://x.com) here\ncontinued line.')
  assert.deepEqual(blocks, [{ type: 'p', text: 'Some emphasised link text here continued line.' }])
})

test('empty and whitespace-only input gives no blocks', () => {
  assert.deepEqual(parseCopyBlocks(''), [])
  assert.deepEqual(parseCopyBlocks('\n\n  \n'), [])
})
```

- [ ] **Step 3: Run to verify failure** — `node --test plugins/qc/engine/test/parse/copy.test.js` → FAIL (module not found).

- [ ] **Step 4: Implement `src/parse/copy.js`**

```js
// Normalizes a Google Doc markdown export into ordered typed blocks. The doc
// is the canonical text source (H2 rule); this parser is deliberately a
// subset -- headings, paragraphs, list items, bold-only CTA lines, and a FAQ
// zone -- because that is all a copy doc structurally contains.

// Google's md export escapes punctuation (\. \- \+ \! \?); real markdown
// emphasis/link syntax is stripped down to its text.
function stripInline(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // images -> nothing
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      // links -> label
    .replace(/(\*\*|__|\*|_|`)/g, '')             // emphasis markers
    .replace(/\\([.!?+\-#()[\]*_`])/g, '$1')      // export escapes
    .replace(/\s+/g, ' ')
    .trim()
}

const isCta = (line) => {
  const m = /^\*\*([^*]+)\*\*$/.exec(line.trim())
  return m && m[1].trim().split(/\s+/).length <= 6 ? m[1].trim() : null
}

export function parseCopyBlocks(md) {
  const out = []
  const lines = String(md || '').split(/\r?\n/)
  let para = []
  let faqLevel = 0 // heading level of the FAQ heading; 0 = not inside FAQ

  const flushPara = () => {
    if (!para.length) return
    const text = stripInline(para.join(' '))
    para = []
    if (text) out.push({ type: faqLevel ? 'faq-a' : 'p', text })
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      const level = h[1].length
      const text = stripInline(h[2])
      if (!text) continue
      if (faqLevel && level <= faqLevel) faqLevel = 0
      if (/\bfaq\b|frequently asked/i.test(text)) {
        faqLevel = level
        out.push({ type: `h${Math.min(level, 3)}`, text })
      } else if (faqLevel && level > faqLevel) {
        out.push({ type: 'faq-q', text })
      } else {
        out.push({ type: `h${Math.min(level, 3)}`, text })
      }
      continue
    }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      const text = stripInline(li[1])
      if (text) out.push({ type: 'li', text })
      continue
    }
    if (!line.trim()) { flushPara(); continue }
    const cta = isCta(line)
    if (cta) { flushPara(); out.push({ type: 'cta', text: stripInline(cta) }); continue }
    para.push(line.trim())
  }
  flushPara()
  return out
}
```

- [ ] **Step 5: Run tests** — the copy test file → PASS; then `npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/qc/engine/src/parse/copy.js plugins/qc/engine/test/parse/copy.test.js \
  plugins/qc/engine/test/fixtures/copy-export.md
git commit -m "feat(qc): copy-doc markdown normalizer for the reference pass"
```

---

### Task 3: figma.json schema validator

**Files:**
- Create: `plugins/qc/engine/src/lib/figma-schema.js`
- Test: `plugins/qc/engine/test/lib/figma-schema.test.js`

**Interfaces:**
- Produces: `validateFigma(obj) -> string[]` (Russian messages; empty array = valid).

- [ ] **Step 1: Write the failing test**

```js
// test/lib/figma-schema.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateFigma } from '../../src/lib/figma-schema.js'

const valid = {
  source: 'https://figma.com/design/abc', frame: 'Home 1440',
  sections: [{
    order: 1, name: 'Hero', heading: 'Deep Cleaning',
    texts: [{ text: 'Deep Cleaning', fontSize: 60, fontWeight: 700, color: '#1A2B3C' }],
    repeating: { itemName: 'card', count: 4 }, render: 'renders/01-hero.png',
  }],
}

test('a fully-populated object validates clean', () => {
  assert.deepEqual(validateFigma(valid), [])
})

test('minimal object: only source + sections with order and heading', () => {
  assert.deepEqual(validateFigma({ source: 'x', sections: [{ order: 1, heading: 'H' }] }), [])
})

test('each violation is named: missing source, empty sections, bad section fields', () => {
  const errs = validateFigma({ sections: [] })
  assert.ok(errs.some(e => /source/.test(e)))
  assert.ok(errs.some(e => /sections/.test(e)))
  const errs2 = validateFigma({ source: 'x', sections: [{ order: 'first', heading: '' }] })
  assert.ok(errs2.some(e => /order/.test(e)))
  assert.ok(errs2.some(e => /heading/.test(e)))
})

test('optional blocks are validated when present', () => {
  const errs = validateFigma({ source: 'x', sections: [{
    order: 1, heading: 'H',
    texts: [{ text: '', fontSize: 'big' }],
    repeating: { itemName: 'card', count: 0 },
    color: undefined,
  }] })
  assert.ok(errs.some(e => /texts\[0\]\.text/.test(e)))
  assert.ok(errs.some(e => /fontSize/.test(e)))
  assert.ok(errs.some(e => /repeating\.count/.test(e)))
})

test('bad color format is a violation', () => {
  const errs = validateFigma({ source: 'x', sections: [{
    order: 1, heading: 'H', texts: [{ text: 'ok', color: 'red' }],
  }] })
  assert.ok(errs.some(e => /color/.test(e)))
})
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement `src/lib/figma-schema.js`**

```js
// Validates the figma.json the /qc-page skill assembles from Figma MCP data.
// Rules read only what is present, so everything beyond source + sections
// (order, heading) is optional -- but anything present must be well-formed,
// because a malformed value would otherwise silently disable a rule.
const HEX = /^#[0-9a-fA-F]{6}$/

export function validateFigma(obj) {
  const errs = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['figma.json должен быть JSON-объектом']
  }
  if (typeof obj.source !== 'string' || !obj.source.trim()) {
    errs.push('source: обязательная непустая строка (URL макета)')
  }
  if (!Array.isArray(obj.sections) || !obj.sections.length) {
    errs.push('sections: обязательный непустой массив секций')
    return errs
  }
  obj.sections.forEach((s, i) => {
    const at = `sections[${i}]`
    if (!s || typeof s !== 'object') { errs.push(`${at}: должна быть объектом`); return }
    if (typeof s.order !== 'number' || !Number.isFinite(s.order)) errs.push(`${at}.order: обязательное число`)
    if (typeof s.heading !== 'string' || !s.heading.trim()) errs.push(`${at}.heading: обязательная непустая строка`)
    if (s.name !== undefined && typeof s.name !== 'string') errs.push(`${at}.name: строка`)
    if (s.render !== undefined && (typeof s.render !== 'string' || !s.render.trim())) {
      errs.push(`${at}.render: непустая строка-путь`)
    }
    if (s.texts !== undefined) {
      if (!Array.isArray(s.texts)) errs.push(`${at}.texts: массив`)
      else s.texts.forEach((t, j) => {
        const ta = `${at}.texts[${j}]`
        if (!t || typeof t !== 'object') { errs.push(`${ta}: объект`); return }
        if (typeof t.text !== 'string' || !t.text.trim()) errs.push(`${ta}.text: обязательная непустая строка`)
        if (t.fontSize !== undefined && (typeof t.fontSize !== 'number' || t.fontSize <= 0)) {
          errs.push(`${ta}.fontSize: положительное число (px)`)
        }
        if (t.fontWeight !== undefined && (typeof t.fontWeight !== 'number' || t.fontWeight < 1)) {
          errs.push(`${ta}.fontWeight: число (100–1000)`)
        }
        if (t.color !== undefined && !HEX.test(String(t.color))) {
          errs.push(`${ta}.color: hex-цвет вида #RRGGBB`)
        }
      })
    }
    if (s.repeating !== undefined) {
      const r = s.repeating
      if (!r || typeof r !== 'object') errs.push(`${at}.repeating: объект { itemName, count }`)
      else {
        if (typeof r.itemName !== 'string' || !r.itemName.trim()) errs.push(`${at}.repeating.itemName: непустая строка`)
        if (!Number.isInteger(r.count) || r.count < 1) errs.push(`${at}.repeating.count: целое число ≥ 1`)
      }
    }
  })
  return errs
}
```

- [ ] **Step 4: Run tests** — schema test → PASS; `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/lib/figma-schema.js plugins/qc/engine/test/lib/figma-schema.test.js
git commit -m "feat(qc): figma.json schema validation for qc refs"
```

---

### Task 4: `qc refs` CLI verb

**Files:**
- Modify: `plugins/qc/engine/src/cli.js`
- Test: `plugins/qc/engine/test/cli-refs.test.js`

**Interfaces:**
- Consumes: `saveReferences`/`loadReferences` (Task 1), `validateFigma` (Task 3), existing `hostOf`, `requireStringFlag`, `parseArgs`.
- Produces: `export async function refs(pageUrl, flags)` returning `{ host, slug, dir, copy: boolean, figma: boolean, renders: number }`; `main()` dispatches `qc refs`; USAGE gains the line `qc refs <page-url> --copy <файл> --figma <файл> [--renders <дир>]`.

- [ ] **Step 1: Write the failing test**

```js
// test/cli-refs.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { refs } from '../src/cli.js'
import { loadReferences } from '../src/crawl/store.js'

function setup() {
  process.env.QC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'qc-cli-refs-'))
  const work = mkdtempSync(join(tmpdir(), 'qc-refs-src-'))
  writeFileSync(join(work, 'copy.md'), '# H1\n\nText.')
  writeFileSync(join(work, 'figma.json'), JSON.stringify({
    source: 'https://figma.com/design/x',
    sections: [{ order: 1, heading: 'H1', render: 'renders/01.png' }],
  }))
  mkdirSync(join(work, 'renders'))
  writeFileSync(join(work, 'renders', '01.png'), 'png')
  return work
}

test('refs installs copy + figma + renders and reports what it saved', async () => {
  const work = setup()
  const out = await refs('https://site.test/about/', {
    copy: join(work, 'copy.md'), figma: join(work, 'figma.json'), renders: join(work, 'renders'),
  })
  assert.equal(out.host, 'site.test')
  assert.equal(out.slug, 'about')
  assert.deepEqual([out.copy, out.figma, out.renders], [true, true, 1])
  const r = loadReferences('site.test', 'https://site.test/about/')
  assert.equal(r.figma.sections[0].heading, 'H1')
})

test('invalid figma.json is rejected with the schema violations listed', async () => {
  const work = setup()
  writeFileSync(join(work, 'figma.json'), JSON.stringify({ sections: [] }))
  await assert.rejects(
    () => refs('https://site.test/', { figma: join(work, 'figma.json') }),
    /source|sections/,
  )
})

test('a render referenced by figma.json but missing from --renders is rejected', async () => {
  const work = setup()
  await assert.rejects(
    () => refs('https://site.test/', { figma: join(work, 'figma.json') }),
    /render/i,
  )
})

test('at least one of --copy/--figma is required; empty copy.md is rejected', async () => {
  const work = setup()
  await assert.rejects(() => refs('https://site.test/', {}), /--copy.*--figma|--figma.*--copy/)
  writeFileSync(join(work, 'copy.md'), '   \n')
  await assert.rejects(() => refs('https://site.test/', { copy: join(work, 'copy.md') }), /пуст/i)
})
```

- [ ] **Step 2: Run to verify failure** — `refs` is not exported.

- [ ] **Step 3: Implement `refs()` in `src/cli.js`** (import `saveReferences`, `pageSlug`, `validateFigma`; `existsSync`/`readFileSync` are already imported or extend the import):

```js
// `qc refs` installs the reference files the /qc-page skill acquired (copy
// doc export, figma.json it assembled, section renders) into the snapshot.
// It VALIDATES on the way in -- a malformed figma.json is rejected here with
// the violations listed, so the агент can rebuild it, rather than silently
// disabling reference rules later.
export async function refs(pageUrl, flags) {
  const host = hostOf(pageUrl)
  if (!host) throw new Error(`не удалось разобрать URL страницы: ${pageUrl}`)

  const copyPath = requireStringFlag(flags, 'copy', '--copy')
  const figmaPath = requireStringFlag(flags, 'figma', '--figma')
  const rendersDir = requireStringFlag(flags, 'renders', '--renders')
  if (copyPath === null && figmaPath === null) {
    throw new Error('укажите хотя бы один источник: --copy <файл> и/или --figma <файл>')
  }

  let copyMd = null
  if (copyPath !== null) {
    copyMd = readFileSync(copyPath, 'utf8')
    if (!copyMd.trim()) throw new Error(`копи-док пуст: ${copyPath}`)
  }

  let figma = null
  if (figmaPath !== null) {
    let parsed
    try { parsed = JSON.parse(readFileSync(figmaPath, 'utf8')) } catch (e) {
      throw new Error(`figma.json не разбирается как JSON: ${e.message}`)
    }
    const errs = validateFigma(parsed)
    if (errs.length) throw new Error(`figma.json не прошёл валидацию:\n- ${errs.join('\n- ')}`)
    // Every render the sections reference must actually exist in --renders --
    // a dangling path would silently strip the Figma/page pair from the report.
    for (const s of parsed.sections) {
      if (!s.render) continue
      const rel = s.render.replace(/^renders\//, '')
      if (rendersDir === null || !existsSync(join(rendersDir, rel))) {
        throw new Error(`render не найден: ${s.render} (секция «${s.heading}») — передайте --renders с файлом ${rel}`)
      }
    }
    figma = parsed
  }

  const dir = saveReferences(host, pageUrl, { copyMd, figma, rendersSrcDir: figma && rendersDir !== null ? rendersDir : null })
  const renders = figma ? figma.sections.filter(s => s.render).length : 0
  return { host, slug: pageSlug(pageUrl), dir, copy: copyMd !== null, figma: figma !== null, renders }
}
```

In `main()`, before the final USAGE fallback:

```js
    if (cmd === 'refs') {
      const summary = await refs(args[0], flags)
      console.log(JSON.stringify(summary, null, 2))
      return
    }
```

And add to `USAGE`:

```
qc refs <page-url> --copy <файл> --figma <файл> [--renders <дир>]
```

- [ ] **Step 4: Run tests** — `node --test plugins/qc/engine/test/cli-refs.test.js` → PASS; `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/cli.js plugins/qc/engine/test/cli-refs.test.js
git commit -m "feat(qc): qc refs installs validated page references into the snapshot"
```

---

### Task 5: Reference rule registry, matching helpers, and H2 end to end

**Files:**
- Create: `plugins/qc/engine/src/rules/reference-index.js`
- Create: `plugins/qc/engine/src/rules/reference/_match.js`
- Create: `plugins/qc/engine/src/rules/reference/H2-copy-text.js`
- Test: `plugins/qc/engine/test/rules/reference-match.test.js`
- Test: `plugins/qc/engine/test/rules/H2.test.js`

**Interfaces:**
- Consumes: `parseCopyBlocks` (Task 2), `loadReferences` shape (Task 1), PageDoc shape from `parsePage` (`page.url`, `page.headings[{level,text}]`, `page.text`), `finding()` shape conventions.
- Produces: `allReferenceRules()`, `runReferenceRules(pages, refsByUrl, factsByUrl, { only, skip, rules })`; `_match.js` exports `normText, tokens, diceTokens, lcsPositions, markDiff, excerpt`; rule module shape `default { id, title, severity, engine: 'reference', confidence, check(page, refs, facts) }` where `refs = { copyBlocks, figma, savedAt, dir }`.

- [ ] **Step 1: Write failing tests for `_match.js`**

```js
// test/rules/reference-match.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normText, tokens, diceTokens, lcsPositions, markDiff, excerpt } from '../../src/rules/reference/_match.js'

test('normText unifies case, typographic chars, punctuation, whitespace', () => {
  assert.equal(normText('  «Deep — Cleaning»,  NYC!  '), 'deep cleaning nyc')
  assert.equal(normText('Same-Day Booking'), 'same day booking')
})

test('diceTokens: identical 1, disjoint 0, half-overlap in between', () => {
  assert.equal(diceTokens(tokens('a b c'), tokens('a b c')), 1)
  assert.equal(diceTokens(tokens('a b'), tokens('c d')), 0)
  const mid = diceTokens(tokens('deep cleaning services'), tokens('deep cleaning offers'))
  assert.ok(mid > 0.5 && mid < 1)
})

test('lcsPositions keeps the longest strictly-increasing run', () => {
  // matched page positions per block: block 2 appears before block 1 on the page
  assert.deepEqual(lcsPositions([10, 5, 20, 30]), [1, 2, 3])
})

test('markDiff wraps differing tokens in ⟦⟧ on both sides', () => {
  const d = markDiff(tokens('we clean every corner'), tokens('we wash every corner'))
  assert.match(d.expected, /⟦clean⟧/)
  assert.match(d.found, /⟦wash⟧/)
})

test('excerpt trims with ellipsis', () => {
  assert.equal(excerpt('a'.repeat(300), 10).length, 11) // 10 chars + '…'
})
```

- [ ] **Step 2: Run to verify failure**, then implement `_match.js`:

```js
// Shared text matching for reference rules. Pure functions, no I/O.

// Unify the characters a CMS or Figma render changes freely (quotes, dashes,
// nbsp), then strip everything that is not a letter/digit/space -- word
// identity, not formatting, is what H2/A1 compare.
export function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[«»„“”"’‘']/g, ' ')
    .replace(/[—–‑-]/g, ' ')
    .replace(/ /g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const tokens = (s) => normText(s).split(' ').filter(Boolean)

// Multiset Dice over tokens: 2*|common| / (|a| + |b|).
export function diceTokens(a, b) {
  if (!a.length && !b.length) return 1
  if (!a.length || !b.length) return 0
  const counts = new Map()
  for (const t of a) counts.set(t, (counts.get(t) || 0) + 1)
  let common = 0
  for (const t of b) {
    const c = counts.get(t) || 0
    if (c > 0) { common++; counts.set(t, c - 1) }
  }
  return (2 * common) / (a.length + b.length)
}

// Indices of elements forming the longest strictly-increasing subsequence.
// O(n^2) is fine: n = number of copy blocks on ONE page.
export function lcsPositions(positions) {
  const n = positions.length
  const len = Array(n).fill(1)
  const prev = Array(n).fill(-1)
  let best = 0
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (positions[j] < positions[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j }
    }
    if (len[i] > len[best]) best = i
  }
  const out = []
  for (let i = best; i !== -1; i = prev[i]) out.unshift(i)
  return out
}

// Token-level LCS diff; tokens outside the LCS are wrapped in ⟦⟧.
export function markDiff(expTokens, gotTokens) {
  const n = expTokens.length, m = gotTokens.length
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = expTokens[i] === gotTokens[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const inLcsExp = Array(n).fill(false), inLcsGot = Array(m).fill(false)
  let i = 0, j = 0
  while (i < n && j < m) {
    if (expTokens[i] === gotTokens[j]) { inLcsExp[i] = true; inLcsGot[j] = true; i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  const mark = (ts, flags) => ts.map((t, k) => (flags[k] ? t : `⟦${t}⟧`)).join(' ')
  return { expected: excerpt(mark(expTokens, inLcsExp)), found: excerpt(mark(gotTokens, inLcsGot)) }
}

export const excerpt = (s, max = 200) => (s.length <= max ? s : s.slice(0, max) + '…')
```

Run the match tests → PASS.

- [ ] **Step 3: Write failing tests for the registry + H2** (fixture pages built with the real `parsePage`):

```js
// test/rules/H2.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePage } from '../../src/parse/page.js'
import { allReferenceRules, runReferenceRules } from '../../src/rules/reference-index.js'
import { parseCopyBlocks } from '../../src/parse/copy.js'

const COPY = `# Deep Cleaning in NYC

We clean every corner of your home with care.

## Why Choose Us

Licensed and insured teams arrive on time.
`

const page = (body) => parsePage({ url: 'https://site.test/', html: `<html><body>${body}</body></html>` })

const run = (body, copyMd = COPY) => runReferenceRules(
  [page(body)],
  new Map([['https://site.test/', { copyBlocks: parseCopyBlocks(copyMd), figma: null, savedAt: 1, dir: '/x' }]]),
  new Map(),
)

test('registry loads H2 with the reference engine tag', async () => {
  const rules = await allReferenceRules()
  const h2 = rules.find(r => r.id === 'H2')
  assert.equal(h2.engine, 'reference')
  assert.equal(h2.confidence, 'high')
  assert.equal(h2.severity, 'major')
})

test('clean page: every copy block present in order -> no findings', async () => {
  const found = await run(`
    <h1>Deep Cleaning in NYC</h1>
    <p>We clean every corner of your home with care.</p>
    <h2>Why Choose Us</h2>
    <p>Licensed and insured teams arrive on time.</p>`)
  assert.deepEqual(found, [])
})

test('changed wording -> H2 finding with word diff in found/expected', async () => {
  const found = await run(`
    <h1>Deep Cleaning in NYC</h1>
    <p>We wash every corner of your home with care.</p>
    <h2>Why Choose Us</h2>
    <p>Licensed and insured teams arrive on time.</p>`)
  assert.equal(found.length, 1)
  assert.equal(found[0].rule, 'H2')
  assert.match(found[0].expected, /⟦clean⟧/)
  assert.match(found[0].found, /⟦wash⟧/)
})

test('missing paragraph -> H2 finding naming the absent block', async () => {
  const found = await run(`
    <h1>Deep Cleaning in NYC</h1>
    <h2>Why Choose Us</h2>
    <p>Licensed and insured teams arrive on time.</p>`)
  assert.equal(found.length, 1)
  assert.match(found[0].found, /блок не найден/i)
  assert.match(found[0].expected, /every corner/)
})

test('blocks present but reordered -> order finding', async () => {
  const found = await run(`
    <h2>Why Choose Us</h2>
    <p>Licensed and insured teams arrive on time.</p>
    <h1>Deep Cleaning in NYC</h1>
    <p>We clean every corner of your home with care.</p>`)
  assert.ok(found.some(f => /порядок/i.test(f.found)))
})

test('extra page text (menu, footer) is never flagged', async () => {
  const found = await run(`
    <nav>Home About Contact Blog Pricing</nav>
    <h1>Deep Cleaning in NYC</h1>
    <p>We clean every corner of your home with care.</p>
    <h2>Why Choose Us</h2>
    <p>Licensed and insured teams arrive on time.</p>
    <footer>All rights reserved 2026</footer>`)
  assert.deepEqual(found, [])
})

test('runReferenceRules: only/skip filter which rules execute', async () => {
  const missing = `<p>nothing relevant</p>`
  const withSkip = await runReferenceRules(
    [page(missing)],
    new Map([['https://site.test/', { copyBlocks: parseCopyBlocks(COPY), figma: null, savedAt: 1, dir: '/x' }]]),
    new Map(),
    { skip: ['H2'] },
  )
  assert.deepEqual(withSkip, [])
})

test('a crashing rule yields a note finding, not a crash', async () => {
  const bad = { id: 'ZZ', title: 'x', severity: 'major', engine: 'reference', confidence: 'high',
    check() { throw new Error('boom') } }
  const out = await runReferenceRules(
    [page('<p>x</p>')],
    new Map([['https://site.test/', { copyBlocks: [], figma: null, savedAt: 1, dir: '/x' }]]),
    new Map(),
    { rules: [bad] },
  )
  assert.equal(out[0].severity, 'note')
  assert.match(out[0].found, /rule crashed: boom/)
})
```

- [ ] **Step 4: Run to verify failure**, then implement `src/rules/reference-index.js`:

```js
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseCopyBlocks } from '../parse/copy.js'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, 'reference')

let cache = null

export async function allReferenceRules() {
  if (cache) return cache
  const files = readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort()
  const mods = await Promise.all(files.map(f => import(pathToFileURL(join(dir, f)).href)))
  cache = mods.map(m => m.default)
  return cache
}

// Runs reference rules for every page that HAS references. `refsByUrl` maps
// url -> the loadReferences() shape (copyMd already replaced by copyBlocks
// here, or raw -- see below); `factsByUrl` maps url -> the styles.jsonl row.
// A page without references is skipped entirely: no refs, no findings, by
// design -- "референсы не заданы" is a coverage-header statement, not noise.
export async function runReferenceRules(pages, refsByUrl, factsByUrl, { only = [], skip = [], rules = null } = {}) {
  const ruleSet = rules !== null ? rules : await allReferenceRules()
  const filtered = ruleSet.filter(r =>
    (only.length === 0 || only.includes(r.id)) && !skip.includes(r.id))
  const out = []
  for (const page of pages) {
    const raw = refsByUrl.get(page.url)
    if (!raw) continue
    const refs = {
      copyBlocks: raw.copyBlocks ?? (raw.copyMd ? parseCopyBlocks(raw.copyMd) : null),
      figma: raw.figma ?? null,
      savedAt: raw.savedAt ?? 0,
      dir: raw.dir ?? null,
    }
    const facts = factsByUrl.get(page.url) ?? null
    for (const rule of filtered) {
      try {
        out.push(...(rule.check(page, refs, facts) || []))
      } catch (e) {
        out.push({
          rule: rule.id, title: rule.title, severity: 'note', engine: 'reference',
          confidence: 'high', page: page.url, breakpoint: null, selector: null,
          found: `rule crashed: ${e.message}`, expected: null,
        })
      }
    }
  }
  return out
}
```

- [ ] **Step 5: Implement `src/rules/reference/H2-copy-text.js`**

```js
import { normText, tokens, diceTokens, lcsPositions, markDiff, excerpt } from './_match.js'

const rule = {
  id: 'H2',
  title: 'Текст не совпадает с копирайт-доком',
  severity: 'major',
  engine: 'reference',
  confidence: 'high',
}

const HEADING_TYPES = new Set(['h1', 'h2', 'h3', 'faq-q'])
// Prose blocks shorter than this many tokens are too generic to match
// reliably ("Learn more" appears in every nav) -- skipped, not flagged.
const MIN_PROSE_TOKENS = 3
const CHANGED_THRESHOLD = 0.6   // best-window Dice at/above this = "changed text", below = "missing"
const HEADING_THRESHOLD = 0.5

const mk = (page, props) => ({
  rule: rule.id, title: rule.title, severity: rule.severity, engine: rule.engine,
  confidence: rule.confidence, page: page.url, breakpoint: null, selector: null,
  found: null, expected: null, ...props,
})

// Best contiguous token window of `blockTokens.length` tokens in pageTokens.
function bestWindow(blockTokens, pageTokens) {
  const w = blockTokens.length
  let best = { score: 0, at: -1 }
  for (let i = 0; i + w <= pageTokens.length; i++) {
    const score = diceTokens(blockTokens, pageTokens.slice(i, i + w))
    if (score > best.score) best = { score, at: i }
  }
  return best
}

function check(page, refs) {
  if (!refs.copyBlocks || !refs.copyBlocks.length) return []
  const out = []
  const pageNorm = normText(page.text)
  const pageTokens = pageNorm.split(' ').filter(Boolean)
  const pageHeadings = page.headings.map(h => normText(h.text))

  // For every copy block: exact match (position recorded), fuzzy match
  // (changed-text finding + position), or no match (missing-block finding).
  const matched = [] // { blockIndex, position }
  refs.copyBlocks.forEach((block, blockIndex) => {
    const bTokens = tokens(block.text)
    if (HEADING_TYPES.has(block.type)) {
      const bNorm = normText(block.text)
      const exact = pageHeadings.indexOf(bNorm)
      if (exact !== -1) { matched.push({ blockIndex, position: pageNorm.indexOf(bNorm) }); return }
      let best = { score: 0, at: -1 }
      pageHeadings.forEach((h, i) => {
        const score = diceTokens(bTokens, h.split(' ').filter(Boolean))
        if (score > best.score) best = { score, at: i }
      })
      if (best.score >= HEADING_THRESHOLD) {
        const d = markDiff(bTokens, tokens(page.headings[best.at].text))
        out.push(mk(page, {
          selector: page.headings[best.at].selector,
          found: d.found, expected: d.expected,
        }))
        matched.push({ blockIndex, position: pageNorm.indexOf(normText(page.headings[best.at].text)) })
      } else {
        out.push(mk(page, { found: 'блок не найден на странице', expected: excerpt(block.text) }))
      }
      return
    }
    if (bTokens.length < MIN_PROSE_TOKENS) return
    const bNorm = bTokens.join(' ')
    const at = pageNorm.indexOf(bNorm)
    if (at !== -1) { matched.push({ blockIndex, position: at }); return }
    const best = bestWindow(bTokens, pageTokens)
    if (best.score >= CHANGED_THRESHOLD) {
      const d = markDiff(bTokens, pageTokens.slice(best.at, best.at + bTokens.length))
      out.push(mk(page, { found: d.found, expected: d.expected }))
      matched.push({ blockIndex, position: best.at })
    } else {
      out.push(mk(page, { found: 'блок не найден на странице', expected: excerpt(block.text) }))
    }
  })

  // Order: blocks that matched but fall outside the longest increasing run
  // of page positions are out of order relative to the doc.
  const inOrder = new Set(lcsPositions(matched.map(m => m.position)))
  matched.forEach((m, i) => {
    if (inOrder.has(i)) return
    const block = refs.copyBlocks[m.blockIndex]
    out.push(mk(page, {
      found: 'порядок блоков не совпадает с копи-доком',
      expected: excerpt(block.text, 120),
    }))
  })
  return out
}

export default { ...rule, check }
```

- [ ] **Step 6: Run tests** — `node --test plugins/qc/engine/test/rules/H2.test.js` → PASS; `npm test` → all pass. If the reorder test double-reports (order finding per displaced block), that is the designed behavior — one finding per out-of-order block; adjust the test's expectation to `>= 1`, never the rule, unless the count is wrong.

- [ ] **Step 7: Commit**

```bash
git add plugins/qc/engine/src/rules/reference-index.js plugins/qc/engine/src/rules/reference/ \
  plugins/qc/engine/test/rules/reference-match.test.js plugins/qc/engine/test/rules/H2.test.js
git commit -m "feat(qc): reference rule registry and H2 copy-text comparison"
```

---

### Task 6: A1 — sections against Figma

**Files:**
- Create: `plugins/qc/engine/src/rules/reference/A1-sections.js`
- Test: `plugins/qc/engine/test/rules/A1.test.js`

**Interfaces:**
- Consumes: `_match.js` helpers, rule module shape and `runReferenceRules` from Task 5; `refs.figma.sections[{ order, heading }]`; `page.headings[{ level, text, selector }]`.
- Produces: rule `A1`, title `'Секция отсутствует, лишняя или не на своём месте'`, severity `major`, confidence `heuristic`.

- [ ] **Step 1: Write the failing test**

```js
// test/rules/A1.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePage } from '../../src/parse/page.js'
import { runReferenceRules } from '../../src/rules/reference-index.js'

const figma = { source: 'x', sections: [
  { order: 1, heading: 'Deep Cleaning in NYC' },
  { order: 2, heading: 'Why Choose Us' },
  { order: 3, heading: 'Frequently Asked Questions' },
] }

const page = (body) => parsePage({ url: 'https://site.test/', html: `<html><body>${body}</body></html>` })
const run = (body, f = figma) => runReferenceRules(
  [page(body)],
  new Map([['https://site.test/', { copyBlocks: null, figma: f, savedAt: 1, dir: '/x' }]]),
  new Map(),
  { only: ['A1'] },
)

test('all sections present in order -> no findings', async () => {
  const found = await run(`
    <h1>Deep Cleaning in NYC</h1>
    <h2>Why Choose Us</h2>
    <h2>Frequently Asked Questions</h2>`)
  assert.deepEqual(found, [])
})

test('missing figma section -> A1 finding naming it', async () => {
  const found = await run(`<h1>Deep Cleaning in NYC</h1><h2>Frequently Asked Questions</h2>`)
  assert.equal(found.length, 1)
  assert.equal(found[0].rule, 'A1')
  assert.equal(found[0].confidence, 'heuristic')
  assert.match(found[0].expected, /Why Choose Us/)
  assert.match(found[0].found, /отсутствует/i)
})

test('extra page h2 not in figma -> A1 finding', async () => {
  const found = await run(`
    <h1>Deep Cleaning in NYC</h1>
    <h2>Why Choose Us</h2>
    <h2>Our Amazing Blog Posts</h2>
    <h2>Frequently Asked Questions</h2>`)
  assert.equal(found.length, 1)
  assert.match(found[0].found, /лишняя/i)
  assert.match(found[0].found, /Our Amazing Blog Posts/)
})

test('sections present but swapped -> order finding', async () => {
  const found = await run(`
    <h1>Deep Cleaning in NYC</h1>
    <h2>Frequently Asked Questions</h2>
    <h2>Why Choose Us</h2>`)
  assert.equal(found.length, 1)
  assert.match(found[0].found, /порядок/i)
})

test('near-identical heading counts as matched, not missing', async () => {
  const found = await run(`
    <h1>Deep Cleaning in NYC</h1>
    <h2>Why You Should Choose Us</h2>
    <h2>Frequently Asked Questions</h2>`)
  assert.deepEqual(found, [])
})
```

- [ ] **Step 2: Run to verify failure**, then implement `A1-sections.js`:

```js
import { normText, tokens, diceTokens, lcsPositions, excerpt } from './_match.js'

const rule = {
  id: 'A1',
  title: 'Секция отсутствует, лишняя или не на своём месте',
  severity: 'major',
  engine: 'reference',
  confidence: 'heuristic',
}

// Heading-match threshold: "Why Choose Us" vs "Why You Should Choose Us"
// must match; "Why Choose Us" vs "Our Blog" must not. Calibrated live later.
const MATCH_THRESHOLD = 0.6

const mk = (page, props) => ({
  rule: rule.id, title: rule.title, severity: rule.severity, engine: rule.engine,
  confidence: rule.confidence, page: page.url, breakpoint: null, selector: null,
  found: null, expected: null, ...props,
})

function check(page, refs) {
  if (!refs.figma || !Array.isArray(refs.figma.sections) || !refs.figma.sections.length) return []
  const out = []
  const sections = [...refs.figma.sections].sort((a, b) => a.order - b.order)
  const candidates = page.headings
    .map((h, i) => ({ ...h, pageIndex: i, norm: tokens(h.text) }))
    .filter(h => h.level <= 3 && h.norm.length)

  const usedPageIdx = new Set()
  const matchedPositions = [] // page heading index per matched figma section, in figma order
  const matchedSections = []
  for (const s of sections) {
    const sTokens = tokens(s.heading)
    let best = { score: 0, cand: null }
    for (const c of candidates) {
      if (usedPageIdx.has(c.pageIndex)) continue
      const score = normText(s.heading) === normText(c.text) ? 1 : diceTokens(sTokens, c.norm)
      if (score > best.score) best = { score, cand: c }
    }
    if (best.score >= MATCH_THRESHOLD) {
      usedPageIdx.add(best.cand.pageIndex)
      matchedPositions.push(best.cand.pageIndex)
      matchedSections.push(s)
    } else {
      out.push(mk(page, {
        found: 'секция из макета отсутствует на странице',
        expected: excerpt(s.heading, 120),
      }))
    }
  }

  // Extra: an h2 on the page no figma section claimed. Only h2 -- h1 is the
  // page title, h3 is sub-structure; both would drown the signal.
  for (const c of candidates) {
    if (c.level !== 2 || usedPageIdx.has(c.pageIndex)) continue
    out.push(mk(page, {
      selector: c.selector,
      found: `лишняя секция, которой нет в макете: «${excerpt(c.text, 100)}»`,
      expected: 'секция присутствует в figma.json',
    }))
  }

  // Order: matched sections whose page positions break the longest
  // increasing run are out of order relative to the macket.
  const inOrder = new Set(lcsPositions(matchedPositions))
  matchedSections.forEach((s, i) => {
    if (inOrder.has(i)) return
    out.push(mk(page, {
      found: 'порядок секций не совпадает с макетом',
      expected: excerpt(s.heading, 120),
    }))
  })
  return out
}

export default { ...rule, check }
```

- [ ] **Step 3: Run tests** — A1 tests → PASS; `npm test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/qc/engine/src/rules/reference/A1-sections.js plugins/qc/engine/test/rules/A1.test.js
git commit -m "feat(qc): A1 compares page sections against figma.json"
```

---

### Task 7: browse captures facts (styles + section groups) for referenced pages

**Files:**
- Create: `plugins/qc/engine/src/browser/facts.js`
- Modify: `plugins/qc/engine/src/browser/run.js`
- Modify: `plugins/qc/engine/src/cli.js` (browse: compute `factsFor`, extend `--force`)
- Modify: `plugins/qc/engine/src/crawl/store.js` (clearBrowserResults also removes `styles.jsonl`)
- Create: `plugins/qc/engine/test/browser/fixtures/facts.html`
- Test: `plugins/qc/engine/test/browser/facts.test.js`

**Interfaces:**
- Consumes: `launchBrowser`/`preparePage` from `src/browser/launch.js`, `appendFactsRow`/`latestFactsByUrl` (Task 1), existing `runBrowserPass({ host, pages, widths, opts })` (read `src/browser/run.js` fully before editing — respect its retry/checkpoint structure).
- Produces: `collectFacts` (exported page-side function, serialised with `.toString()`, self-contained by the same contract as browser rules); `runBrowserPass` honours `opts.factsFor` (a `Set<string>` of urls): after a url's widths all measured successfully, re-prepare at `Math.max(...widths)` and append `{ url, width, texts, sections }` via `appendFactsRow`; a url already present in `latestFactsByUrl` is not re-captured. `browse()` builds `factsFor` from `listReferencedUrls(host)`.

- [ ] **Step 1: Create the fixture** `test/browser/fixtures/facts.html`:

```html
<!doctype html><html><head><style>
  h1 { font-size: 60px; font-weight: 700; color: #1a2b3c; }
  .card { display: block; }
</style></head><body>
  <h1>Deep Cleaning in NYC</h1>
  <p style="font-size:18px;color:#333333">We clean every corner of your home with care.</p>
  <section>
    <h2>Our Services</h2>
    <div class="grid">
      <div class="card">Card one content here</div>
      <div class="card">Card two content here</div>
      <div class="card">Card three content here</div>
    </div>
  </section>
</body></html>
```

- [ ] **Step 2: Write the failing test** (reuse the existing local-server harness `test/browser/harness.js` — read it first and follow its idiom for serving fixtures and launching):

```js
// test/browser/facts.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectFacts } from '../../src/browser/facts.js'
// Use harness.js exactly the way C1.test.js does -- serve fixtures/facts.html,
// launch, preparePage at width 1440, then:
//   const facts = await page.evaluate(`(${collectFacts.toString()})()`)

test('collectFacts returns text styles and section repeat groups', async () => {
  const facts = /* evaluate as above */ null
  const h1 = facts.texts.find(t => t.text === 'deep cleaning in nyc')
  assert.equal(h1.fontSize, 60)
  assert.equal(h1.fontWeight, 700)
  assert.equal(h1.color, '#1a2b3c')
  const services = facts.sections.find(s => s.heading === 'our services')
  assert.ok(services.groups.some(g => g.sig === 'div.card' && g.count === 3))
})
```

Fill in the harness wiring per its actual API (it exists and is documented in `test/browser/harness.js`; the C1 test is the reference usage).

- [ ] **Step 3: Run to verify failure**, then implement `src/browser/facts.js`:

```js
// Runs inside the page (serialised with toString(), same contract as browser
// rules: self-contained, ES5-compatible, no imports). Collects the rendered
// facts reference rules need: computed styles of text nodes (A6/A3) and
// repeat-group counts per heading section (A5).
export function collectFacts() {
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim() }
  function hex(rgb) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb))
    if (!m) return null
    function h(n) { return ('0' + Number(n).toString(16)).slice(-2) }
    return '#' + h(m[1]) + h(m[2]) + h(m[3])
  }
  var texts = []
  var seen = {}
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode() && texts.length < 500) {
    var t = norm(walker.currentNode.textContent)
    if (t.length < 8 || seen[t]) continue
    var el = walker.currentNode.parentElement
    if (!el) continue
    var cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    seen[t] = 1
    texts.push({
      text: t,
      fontSize: Math.round(parseFloat(cs.fontSize)),
      fontWeight: Number(cs.fontWeight) || null,
      color: hex(cs.color),
    })
  }
  var sections = []
  var hs = document.querySelectorAll('h1, h2, h3')
  for (var i = 0; i < hs.length; i++) {
    var heading = norm(hs[i].textContent)
    if (!heading) continue
    var container = hs[i].closest('section, .elementor-section, .e-con') || hs[i].parentElement
    if (!container) continue
    // Count identical (tag + first classes) siblings under a shared parent --
    // the DOM shape of a card grid -- inside this heading's container.
    var counts = {}
    var els = container.querySelectorAll('*')
    for (var j = 0; j < els.length; j++) {
      var cls = (els[j].getAttribute('class') || '').split(/\s+/).filter(Boolean).sort().slice(0, 2).join('.')
      if (!cls) continue
      var p = els[j].parentElement
      var key = els[j].tagName.toLowerCase() + '.' + cls + '|' + (p ? (p.getAttribute('class') || p.tagName) : '')
      if (!counts[key]) counts[key] = { sig: els[j].tagName.toLowerCase() + '.' + cls, count: 0 }
      counts[key].count++
    }
    var groups = []
    for (var k in counts) if (counts[k].count >= 2) groups.push(counts[k])
    groups.sort(function (a, b) { return b.count - a.count })
    sections.push({ heading: heading, groups: groups.slice(0, 10) })
  }
  return { texts: texts, sections: sections }
}
```

Run the facts test → PASS.

- [ ] **Step 4: Integrate into `run.js` + `browse()` + `--force`** — write the failing integration test first (in `facts.test.js`): run `runBrowserPass` against the harness server with `opts.factsFor = new Set([url])` and a fresh `QC_CACHE_DIR`; assert `latestFactsByUrl(host).get(url).width === Math.max(...widths)`; run again and assert `styles.jsonl` still has exactly one row for the url (no re-capture). Then implement:
  - `run.js`: accept `opts.factsFor` (default empty `Set`); after a url's widths all succeed and `factsFor.has(url)` and `!latestFactsByUrl(host).has(url)`: `await preparePage(page, { width: widest, url, timeout })`, `const facts = await page.evaluate('(' + collectFacts.toString() + ')()')`, `appendFactsRow(host, { url, width: widest, texts: facts.texts, sections: facts.sections })`. A throw during capture must not fail the page row — catch it and push a note into the row (`row.factsError = errorText(e)`), the page's rule findings are already real.
  - `cli.js` `browse()`: `const factsFor = new Set(listReferencedUrls(host))` passed via `opts`; add to the summary: `factsCaptured: <number of urls captured this run or already present>`.
  - `store.js` `clearBrowserResults()`: also `rmSync(join(dir, 'styles.jsonl'), { force: true })` — `--force` promises a clean slate.

- [ ] **Step 5: Run the full suite** — `npm test` → all pass (browser tests included).

- [ ] **Step 6: Commit**

```bash
git add plugins/qc/engine/src/browser/facts.js plugins/qc/engine/src/browser/run.js \
  plugins/qc/engine/src/cli.js plugins/qc/engine/src/crawl/store.js \
  plugins/qc/engine/test/browser/facts.test.js plugins/qc/engine/test/browser/fixtures/facts.html
git commit -m "feat(qc): browse captures computed-style and section facts for referenced pages"
```

---

### Task 8: A5 — repeat-group counts

**Files:**
- Create: `plugins/qc/engine/src/rules/reference/A5-repeat-count.js`
- Test: `plugins/qc/engine/test/rules/A5.test.js`

**Interfaces:**
- Consumes: `_match.js` (`normText`, `tokens`, `diceTokens`), facts row shape `{ sections: [{ heading, groups: [{ sig, count }] }] }`.
- Produces: rule `A5`, title `'Количество элементов не совпадает с макетом'`, severity `major`, confidence `heuristic`.

- [ ] **Step 1: Write the failing test**

```js
// test/rules/A5.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePage } from '../../src/parse/page.js'
import { runReferenceRules } from '../../src/rules/reference-index.js'

const page = parsePage({ url: 'https://site.test/', html: '<html><body><h2>Our Services</h2></body></html>' })
const figma = (count) => ({ source: 'x', sections: [
  { order: 1, heading: 'Our Services', repeating: { itemName: 'card', count } },
] })
const facts = (count) => ({ url: 'https://site.test/', width: 1440, texts: [],
  sections: [{ heading: 'our services', groups: [{ sig: 'div.card', count }] }] })

const run = (expected, actual) => runReferenceRules(
  [page],
  new Map([['https://site.test/', { copyBlocks: null, figma: figma(expected), savedAt: 1, dir: '/x' }]]),
  new Map([['https://site.test/', facts(actual)]]),
  { only: ['A5'] },
)

test('count matches -> silent', async () => {
  assert.deepEqual(await run(3, 3), [])
})

test('count differs -> A5 finding with found/expected counts', async () => {
  const found = await run(4, 3)
  assert.equal(found.length, 1)
  assert.equal(found[0].rule, 'A5')
  assert.match(found[0].found, /3/)
  assert.match(found[0].expected, /4.*card/)
})

test('no facts row (browse not run) -> silent', async () => {
  const found = await runReferenceRules(
    [page],
    new Map([['https://site.test/', { copyBlocks: null, figma: figma(4), savedAt: 1, dir: '/x' }]]),
    new Map(),
    { only: ['A5'] },
  )
  assert.deepEqual(found, [])
})

test('section without repeating, or heading not found in facts -> silent', async () => {
  const noRepeat = { source: 'x', sections: [{ order: 1, heading: 'Our Services' }] }
  const f1 = await runReferenceRules([page],
    new Map([['https://site.test/', { copyBlocks: null, figma: noRepeat, savedAt: 1, dir: '/x' }]]),
    new Map([['https://site.test/', facts(3)]]), { only: ['A5'] })
  assert.deepEqual(f1, [])
})
```

- [ ] **Step 2: Run to verify failure**, then implement `A5-repeat-count.js`:

```js
import { normText, tokens, diceTokens } from './_match.js'

const rule = {
  id: 'A5',
  title: 'Количество элементов не совпадает с макетом',
  severity: 'major',
  engine: 'reference',
  confidence: 'heuristic',
}

const HEADING_MATCH = 0.6

function check(page, refs, facts) {
  if (!refs.figma || !facts || !Array.isArray(facts.sections)) return []
  const out = []
  for (const s of refs.figma.sections) {
    if (!s.repeating) continue
    const sTokens = tokens(s.heading)
    let best = { score: 0, section: null }
    for (const fs of facts.sections) {
      const score = normText(s.heading) === fs.heading ? 1 : diceTokens(sTokens, fs.heading.split(' '))
      if (score > best.score) best = { score, section: fs }
    }
    if (best.score < HEADING_MATCH || !best.section.groups.length) continue
    // The dominant repeat group is the card grid; smaller groups are icons,
    // buttons, decorations inside the cards.
    const got = best.section.groups[0]
    if (got.count !== s.repeating.count) {
      out.push({
        rule: rule.id, title: rule.title, severity: rule.severity, engine: rule.engine,
        confidence: rule.confidence, page: page.url, breakpoint: null, selector: null,
        found: `${got.count} × ${got.sig} в секции «${s.heading}»`,
        expected: `${s.repeating.count} × ${s.repeating.itemName} (по макету)`,
      })
    }
  }
  return out
}

export default { ...rule, check }
```

- [ ] **Step 3: Run tests** — A5 → PASS; `npm test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/qc/engine/src/rules/reference/A5-repeat-count.js plugins/qc/engine/test/rules/A5.test.js
git commit -m "feat(qc): A5 compares repeat-group counts against figma.json"
```

---

### Task 9: A6 + A3 — typography and text color via the text join

**Files:**
- Create: `plugins/qc/engine/src/rules/reference/_color.js`
- Create: `plugins/qc/engine/src/rules/reference/A6-typography.js`
- Create: `plugins/qc/engine/src/rules/reference/A3-text-color.js`
- Modify: `plugins/qc/engine/src/rules/reference/_match.js` (add `joinTexts`)
- Test: `plugins/qc/engine/test/rules/color.test.js`
- Test: `plugins/qc/engine/test/rules/A6-A3.test.js`

**Interfaces:**
- Consumes: facts row `texts: [{ text, fontSize, fontWeight, color }]`; figma `sections[].texts[{ text, fontSize, fontWeight, color }]`.
- Produces: `_match.js` gains `joinTexts(figmaTexts, factTexts) -> [{ figma, fact }]` (normalized-text equality, pairs unique on both sides only); `_color.js` exports `hexToLab`, `deltaE`, `DELTA_E_THRESHOLD = 10`; rules `A6` (`'Типографика не совпадает с макетом'`, minor, heuristic) and `A3` (`'Цвет текста не совпадает с макетом'`, minor, heuristic).

- [ ] **Step 1: Write failing color tests**

```js
// test/rules/color.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { deltaE, DELTA_E_THRESHOLD } from '../../src/rules/reference/_color.js'

test('identical colors have distance 0', () => {
  assert.equal(deltaE('#1a2b3c', '#1a2b3c'), 0)
})

test('near-identical dark grays are under the threshold', () => {
  assert.ok(deltaE('#1a1a1a', '#1b1b1b') < DELTA_E_THRESHOLD)
})

test('clearly different colors are far over the threshold', () => {
  assert.ok(deltaE('#1a2b3c', '#c0243a') > DELTA_E_THRESHOLD * 3)
})
```

- [ ] **Step 2: Implement `_color.js`** (sRGB → XYZ (D65) → Lab → CIE76):

```js
// CIE76 color distance -- enough to separate "same color, different render"
// from "wrong color", which is all A3 needs. Threshold calibrated live.
export const DELTA_E_THRESHOLD = 10

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function hexToLab(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex))
  if (!m) return null
  const [r, g, b] = [m[1], m[2], m[3]].map(h => srgbToLinear(parseInt(h, 16)))
  // sRGB D65 -> XYZ
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  let y = (0.2126 * r + 0.7152 * g + 0.0722 * b)
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116)
  ;[x, y, z] = [f(x), f(y), f(z)]
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) }
}

export function deltaE(hex1, hex2) {
  const l1 = hexToLab(hex1), l2 = hexToLab(hex2)
  if (!l1 || !l2) return Infinity
  return Math.sqrt((l1.L - l2.L) ** 2 + (l1.a - l2.a) ** 2 + (l1.b - l2.b) ** 2)
}
```

Run color tests → PASS.

- [ ] **Step 3: Write failing A6/A3 tests**

```js
// test/rules/A6-A3.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePage } from '../../src/parse/page.js'
import { runReferenceRules } from '../../src/rules/reference-index.js'

const page = parsePage({ url: 'https://site.test/', html: '<html><body><h1>x</h1></body></html>' })
const figma = (text) => ({ source: 'x', sections: [{ order: 1, heading: 'H', texts: [text] }] })
const facts = (t) => ({ url: 'https://site.test/', width: 1440, texts: [t], sections: [] })
const run = (figmaText, factText, only) => runReferenceRules(
  [page],
  new Map([['https://site.test/', { copyBlocks: null, figma: figma(figmaText), savedAt: 1, dir: '/x' }]]),
  new Map([['https://site.test/', facts(factText)]]),
  { only },
)

const T = 'deep cleaning in nyc'

test('A6: same size/weight (±1px) -> silent', async () => {
  assert.deepEqual(await run(
    { text: 'Deep Cleaning in NYC', fontSize: 60, fontWeight: 700 },
    { text: T, fontSize: 61, fontWeight: 700, color: '#111111' }, ['A6']), [])
})

test('A6: size differs beyond 1px -> finding; weight differs -> finding', async () => {
  const f1 = await run({ text: T, fontSize: 60 }, { text: T, fontSize: 48, fontWeight: 700 }, ['A6'])
  assert.equal(f1.length, 1)
  assert.match(f1[0].found, /48/)
  assert.match(f1[0].expected, /60/)
  const f2 = await run({ text: T, fontWeight: 700 }, { text: T, fontSize: 60, fontWeight: 400 }, ['A6'])
  assert.equal(f2.length, 1)
})

test('A3: near color -> silent, far color -> finding', async () => {
  assert.deepEqual(await run(
    { text: T, color: '#1A1A1A' }, { text: T, fontSize: 60, color: '#1b1b1b' }, ['A3']), [])
  const f = await run({ text: T, color: '#1A2B3C' }, { text: T, fontSize: 60, color: '#C0243A' }, ['A3'])
  assert.equal(f.length, 1)
  assert.match(f[0].found, /#c0243a/i)
  assert.match(f[0].expected, /#1a2b3c/i)
})

test('ambiguous text (appears twice on either side) is never compared', async () => {
  const fig = { source: 'x', sections: [{ order: 1, heading: 'H',
    texts: [{ text: T, fontSize: 60 }, { text: T, fontSize: 40 }] }] }
  const out = await runReferenceRules([page],
    new Map([['https://site.test/', { copyBlocks: null, figma: fig, savedAt: 1, dir: '/x' }]]),
    new Map([['https://site.test/', facts({ text: T, fontSize: 48 })]]),
    { only: ['A6'] })
  assert.deepEqual(out, [])
})

test('figma text without style fields -> silent on both rules', async () => {
  assert.deepEqual(await run({ text: T }, { text: T, fontSize: 48, color: '#000000' }, ['A6', 'A3']), [])
})
```

- [ ] **Step 4: Implement.** Add to `_match.js`:

```js
// Join figma text nodes to rendered text facts by normalized text equality.
// Only UNIQUE matches survive: a string appearing twice on either side is
// ambiguous (which occurrence is which?) and comparing it would guess.
export function joinTexts(figmaTexts, factTexts) {
  const countIn = (list) => {
    const m = new Map()
    for (const t of list) {
      const k = normText(t.text)
      m.set(k, (m.get(k) || 0) + 1)
    }
    return m
  }
  const fig = countIn(figmaTexts), fact = countIn(factTexts)
  const factByKey = new Map(factTexts.map(t => [normText(t.text), t]))
  const out = []
  for (const f of figmaTexts) {
    const k = normText(f.text)
    if (fig.get(k) !== 1 || fact.get(k) !== 1) continue
    out.push({ figma: f, fact: factByKey.get(k) })
  }
  return out
}
```

`A6-typography.js`:

```js
import { joinTexts, excerpt } from './_match.js'

const rule = {
  id: 'A6',
  title: 'Типографика не совпадает с макетом',
  severity: 'minor',
  engine: 'reference',
  confidence: 'heuristic',
}

const SIZE_TOLERANCE_PX = 1

function check(page, refs, facts) {
  if (!refs.figma || !facts || !Array.isArray(facts.texts)) return []
  const figmaTexts = refs.figma.sections.flatMap(s => s.texts || [])
  const out = []
  for (const { figma, fact } of joinTexts(figmaTexts, facts.texts)) {
    const bad = []
    if (typeof figma.fontSize === 'number' && typeof fact.fontSize === 'number'
      && Math.abs(figma.fontSize - fact.fontSize) > SIZE_TOLERANCE_PX) {
      bad.push(`размер ${fact.fontSize}px вместо ${figma.fontSize}px`)
    }
    if (typeof figma.fontWeight === 'number' && typeof fact.fontWeight === 'number'
      && figma.fontWeight !== fact.fontWeight) {
      bad.push(`насыщенность ${fact.fontWeight} вместо ${figma.fontWeight}`)
    }
    if (!bad.length) continue
    out.push({
      rule: rule.id, title: rule.title, severity: rule.severity, engine: rule.engine,
      confidence: rule.confidence, page: page.url, breakpoint: null, selector: null,
      found: `${bad.join('; ')} — «${excerpt(figma.text, 80)}»`,
      expected: 'типографика как в макете',
    })
  }
  return out
}

export default { ...rule, check }
```

`A3-text-color.js`:

```js
import { joinTexts, excerpt } from './_match.js'
import { deltaE, DELTA_E_THRESHOLD } from './_color.js'

const rule = {
  id: 'A3',
  title: 'Цвет текста не совпадает с макетом',
  severity: 'minor',
  engine: 'reference',
  confidence: 'heuristic',
}

function check(page, refs, facts) {
  if (!refs.figma || !facts || !Array.isArray(facts.texts)) return []
  const figmaTexts = refs.figma.sections.flatMap(s => s.texts || [])
  const out = []
  for (const { figma, fact } of joinTexts(figmaTexts, facts.texts)) {
    if (typeof figma.color !== 'string' || typeof fact.color !== 'string') continue
    if (deltaE(figma.color, fact.color) <= DELTA_E_THRESHOLD) continue
    out.push({
      rule: rule.id, title: rule.title, severity: rule.severity, engine: rule.engine,
      confidence: rule.confidence, page: page.url, breakpoint: null, selector: null,
      found: `${fact.color.toLowerCase()} — «${excerpt(figma.text, 80)}»`,
      expected: `${figma.color.toLowerCase()} (по макету)`,
    })
  }
  return out
}

export default { ...rule, check }
```

- [ ] **Step 5: Run tests** — A6-A3 and color → PASS; `npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/qc/engine/src/rules/reference/_color.js plugins/qc/engine/src/rules/reference/_match.js \
  plugins/qc/engine/src/rules/reference/A6-typography.js plugins/qc/engine/src/rules/reference/A3-text-color.js \
  plugins/qc/engine/test/rules/color.test.js plugins/qc/engine/test/rules/A6-A3.test.js
git commit -m "feat(qc): A6/A3 compare typography and text color via the text join"
```

---

### Task 10: audit merges reference + agentic findings; report shows reference coverage

**Files:**
- Modify: `plugins/qc/engine/src/cli.js` (audit)
- Modify: `plugins/qc/engine/src/report/html.js`
- Test: `plugins/qc/engine/test/cli-reference.test.js`
- Test: `plugins/qc/engine/test/report/html-reference.test.js`

**Interfaces:**
- Consumes: `runReferenceRules`, `allReferenceRules` (Task 5), `loadReferences`, `listReferencedUrls`, `latestFactsByUrl`, `loadAgenticFindings` (Task 1), `SNAPSHOT_TTL_MS`.
- Produces:
  - `audit()` summary gains `referenceCoverage: null | { pagesWithRefs, pagesTotal, copyPages, figmaPages, factsPages, agenticCount, agenticSkipped, desyncWarning: string|null }` (null = no references saved for any audited page).
  - `--only`/`--skip` in audit accept reference rule ids too: `validIds = [...staticIds, ...referenceIds]`.
  - `inlineScreenshots` also inlines `refShot -> refShotDataUri` (same missing-file tolerance).
  - `renderReport({ ..., referenceCoverage })` renders a coverage line and, when `agenticSkipped > 0` or `desyncWarning`, a warning note-box; a defect whose example has both `shotDataUri` and `refShotDataUri` renders them side by side labeled `Figma` / `Страница`.

- [ ] **Step 1: Write the failing audit integration test** — follow `test/cli.test.js`'s idiom (in-process `audit()` with `QC_CACHE_DIR` in tmp and a pre-saved snapshot so no network happens):

```js
// test/cli-reference.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { audit } from '../src/cli.js'
import { saveSnapshot, saveReferences, snapshotDir } from '../src/crawl/store.js'
import { parsePage } from '../src/parse/page.js'
import { appendFileSync, mkdirSync } from 'node:fs'

function seed() {
  process.env.QC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'qc-audit-ref-'))
  const page = parsePage({ url: 'https://site.test/', html: `<html><head><title>t</title></head>
    <body><h1>Deep Cleaning in NYC</h1><p>We clean every corner of your home with care.</p></body></html>` })
  saveSnapshot('site.test', { meta: { host: 'site.test', source: 'test' }, pages: [page], links: [] })
}

test('audit without references: referenceCoverage is null, nothing else changes', async () => {
  seed()
  const summary = await audit('https://site.test/', {})
  assert.equal(summary.referenceCoverage, null)
})

test('audit with references: H2 findings merge in, coverage reports sources', async () => {
  seed()
  saveReferences('site.test', 'https://site.test/', {
    copyMd: '# Deep Cleaning in NYC\n\nWe clean every corner of your house with care.\n' })
  const summary = await audit('https://site.test/', {})
  assert.equal(summary.referenceCoverage.pagesWithRefs, 1)
  assert.equal(summary.referenceCoverage.copyPages, 1)
  assert.equal(summary.referenceCoverage.figmaPages, 0)
  // 'home' vs 'house' -> one H2 finding, high confidence -> lands in counts
  assert.ok(summary.counts.major >= 1)
})

test('agentic findings merge and skipped rows are surfaced', async () => {
  seed()
  saveReferences('site.test', 'https://site.test/', { copyMd: '# Deep Cleaning in NYC\n' })
  const dir = snapshotDir('site.test')
  appendFileSync(join(dir, 'agentic.jsonl'),
    JSON.stringify({ rule: 'A2', title: 'Секция свёрстана иначе', severity: 'major',
      page: 'https://site.test/', found: 'hero растянут', expected: 'как в макете' }) + '\n' +
    'broken line\n')
  const summary = await audit('https://site.test/', {})
  assert.equal(summary.referenceCoverage.agenticCount, 1)
  assert.equal(summary.referenceCoverage.agenticSkipped, 1)
})

test('--only accepts a reference rule id', async () => {
  seed()
  saveReferences('site.test', 'https://site.test/', { copyMd: '# Deep Cleaning in NYC\n' })
  const summary = await audit('https://site.test/', { only: 'H2' })
  assert.equal(typeof summary.verdict, 'string') // no "неизвестные идентификаторы" throw
})
```

- [ ] **Step 2: Run to verify failure**, then wire `audit()`** (after the browser merge block, before `diffRuns`):

```js
  // Bucket 3: reference rules run off files the skill installed via `qc refs`
  // -- zero network. Pages without references are skipped inside the runner.
  const refsByUrl = new Map()
  for (const p of pages) {
    const r = loadReferences(host, p.url)
    if (r) refsByUrl.set(p.url, r)
  }
  const factsByUrl = latestFactsByUrl(host)
  const referenceFindings = refsByUrl.size
    ? await runReferenceRules(pages, refsByUrl, factsByUrl, { only: onlyIds, skip: skipIds })
    : []
  const agentic = loadAgenticFindings(host)
  inlineScreenshots(agentic.findings)

  const findings = [...staticFindings, ...browserFindings, ...referenceFindings, ...agentic.findings]
```

`referenceCoverage` (next to `browserCoverage`):

```js
  let referenceCoverage = null
  if (refsByUrl.size || agentic.findings.length || agentic.skipped) {
    const refs = [...refsByUrl.values()]
    const newest = Math.max(0, ...refs.map(r => r.savedAt))
    const snapSavedAt = (() => {
      try { return loadSnapshot(host)?.meta?.savedAt ?? null } catch { return null }
    })()
    const desyncWarning = (newest && snapSavedAt && Math.abs(newest - snapSavedAt) > SNAPSHOT_TTL_MS)
      ? `референсы и снимок сняты в разное время (разница больше ${Math.round(SNAPSHOT_TTL_MS / 86400000)} дн.) — сравнение может быть неактуальным`
      : null
    referenceCoverage = {
      pagesWithRefs: refsByUrl.size,
      pagesTotal: pages.length,
      copyPages: refs.filter(r => r.copyMd).length,
      figmaPages: refs.filter(r => r.figma).length,
      factsPages: [...refsByUrl.keys()].filter(u => factsByUrl.has(u)).length,
      agenticCount: agentic.findings.length,
      agenticSkipped: agentic.skipped,
      desyncWarning,
    }
  }
```

`validIds` becomes `[...(await allRules()).map(r => r.id), ...(await allReferenceRules()).map(r => r.id)].sort()`. Extend `inlineScreenshots` to process `refShot` into `refShotDataUri` with the same `seen` cache. Pass `referenceCoverage` into `renderReport` and add it to the returned summary.

- [ ] **Step 3: Write the failing report test** (`test/report/html-reference.test.js`, following `test/report/html-browser.test.js`'s hand-built-findings idiom): assert (a) coverage line renders «Референсы: 1 из 1 страниц…» when `referenceCoverage` present, (b) «референсы не заданы» line renders when it is null, (c) `agenticSkipped > 0` renders a note-box mentioning пропущенных строк, (d) `desyncWarning` renders, (e) a finding with both `shotDataUri` and `refShotDataUri` renders two `<img>` with `Figma` and `Страница` labels. Then implement in `html.js`: the header line next to the browser-coverage line, and the pair rendering inside `renderDefect` (a flex row, both images `max-width:49%`).

- [ ] **Step 4: Run everything** — both new test files → PASS; `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/engine/src/cli.js plugins/qc/engine/src/report/html.js \
  plugins/qc/engine/test/cli-reference.test.js plugins/qc/engine/test/report/html-reference.test.js
git commit -m "feat(qc): audit merges reference and agentic findings; report states reference coverage"
```

---

### Task 11: single-page mode — `--page` for audit and browse

**Files:**
- Modify: `plugins/qc/engine/src/cli.js`
- Test: `plugins/qc/engine/test/cli-page-mode.test.js`

**Interfaces:**
- Consumes: everything already wired in `audit()`/`browse()`.
- Produces:
  - `qc audit <site-url> --page <url>`: rules, findings, report, and summary cover ONLY that page. If the fresh snapshot contains the page, it is reused; otherwise the single page is fetched, parsed, link-checked, and MERGED into the existing snapshot by url (other pages preserved; `preserveSavedAt: true` when a snapshot already existed — a one-page fetch does not make a whole crawl fresh). Summary gains `pageMode: <url> | null`.
  - `qc browse <host|url> --page <url>`: the page loop runs only that url; it must already exist in the snapshot, else: `страница не найдена в снимке — запустите: qc audit <site> --page <url>`.
  - USAGE lines for both flags.

- [ ] **Step 1: Write the failing test**

```js
// test/cli-page-mode.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { audit, browse } from '../src/cli.js'
import { saveSnapshot, loadSnapshot } from '../src/crawl/store.js'
import { parsePage } from '../src/parse/page.js'

const P = (url, body) => parsePage({ url, html: `<html><head><title>t</title></head><body>${body}</body></html>` })

function seedTwoPages() {
  process.env.QC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'qc-page-mode-'))
  saveSnapshot('site.test', {
    meta: { host: 'site.test', source: 'test' },
    pages: [P('https://site.test/', '<h1>Home</h1>'), P('https://site.test/about/', '<h1>About</h1>')],
    links: [],
  })
}

test('audit --page audits only that page from a fresh snapshot', async () => {
  seedTwoPages()
  const summary = await audit('https://site.test/', { page: 'https://site.test/about/' })
  assert.equal(summary.pageMode, 'https://site.test/about/')
  assert.equal(summary.pages, 1)
  // the other page is still in the snapshot, untouched
  assert.equal(loadSnapshot('site.test').pages.length, 2)
})

test('audit --page with a url missing from the snapshot fetches just it (merge, not clobber)', async () => {
  seedTwoPages()
  // fetch of the missing page must fail fast offline -> the error must name the page,
  // proving audit attempted a single-page fetch rather than a full crawl
  await assert.rejects(
    () => audit('https://site.test/', { page: 'https://site.invalid.localdomain/x/' }),
    /site\.invalid|не удалось|страниц/i,
  )
})

test('browse --page refuses a url not in the snapshot', async () => {
  seedTwoPages()
  await assert.rejects(
    () => browse('site.test', { page: 'https://site.test/nope/' }),
    /не найдена в снимке/,
  )
})
```

(The second test pins the "no full crawl" behavior observable offline; the happy fetch path is covered by the local-server pattern already used in `test/cli.test.js` — add one test there mirroring its server setup: serve one page, seed a snapshot WITHOUT it, run `audit(base, { page: base + '/new/' })`, assert the snapshot now holds both pages and `summary.pages === 1`.)

- [ ] **Step 2: Run to verify failure**, then implement.
  - `audit()`: read `const pageMode = requireStringFlag(flags, 'page', '--page')`; validate `hostOf(pageMode) === host` (else: `--page должен быть страницей того же хоста`). After the cached/crawl branch resolves `pages`:
    - if `pageMode` and the resolved `pages` contain it → `pages = [that page]` for rules/report; snapshot save (fresh-crawl branch) still writes ALL pages it fetched.
    - if `pageMode` and the page is NOT in the fresh snapshot → fetch only `[pageMode]` via `fetchAll`, parse, `checkLinks` on it, then MERGE: `merged = [...existingPages.filter(p => p.url !== finalUrl), newPage]`, `saveSnapshot(host, { meta: { ...existingMeta, pageCount: merged.length }, pages: merged, links: mergedLinks, preserveSavedAt: Boolean(existingSnap) })`, and audit `pages = [newPage]`.
    - `pagesRequested`/`pagesFailed` reflect the single page. `browserCoverage`/`referenceCoverage` compute against `pages` (already do). Summary gains `pageMode: pageMode ?? null`.
  - `browse()`: after loading the snapshot, if `--page` given: `snap.pages = snap.pages.filter(p => p.url === pageValue)`; empty → throw `страница не найдена в снимке — запустите: qc audit <хост> --page <url>`.
  - USAGE: add `[--page <url>]` to both lines.

- [ ] **Step 3: Run tests** — page-mode tests → PASS; `npm test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/qc/engine/src/cli.js plugins/qc/engine/test/cli-page-mode.test.js
git commit -m "feat(qc): --page runs audit and browse over a single page without clobbering the snapshot"
```

---

### Task 12: `/qc-page` skill

**Files:**
- Create: `plugins/qc/skills/qc-page/SKILL.md`
- Create: `plugins/qc/skills/qc-page/references/rubric.md`
- Create: `plugins/qc/skills/qc-page/references/gbp-checks.md`
- Modify: `plugins/qc/.claude-plugin/plugin.json` (description mentions the reference pass)

**Interfaces:**
- Consumes: `qc refs`, `qc audit --page`, `qc browse --page`, `agentic.jsonl` row format (interfaces block at the top), `figma.json` schema (Task 3), personal skill `~/.claude/skills/qc-page/` as text donor.
- Produces: a skill invocable as `/qc-page <page-url> <copy-doc-url> <figma-url> [gbp-url]`.

- [ ] **Step 1: Port the reference docs.** Read `~/.claude/skills/qc-page/references/rubric.md` and `gbp-checks.md`. Copy `gbp-checks.md` as is. Rewrite `rubric.md` to cover ONLY what stays agentic: A2 (секция свёрстана иначе — что считается «иначе», negative rules о чём НЕ флагать: анимационные артефакты полноэкранных скриншотов, fixed/parallax фоны), A4 (другая картинка — сравнение мотива, не пикселей), GBP dimension. Text/structure/typography checks are the engine's now — the rubric must say so explicitly and forbid the agent from duplicating them.

- [ ] **Step 2: Write `SKILL.md`.** Frontmatter mirrors the personal skill's `description`/`argument-hint` (it already triggers well). Body structure (follow `/qc-browse`'s tone — "the engine does the checking, you orchestrate"):
  1. **Классификация аргументов** по паттернам URL (docs.google.com/document → копи-док; figma.com/(design|file|proto) → Figma; maps-паттерны → GBP; остальное → страница). Отсутствующий источник → AskUserQuestion с опцией «пропустить»; пропуск = «Not checked» в резюме, никогда молча.
  2. **Копи-док**: `curl -sL "https://docs.google.com/document/d/<ID>/export?format=md"` → `<scratchpad>/qc-page/copy.md`; fallback-цепочка format=html/txt → браузер пользователя (get_page_text) → спросить у пользователя. Файл отдаётся движку сырым — не переписывать, не «улучшать».
  3. **Figma через Figma MCP**: `get_metadata` для дерева фрейма → секции верхнего уровня (order, name, heading = текст заголовка секции), `get_design_context` для текстовых нод (text, fontSize, fontWeight, color hex), `get_screenshot` посекционно → `renders/NN-<slug>.png`. Собрать `figma.json` РОВНО по схеме из спеки (обязательны только source + sections[].order + sections[].heading; не выдумывать значения — поле, которого MCP не дал, опускается). Fallback при недоступности MCP: Chrome-скриншоты по методике личного скилла (view-only: зум через поле %, тайлинг скроллом) — тогда `figma.json` не собирается, движковые A-правила молчат, работает только агентная часть; сказать это пользователю явно.
  4. **Установка референсов**: `node <plugin-root>/engine/src/cli.js refs "<page-url>" --copy … --figma … --renders …`. Ненулевой exit = валидация не прошла; прочитать перечень нарушений, пересобрать figma.json, повторить (максимум дважды, потом спросить пользователя).
  5. **Движок**: `qc audit "<site>" --page "<url>"` затем `qc browse "<site>" --page "<url>"` (в фоне; browse может быть долгим). Проверить exit code и `factsCaptured`.
  6. **Агентная часть**: сравнить каждый render из `figma.json` с кропами browse (пары по секциям) — только A2/A4 по rubric.md; GBP-проверки по gbp-checks.md. Каждую находку — СТРОКОЙ в `<snapshot>/agentic.jsonl` ровно в формате движкового finding (`engine` не писать — движок проставит сам; `refShot` — путь к render'у, `shot` — путь к кропу страницы). Никогда не дублировать то, что движок уже нашёл (H2/A1/A5/A6/A3 в отчёте) — агентная часть закрывает только визуальное.
  7. **Финал**: повторный `qc audit --page` → прочитать `reportPath`, `referenceCoverage`, `distinct` → загрузить `artifact-design` скилл → опубликовать отчёт Artifact'ом (favicon `✅`, title `QC · <host>`), резюме в чат по-русски: вердикт, distinct по severity, «Not checked»-источники, топ-5, ссылка, runDir.
  8. **Правила** (порт из /qc-browse + личного скилла): не переизобретать проверки движка; не флагать по полноэкранным скриншотам артефакты parallax; login-wall/бот-челлендж цепочки; ненулевой exit — стоп и сообщить, не публиковать.

- [ ] **Step 3: Update `plugin.json` description** to: `"QC of WordPress + Elementor + Gravity Forms sites: static checks, browser pass, and reference comparison against the copy doc and Figma"`.

- [ ] **Step 4: Self-check the skill doc** — every CLI invocation in it matches the USAGE implemented in Tasks 4/10/11 verbatim; the `figma.json` example in it validates against `validateFigma` (paste it into a node REPL against the real module); the agentic.jsonl example row passes `loadAgenticFindings` validation.

- [ ] **Step 5: Commit**

```bash
git add plugins/qc/skills/qc-page/ plugins/qc/.claude-plugin/plugin.json
git commit -m "feat(qc): /qc-page orchestrates references, engine passes, and the agentic visual dimension"
```

---

### Task 13: Live calibration run

**This task needs the user present** (Figma MCP auth, a real page + copy doc + макет). Do not run it from a subagent — orchestrate it in the main session.

**Files:**
- Modify: `plugins/qc/references/taxonomy.md` (calibration log)
- Modify: thresholds in `src/rules/reference/*.js` as measured
- Possibly modify: `plugins/qc/skills/qc-page/SKILL.md` (grabli discovered live)

- [ ] **Step 1: Pick the target with the user** — a production page that has both a copy doc and a Figma frame (the agency's own projects; the MarkUp.io base names candidates).
- [ ] **Step 2: Run `/qc-page` end to end** exactly as the skill prescribes, no shortcuts.
- [ ] **Step 3: Triage every finding** with the user: true positive / noise / miss. Both previous buckets showed pre-calibration thresholds produce noise — expect to tune `CHANGED_THRESHOLD` (0.6), `HEADING_THRESHOLD` (0.5), `MATCH_THRESHOLD` (0.6), `HEADING_MATCH` (0.6), `SIZE_TOLERANCE_PX` (1), `DELTA_E_THRESHOLD` (10), and the `MIN_PROSE_TOKENS` floor. Every changed constant gets a test pinning the calibrated value's motivating case (the real text pair that justified it, anonymised).
- [ ] **Step 4: Record the calibration log** in `taxonomy.md` (same format as the bucket-1/2 logs: date, target, rule, was → became, why). Decide with the user whether any A-rule earns `high` confidence; H2 stays `high` unless the run says otherwise.
- [ ] **Step 5: Run `npm test`, commit**

```bash
git add plugins/qc/engine/src/rules/reference/ plugins/qc/references/taxonomy.md plugins/qc/skills/qc-page/
git commit -m "fix(qc): calibrate reference rules against a live page"
```

---

## Self-review (done while writing)

- **Spec coverage:** `qc refs` (T4), reference rules H2/A1/A5/A6/A3 (T5/6/8/9), styles.jsonl capture in browse (T7), agentic.jsonl merge + validation (T1/T10), report coverage header + pairs + desync warning (T10), `--page` (T11), skill with GBP and fallbacks (T12), live calibration (T13). Error handling: no refs → null coverage (T10 test), broken figma.json rejected at `qc refs` (T4 test), broken agentic line skipped+counted (T1/T10 tests).
- **Type consistency:** finding shape, `refs`/`facts` shapes, and every store function signature match the interfaces block; `refShot`/`refShotDataUri` naming is uniform across T1 (format), T10 (inlining, rendering), T12 (skill contract).
- **Placeholders:** the two spots that say "follow the harness idiom" point at concrete existing files (`test/browser/harness.js`, `test/cli.test.js`) that the implementer must read — deliberate, since those APIs already exist in the repo and copying them here would drift.
