import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proveRegions, regionOf } from '../../src/browser/regions.js'
import { defectIdentity } from '../../src/report/json.js'

const page = (url, ids, locations = []) =>
  ({ url, elementor: { containerIds: ids, locations, postCssIds: [], skeleton: '' } })

// Real parser output (src/parse/page.js) pairs a container id with its
// location class only when both classes sit on the *same* element -- see
// judgement call 1 below for why the flat `locations` array alone can't do
// this once a page has more than one named location.
const pageWithPairing = (url, locationsById, extraIds = []) =>
  ({
    url,
    elementor: {
      containerIds: [...Object.keys(locationsById), ...extraIds],
      locations: Object.values(locationsById),
      locationsById,
      postCssIds: [],
      skeleton: '',
    },
  })

// --- Brief's baseline tests (verbatim) -------------------------------------

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

// --- Judgement call 1: naming when a page carries several location classes -
//
// The brief's naive naming rule ("map id -> name only when the page has
// exactly one location class") means a page with both header and footer
// contributes NO names, because it has two location classes, not one -- and
// the real 31-page fixture (test/fixtures/opura-office-cleaning.html) has
// exactly that: every page carries both `elementor-location-header` and
// `elementor-location-footer`. Verified this by running the naive rule from
// the brief against this exact input before writing the fix below: it
// returned name === id ('3374', '3381') for both, not 'header'/'footer'.
//
// Elementor puts the id class and the location class on the *same* element
// (`class="elementor elementor-3374 elementor-location-header"`), so the
// pairing has to be captured there, not reconstructed later from two
// already-flattened, unordered arrays -- position in `containerIds` and
// position in `locations` don't correspond once a page has any container
// (e.g. page content) that carries an id but no location class, which
// desyncs the two arrays' indices. src/parse/page.js now emits
// `elementor.locationsById`, an id -> location map built while walking each
// `.elementor` element once, and proveRegions prefers it over the
// single-location fallback.
test('a page carrying both header and footer location classes still names each region correctly', () => {
  const r = proveRegions([
    pageWithPairing('https://ex.com/a', { '3374': 'header', '3381': 'footer' }, ['5718']),
    pageWithPairing('https://ex.com/b', { '3374': 'header', '3381': 'footer' }, ['5254']),
  ])
  assert.equal(r.get('3374').name, 'header', 'header must not fall back to its bare id')
  assert.equal(r.get('3381').name, 'footer', 'footer must not fall back to its bare id')
})

test('locationsById pairing is preferred even when the flat locations array is also present and ambiguous', () => {
  // locations has two entries so the brief's naive "length === 1" rule can't
  // use it; locationsById unambiguously says which id is which.
  const r = proveRegions([
    pageWithPairing('https://ex.com/a', { '10': 'header', '20': 'footer' }),
    pageWithPairing('https://ex.com/b', { '10': 'header', '20': 'footer' }),
  ])
  assert.equal(r.get('10').name, 'header')
  assert.equal(r.get('20').name, 'footer')
})

// --- Judgement call 2: the "shared" threshold scales with site size --------
//
// "More than one page" is the right bar for a handful of pages (the brief's
// own 2-page tests above rely on exactly that), but on a large site a
// container hit on 2 of 300 pages is coincidence, not a template region.
// Chose a majority threshold with a floor of 2: appear on at least half the
// pages (ceil), minimum 2. On a tiny site that coincides with "more than
// one page" (2 of 2 pages = both, still required); on the real 31-page site
// header/footer hit 100% of pages, comfortably over the bar; on a 300-page
// site a container needs 150+ pages, so 2-of-300 correctly does not qualify.
test('on a large site, a container seen on only a couple of pages does not count as shared', () => {
  const pages = Array.from({ length: 300 }, (_, i) => page(`https://ex.com/${i}`, i < 2 ? ['9999'] : []))
  const r = proveRegions(pages)
  assert.ok(!r.has('9999'), 'a container on 2 of 300 pages must not be proved a region')
})

test('on a large site, a container seen on a majority of pages is a proven region', () => {
  const pages = Array.from({ length: 300 }, (_, i) => page(`https://ex.com/${i}`, i < 200 ? ['3374'] : []))
  const r = proveRegions(pages)
  assert.ok(r.has('3374'))
  assert.equal(r.get('3374').pageCount, 200)
})

test('a single-page snapshot cannot produce any regions', () => {
  const r = proveRegions([page('https://ex.com/a', ['3374', '3381'], ['header', 'footer'])])
  assert.equal(r.size, 0, 'one page can never prove sharing across pages')
})

// --- Defensive: absent/malformed input never throws ------------------------

test('proveRegions tolerates null, undefined and non-array input', () => {
  assert.equal(proveRegions(null).size, 0)
  assert.equal(proveRegions(undefined).size, 0)
  assert.equal(proveRegions('not an array of pages').size, 0)
  assert.equal(proveRegions(42).size, 0)
})

test('proveRegions tolerates malformed page and elementor entries within the array', () => {
  const r = proveRegions([
    null,
    undefined,
    {},
    { elementor: null },
    { elementor: { containerIds: 'not-an-array', locations: 5, locationsById: 'nope' } },
    page('https://ex.com/ok', ['3374'], ['header']),
  ])
  // The one well-formed page can't prove anything alone; nothing throws.
  assert.equal(r.size, 0)
})

// --- Judgement call 3: mapping a finding to its region ----------------------
//
// proveRegions proves *container ids* are shared; a browser finding carries
// a CSS selector (from selectorOf() in src/parse/page.js), not a container
// id -- there is no DOM to walk here. This module is pure functions over
// snapshot data (no playwright dependency per the browser-pass budget), so
// discovering *which* container an element lives inside requires a live DOM
// walk that only the browser run loop (Task 7) can do: for each finding,
// walk up from the element to the nearest ancestor carrying an
// `elementor-<id>` class and attach that id as `finding.containerId` before
// calling regionOf. regionOf itself only performs the lookup: is this
// already-identified container one of the ones proveRegions proved shared.
test('regionOf resolves a finding whose containerId is a proven region', () => {
  const regions = proveRegions([
    page('https://ex.com/a', ['3381'], ['footer']),
    page('https://ex.com/b', ['3381'], ['footer']),
  ])
  const finding = { rule: 'E3', page: 'https://ex.com/a', selector: 'a.soc', found: 'x', containerId: '3381' }
  assert.equal(regionOf(finding, regions), 'footer')
})

test('regionOf returns undefined when the containerId was never proven shared', () => {
  const regions = proveRegions([
    page('https://ex.com/a', ['3381'], ['footer']),
    page('https://ex.com/b', ['3381'], ['footer']),
  ])
  const finding = { rule: 'I3', page: 'https://ex.com/a', selector: 'img.hero', found: 'x', containerId: '9001' }
  assert.equal(regionOf(finding, regions), undefined)
})

test('regionOf returns undefined when the finding carries no containerId at all', () => {
  const regions = proveRegions([
    page('https://ex.com/a', ['3381'], ['footer']),
    page('https://ex.com/b', ['3381'], ['footer']),
  ])
  const finding = { rule: 'I3', page: 'https://ex.com/a', selector: 'img.hero', found: 'x' }
  assert.equal(regionOf(finding, regions), undefined)
})

test('regionOf tolerates null finding and null regions map without throwing', () => {
  assert.equal(regionOf(null, new Map()), undefined)
  assert.equal(regionOf({ containerId: '1' }, null), undefined)
  assert.equal(regionOf(undefined, undefined), undefined)
})
