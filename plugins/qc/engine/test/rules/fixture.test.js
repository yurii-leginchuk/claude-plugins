// plugins/qc/engine/test/rules/fixture.test.js
//
// Every other rule test in this suite builds its PageDoc as a hand-written
// object literal. That is fine for exercising a branch and useless for
// catching the class of bug where the *parser* hands a rule something the
// literal never would -- which is exactly how two of this branch's three
// Criticals happened:
//
//   - page.text carried <script>/<style> source, so H1 flagged "Lorem ipsum"
//     out of a theme's JS demo payload and E6 flagged an email out of
//     Yoast/RankMath JSON-LD. Neither could ever be reproduced with a
//     hand-built `text: 'some copy'`.
//   - a page keyed to the requested rather than the final URL made I5 report
//     a Critical on a correct canonical.
//
// So this file parses the committed real fixture -- a live WordPress +
// Elementor + Gravity Forms service page -- with parsePage() and runs ALL
// rules over it, asserting the outcome for each one. Where a rule legitimately
// fires, assert what it reports. Where it must not fire, assert zero findings:
// that assertion is the one that would have caught the page.text bug on the
// day it was written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePage } from '../../src/parse/page.js'
import { buildIndex } from '../../src/parse/index.js'
import { runStaticRules, allRules } from '../../src/rules/index.js'

const URL_UNDER_TEST = 'https://cleaningny.com/services/office-cleaning/'
const html = readFileSync(new URL('../fixtures/opura-office-cleaning.html', import.meta.url), 'utf8')
const page = parsePage({ url: URL_UNDER_TEST, html, status: 200, headers: { 'content-type': 'text/html' } })

// A single-page production site. `linkStatus` is empty on purpose: nothing in
// this test may touch the network, and the rules that consume it (E1, I13)
// must treat "not checked" as "nothing to report", never as "broken".
const site = {
  host: 'cleaningny.com',
  env: 'prod',
  prodHost: null,
  pages: [page],
  index: buildIndex([page]),
  linkStatus: new Map(),
}

const findings = await runStaticRules([page], site)
const forRule = (id) => findings.filter(f => f.rule === id)

// ---------------------------------------------------------------------------
// The page itself, as the parser sees it. If one of these drifts, the
// per-rule expectations below stop meaning what they say, so they are pinned.
// ---------------------------------------------------------------------------

test('the fixture parses into the page this file makes claims about', () => {
  assert.equal(page.url, URL_UNDER_TEST)
  assert.equal(page.title, 'Office Cleaning Services NYC | Opura')
  assert.equal(page.canonical, URL_UNDER_TEST)
  assert.equal(page.lang, 'en-US')
  assert.equal(page.robots.index, true)
  assert.equal(page.robots.follow, true)
  assert.equal(page.headings.filter(h => h.level === 1).length, 1)
  assert.equal(page.forms.length, 1)
  assert.equal(page.forms[0].gravity, true)
  assert.equal(page.jsonLd.length, 4)
  assert.ok(page.favicons.length >= 1)
  assert.ok(page.links.length > 50)
  assert.ok(page.images.length > 20)
})

// ---------------------------------------------------------------------------
// Rules that legitimately fire on this page.
// ---------------------------------------------------------------------------

