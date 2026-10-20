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
  assert.equal(e3.length, 7)

  // The only internal target=_blank link is the Privacy Policy in the quote
  // form's consent checkbox, which the agency wants in a new tab.
  assert.equal(e3.filter(f => f.severity === 'major').length, 0)
  assert.ok(e3.every(f => f.where), 'the report says where each link is, not just `a`')

  const missingNoopener = e3.filter(f => /without rel=noopener/.test(f.found))
  assert.equal(missingNoopener.length, 6)
  for (const f of missingNoopener) {
    assert.equal(f.severity, 'minor', 'implied noopener since 2021 -- hygiene, not a vulnerability')
    assert.equal(f.confidence, 'high', 'the absence is read straight off the markup')
  }

  const styleCall = e3.filter(f => /without target/.test(f.found) && !/rel=noopener/.test(f.found))
  assert.equal(styleCall.length, 1)
  assert.equal(styleCall[0].severity, 'minor')
  assert.equal(styleCall[0].confidence, 'heuristic', 'a per-client style preference, never a verdict mover')

  const others = ['E9', 'F12', 'G13', 'E16'].reduce((n, id) => n + forRule(id).length, 0)
  assert.equal(findings.length, e3.length + others, 'no other rule may fire on this page')
})

test('E9 finds the office address in the body copy that is not a link', () => {
  // The footer links "Suite 1 A, 11 Park Place" to the GBP short link; the
  // "from our office at Suite 1A, 11 Park Place" sentence has no link. That
  // is QA's "make address active", found by pattern, so heuristic -- and
  // minor, since the page already links the profile once.
  const e9 = forRule('E9')
  assert.equal(e9.length, 1)
  assert.equal(e9[0].found, 'address “11 Park Place” is not clickable')
  assert.equal(e9[0].confidence, 'heuristic')
  assert.equal(e9[0].severity, 'minor')
})

test('F12 finds the skip link with no #content and the JS-only "Get a Quote Now" button', () => {
  // Hello Elementor prints "Skip to content" -> #content, but the
  // elementor_header_footer template renders no element with that id. The
  // quote button is href="#" opened by the theme's own script, so only a
  // heuristic.
  const f12 = forRule('F12')
  assert.equal(f12.length, 2)
  const skip = f12.find(f => /#content/.test(f.found))
  assert.equal(skip.confidence, 'high')
  assert.equal(skip.severity, 'minor')
  const stub = f12.find(f => /href="#"/.test(f.found))
  assert.equal(stub.confidence, 'heuristic')
})

test('G13 and E16 read the site inventory off the menu, footer and form', () => {
  // The quote form's "Residential" is "Apartment & Home Cleaning" in the
  // menu (heuristic: naming can be deliberate); two services in the menu are
  // missing from the footer list (major: visitors never see them there).
  assert.deepEqual(forRule('G13').map(f => f.found), [
    'form #gform_5: option “Residential” does not match the name: the service is called “Apartment & Home Cleaning” (/services/residential-cleaning)',
  ])
  assert.deepEqual(forRule('E16').map(f => f.found).sort(), [
    'service “Disinfection & Sanitizing” (/services/disinfection-sanitizing) is in the menu, but not in the footer',
    'service “Janitorial Cleaning” (/services/janitorial-cleaning) is in the menu, but not in the footer',
  ])
  assert.ok(forRule('G13').every(f => f.confidence === 'heuristic'))
  assert.ok(forRule('E16').every(f => f.severity === 'major' && f.confidence === 'high'))
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
  E12: 'one page cannot form a site-wide majority, and no facts file is given',
  H9: 'no facts file, so there are no retired terms to look for',
  H11: 'no facts file, so there is no reference email or rating',
  I18: 'no link was checked, so no redirect is known',
  E2: 'one page cannot form a site-wide majority',
  H5: 'no stale copyright year, and the title carries no year',
  E14: 'a one-page run is not a sitemap of the whole site',
  E15: 'no self-link in the body, no linked date, not a PPC landing page',
  H10: 'one page has no "rest of the site" to differ from',
  E13: 'the one visible phone number is the tel: link itself',
  K14: 'not a blog listing page',
  K13: 'a production audit, so there is no live counterpart to compare',
  I20: 'the schema address and phone are the ones shown on the page',
  I10: 'the crumbs Home > Services match /services/office-cleaning/',
  H12: 'a service page, and a one-page run knows no locations; no state in title or H1',
  K16: 'no sibling pages to compare blocks with',
  I21: 'the slug matches the title, and one page has no duplicate H1',
  H14: 'no list heading repeats on three pages',
  H17: 'not the homepage, and the brand has no other spellings here',
  H16: 'one page cannot contradict another',
  E17: 'every CTA leads where its text says',
  H6: 'no placeholder image, copy-doc marker or schema placeholder on a finished page',
  K17: 'a service page, not a post signed by a service account',
  I22: 'no link to a working copy, and the fixture is not the home page',
}

for (const [id, why] of Object.entries(MUST_BE_SILENT)) {
  test(`${id} reports nothing on the real fixture (${why})`, () => {
    assert.deepEqual(forRule(id), [], `${id} fired on a page where it must not`)
  })
}

test('every rule in the registry is accounted for by this file', async () => {
  const ids = (await allRules()).map(r => r.id).sort()
  const covered = ['E3', 'E9', 'F12', 'G13', 'E16', ...Object.keys(MUST_BE_SILENT)].sort()
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
  assert.ok(devFindings.some(f => /link to prod/.test(f.found)))
})

test('audited as dev with no known production host, I14 stays silent rather than guessing', async () => {
  const devFindings = await runStaticRules([page], { ...site, env: 'dev', prodHost: null }, { only: ['I14'] })
  assert.deepEqual(devFindings, [])
})