test('E3 is the only rule this page trips, and it reports exactly what is on the page', () => {
  const e3 = forRule('E3')
  assert.equal(e3.length, 8)

  const major = e3.filter(f => f.severity === 'major')
  assert.equal(major.length, 1, 'one internal link forces a new tab')
  assert.equal(major[0].confidence, 'high')
  assert.match(major[0].found, /внутренняя ссылка с target=_blank: \/privacy-policy\//)
  assert.equal(major[0].expected, 'без target')

  const missingNoopener = e3.filter(f => /без rel=noopener/.test(f.found))
  assert.equal(missingNoopener.length, 6)
  for (const f of missingNoopener) {
    assert.equal(f.severity, 'minor', 'implied noopener since 2021 -- hygiene, not a vulnerability')
    assert.equal(f.confidence, 'high', 'the absence is read straight off the markup')
  }

  const styleCall = e3.filter(f => /без target/.test(f.found) && !/rel=noopener/.test(f.found))
  assert.equal(styleCall.length, 1)
  assert.equal(styleCall[0].severity, 'minor')
  assert.equal(styleCall[0].confidence, 'heuristic', 'a per-client style preference, never a verdict mover')

  assert.equal(findings.length, e3.length, 'no other rule may fire on this page')
})

// ---------------------------------------------------------------------------
// Rules that must stay silent. Each `assert.deepEqual(..., [])` below is a
// false-positive guard against a real production page, which is the assertion
// class this suite was missing.
// ---------------------------------------------------------------------------

const MUST_BE_SILENT = {
  E1: 'no link was checked, so no link is broken -- an unchecked link is not a 404',
  E4: 'the page has no tel: link at all',
  E5: 'no doubled country code anywhere on the page',
  E6: 'every email on this page lives in JSON-LD or a form config, not in visible copy',
  G1: 'the Gravity Form carries its privacy-policy consent checkbox',
  G3: 'every required field is visibly marked',
  G5: 'the phone field is gfield--type-phone and input type=tel',
  H1: 'the copy is real; any Lorem ipsum here would be in machine payload',
  H7: 'no non-decorative image is missing its alt',
  I1: 'exactly one H1',
  I2: 'the heading hierarchy does not skip a level',
  I3: 'the H1 is text, not an image',
  I4: 'robots is "index, follow"',
  I5: 'the canonical is self-referencing and exact',
  I6: 'the title is unique and the page is not the homepage',
  I7: 'the meta description is present and within length',
  I8: 'this is not a paginated URL',
  I13: 'a favicon is declared and nothing says it is broken',
  I14: 'a prod page linking only at prod and third parties',
  J1: 'header, main and nav landmarks are present',
  S1: 'all four JSON-LD blocks parse',
}

for (const [id, why] of Object.entries(MUST_BE_SILENT)) {
  test(`${id} reports nothing on the real fixture (${why})`, () => {
    assert.deepEqual(forRule(id), [], `${id} fired on a page where it must not`)
  })
}

test('every rule in the registry is accounted for by this file', async () => {
  const ids = (await allRules()).map(r => r.id).sort()
  const covered = ['E3', ...Object.keys(MUST_BE_SILENT)].sort()
  assert.deepEqual(ids, covered,
    'a new rule must state here whether it fires on the real fixture -- silence by omission is how ' +
    'a false positive on every production page ships unnoticed')
})

// ---------------------------------------------------------------------------
// Two properties that hold no matter which rules fire: no finding may carry
// page internals, and no rule may crash on real-world markup.
// ---------------------------------------------------------------------------

test('no finding carries script source, style source or raw page HTML', () => {
  for (const f of findings) {
    const payload = `${f.found ?? ''} ${f.expected ?? ''}`
    assert.doesNotMatch(payload, /jQuery|function\s*\(|<script|<\/script|\{"@context"/,
      `finding from ${f.rule} leaked page internals: ${payload.slice(0, 200)}`)
  }
})

test('no rule crashes on the real fixture', () => {
  // runStaticRules converts a thrown rule into a note-severity finding whose
  // `found` starts with "rule crashed:". None may be present.
  const crashed = findings.filter(f => /^rule crashed:/.test(String(f.found)))
  assert.deepEqual(crashed, [])
})

// ---------------------------------------------------------------------------
// The same page, audited as dev. I14's dev-side clause turns the page's own
// (production) links into findings -- but only when the run knows what
// production is.
// ---------------------------------------------------------------------------

test('audited as dev with a known production host, I14 flags the unreplaced production URLs', async () => {
  const devFindings = await runStaticRules([page], {
    ...site, env: 'dev', prodHost: 'cleaningny.com',
  }, { only: ['I14'] })
  assert.ok(devFindings.length > 0, 'the page links and images point at cleaningny.com')
  assert.ok(devFindings.every(f => f.severity === 'critical'))
  assert.ok(devFindings.some(f => /ссылка на прод/.test(f.found)))
})

test('audited as dev with no known production host, I14 stays silent rather than guessing', async () => {
  const devFindings = await runStaticRules([page], { ...site, env: 'dev', prodHost: null }, { only: ['I14'] })
  assert.deepEqual(devFindings, [])
})
