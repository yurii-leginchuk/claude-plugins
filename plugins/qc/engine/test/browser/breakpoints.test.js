import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMediaWidths, resolveBreakpoints, BASE_WIDTHS, MAX_WIDTHS }
  from '../../src/browser/breakpoints.js'

test('extracts min-width and max-width from media queries in px', () => {
  const css = `
    @media (max-width: 1024px) { .a { color: red } }
    @media screen and (min-width:768px) and (max-width:991.98px) { .b { color: blue } }
    @media (min-width: 1230px) { .c { display: none } }
  `
  const { widths } = extractMediaWidths(css)
  assert.deepEqual(widths.sort((a, b) => a - b), [768, 991, 1024, 1230])
})

test('ignores non-width media features and malformed css', () => {
  const { widths: w1 } = extractMediaWidths('@media print { .x { color: red } }')
  assert.deepEqual(w1, [])

  const { widths: w2 } = extractMediaWidths('@media (min-height: 600px) { .x{} }')
  assert.deepEqual(w2, [])

  const { widths: w3 } = extractMediaWidths('not css at all {{{')
  assert.deepEqual(w3, [])
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
  const { widths, dropped, unparseable } = resolveBreakpoints({
    cssTexts: ['@media (min-width:999px){.a{}}'], override: [375, 1280],
  })
  assert.deepEqual(widths, [375, 1280])
  assert.deepEqual(dropped, [])
  assert.deepEqual(unparseable, [])
})

test('no css yields exactly the base set', () => {
  assert.deepEqual(resolveBreakpoints({ cssTexts: [] }).widths, [...BASE_WIDTHS].sort((a, b) => a - b))
})

test('near-duplicate widths are preserved not collapsed - decision 1: keep all discovered boundaries', () => {
  const css = `
    @media (min-width: 767px) { .a { color: red } }
    @media (min-width: 768px) { .b { color: blue } }
    @media (min-width: 769px) { .c { color: green } }
  `
  const { widths } = extractMediaWidths(css)
  // We expect 767, 768, 769 all to be extracted
  assert.ok(widths.includes(767), 'should include 767')
  assert.ok(widths.includes(768), 'should include 768')
  assert.ok(widths.includes(769), 'should include 769')
})

test('zero and sub-minimum widths are filtered out', () => {
  const css = `
    @media (min-width: 0px) { .a { color: red } }
    @media (min-width: 100px) { .b { color: blue } }
    @media (min-width: 239px) { .c { color: green } }
    @media (min-width: 240px) { .d { color: yellow } }
  `
  const { widths } = extractMediaWidths(css)
  // 0px, 100px, 239px should be filtered because < 240; 240px should be included
  assert.ok(!widths.includes(0), 'should exclude 0px')
  assert.ok(!widths.includes(100), 'should exclude 100px')
  assert.ok(!widths.includes(239), 'should exclude 239px')
  assert.ok(widths.includes(240), 'should include 240px')
})

test('em-based media queries are converted at 16px (initial font size)', () => {
  // Per CSS Media Queries spec, em in @media resolves against initial (browser default) font size
  const css = `
    @media (min-width: 36em) { .a { color: red } }
    @media (min-width: 48em) { .b { color: blue } }
  `
  const { widths } = extractMediaWidths(css)
  assert.ok(widths.includes(576), 'should convert 36em to 576px (36 * 16)')
  assert.ok(widths.includes(768), 'should convert 48em to 768px (48 * 16)')
})

test('Bootstrap 4 em breakpoints are correctly converted to px values', () => {
  // Bootstrap 4 uses em-based breakpoints: 576, 768, 992, 1200px
  // which are expressed as 36em, 48em, 62em, 75em
  const css = `
    @media (min-width: 36em) { }
    @media (min-width: 48em) { }
    @media (min-width: 62em) { }
    @media (min-width: 75em) { }
  `
  const { widths } = extractMediaWidths(css)
  // 36 * 16 = 576, 48 * 16 = 768, 62 * 16 = 992, 75 * 16 = 1200
  assert.ok(widths.includes(576), 'Bootstrap 4: 36em = 576px')
  assert.ok(widths.includes(768), 'Bootstrap 4: 48em = 768px')
  assert.ok(widths.includes(992), 'Bootstrap 4: 62em = 992px')
  assert.ok(widths.includes(1200), 'Bootstrap 4: 75em = 1200px')
})

test('em breakpoints contribute both-sides when passed to resolveBreakpoints', () => {
  // Verify that em-derived widths generate W and W-1 just like px widths
  const css = '@media (min-width: 48em) { }'
  const { widths } = resolveBreakpoints({ cssTexts: [css] })
  // 48em = 768px, should add both 768 and 767
  assert.ok(widths.includes(768), 'should include 768px from 48em')
  assert.ok(widths.includes(767), 'should include 767px (768 - 1)')
})

test('rem units are converted like em (16px)', () => {
  const css = `
    @media (min-width: 30rem) { .a { } }
    @media (max-width: 45rem) { .b { } }
  `
  const { widths } = extractMediaWidths(css)
  assert.ok(widths.includes(480), 'should convert 30rem to 480px (30 * 16)')
  assert.ok(widths.includes(720), 'should convert 45rem to 720px (45 * 16)')
})

test('decimal widths are floored to integers', () => {
  const css = `
    @media (min-width: 991.98px) { .a { color: red } }
    @media (max-width: 1025.5px) { .b { color: blue } }
  `
  const { widths } = extractMediaWidths(css)
  assert.ok(widths.includes(991), 'should include floored 991.98 as 991')
  assert.ok(widths.includes(1025), 'should include floored 1025.5 as 1025')
  assert.ok(!widths.includes(992), 'should not include rounded value')
  assert.ok(!widths.includes(1026), 'should not include rounded value')
})

test('unsupported units (vw, ch, pt, etc) are tracked in unparseable field', () => {
  const css = `
    @media (min-width: 100vw) { .a { } }
    @media (min-width: 50ch) { .b { } }
    @media (min-width: 12pt) { .c { } }
  `
  const { widths, unparseable } = extractMediaWidths(css)
  // Should have no widths from unsupported units
  assert.equal(widths.length, 0)
  // Should track all three in unparseable
  assert.equal(unparseable.length, 3)
  assert.ok(unparseable.some(u => u.includes('100vw')))
  assert.ok(unparseable.some(u => u.includes('50ch')))
  assert.ok(unparseable.some(u => u.includes('12pt')))
})

test('vw-based media queries do not silently vanish; they appear in unparseable', () => {
  const css = '@media (min-width: 90vw) { .a { } }'
  const { widths, unparseable } = resolveBreakpoints({ cssTexts: [css] })
  // Should only have base widths, no vw-derived widths
  assert.deepEqual(widths, [...BASE_WIDTHS].sort((a, b) => a - b))
  // Should report the vw query as unparseable
  assert.ok(unparseable.length > 0, 'should report vw query in unparseable')
  assert.ok(unparseable.some(u => u.includes('90vw')))
})

test('mixed px and vw queries: px are extracted, vw tracked', () => {
  const css = `
    @media (min-width: 768px) { }
    @media (min-width: 90vw) { }
  `
  const { widths, unparseable } = extractMediaWidths(css)
  assert.ok(widths.includes(768), 'should extract px-based 768')
  assert.equal(unparseable.length, 1, 'should track vw as unparseable')
  assert.ok(unparseable[0].includes('90vw'))
})

test('override filters out non-numeric values gracefully', () => {
  const { widths, unparseable } = resolveBreakpoints({
    override: [375, NaN, 1280, undefined, 800]
  })
  // Should only include the valid numbers: 375, 1280, 800
  assert.deepEqual(widths, [375, 800, 1280])
  assert.equal(unparseable.length, 0, 'override path has no unparseable')
})

// --- The live CSS shape (review, browser-pass fix wave) --------------------
//
// cleaningny.com declares its boundaries from both sides, the way a
// WordPress/Elementor/Bootstrap stack does. The old ranking kept
// [360,640,641,766,767,768,1023,1024,1025,1440] and dropped [639,1199,1200]:
// four discretionary slots went to widths within 2px of a base width -- one
// of them, 766, invented by the blind "W and W-1" expansion, since nothing
// declares it -- while 1200, the Bootstrap and Elementor desktop boundary and
// the one width on the list a desktop layout can actually break at, was
// dropped.
test('against the live CSS shape, the 1200 desktop boundary survives the budget', () => {
  const cssTexts = [
    // theme.css -- Elementor's mobile/tablet boundaries, declared both sides
    `@media (max-width:640px){.a{}} @media (min-width:641px){.b{}}
     @media (max-width:767px){.c{}} @media (min-width:768px){.d{}}
     @media (max-width:1024px){.e{}} @media (min-width:1025px){.f{}}`,
    // elementor-frontend.css -- the same mobile/tablet boundaries again
    `@media (max-width:767px){.g{}} @media (min-width:768px){.h{}}
     @media (max-width:1024px){.i{}} @media (min-width:1025px){.j{}}`,
    // bootstrap-grid.css and the theme's own desktop rules -- 1200, declared
    // by more than one stylesheet
    '@media (min-width:1200px){.k{}}',
    '@media (min-width:1200px){.l{}}',
  ]
  const { widths, dropped } = resolveBreakpoints({ cssTexts })

  assert.ok(widths.includes(1200), '1200 must be measured, not dropped')
  assert.ok(widths.includes(1199), 'and so must the other side of that boundary')
  assert.ok(!dropped.includes(1200))

  assert.ok(!widths.includes(766),
    '766 is declared by nothing; it only ever existed as a second copy of the 767|768 boundary')
  assert.ok(!widths.includes(1023),
    '1023 is declared by nothing; the 1024|1025 boundary is one boundary, not two')

  assert.ok(widths.length <= MAX_WIDTHS, 'still within the budget')
  for (const b of BASE_WIDTHS) assert.ok(widths.includes(b), `base ${b} must survive`)
})

test('a boundary is kept whole or not at all - never just the side that already worked', () => {
  // Nine 2-slot boundaries, none adjacent to a base width, for six slots:
  // three fit, and each keeps BOTH of its sides.
  const cssTexts = Array.from({ length: 9 }, (_, i) => `@media (min-width:${500 + i * 61}px){.a{}}`)
  const { widths, dropped } = resolveBreakpoints({ cssTexts })
  const discretionary = widths.filter(w => !BASE_WIDTHS.includes(w))
  assert.equal(discretionary.length % 2, 0, 'boundaries are kept in pairs')
  for (const w of discretionary) {
    assert.ok(
      discretionary.includes(w - 1) || discretionary.includes(w + 1),
      `${w} was kept without the other side of its boundary`,
    )
  }
  assert.ok(dropped.length > 0)
})

// The spec's second ranking criterion. Two boundaries, equally far from a
// base width and equally expensive: the one several stylesheets declare is
// the one the theme actually leans on.
test('a boundary declared by several stylesheets outranks one declared once', () => {
  const rare = '@media (min-width:600px){.a{}}'
  const common = '@media (min-width:1272px){.b{}}'
  // 600 and 1272 are both 168px from their nearest base width, so distance
  // cannot separate them -- only frequency can.
  assert.equal(
    Math.min(...BASE_WIDTHS.map(b => Math.abs(b - 600))),
    Math.min(...BASE_WIDTHS.map(b => Math.abs(b - 1272))),
  )
  // Enough near-base boundaries to leave room for exactly one of the two.
  const filler = `@media (max-width:767px){.c{}} @media (min-width:768px){.d{}}
                  @media (max-width:1024px){.e{}} @media (min-width:1025px){.f{}}
                  @media (max-width:359px){.g{}} @media (min-width:360px){.h{}}
                  @media (max-width:1439px){.i{}} @media (min-width:1440px){.j{}}`
  const { widths } = resolveBreakpoints({ cssTexts: [filler, rare, common, common, common] })
  assert.ok(widths.includes(1272), 'the frequently declared boundary is kept')
  assert.ok(widths.includes(1271), 'whole, both sides')
  assert.ok(!widths.includes(600), 'the once-declared one is what gives way')
})

test('extractMediaWidths carries how often each width was declared', () => {
  const { counts } = extractMediaWidths(`
    @media (min-width:768px){.a{}}
    @media (min-width:768px){.b{}}
    @media (min-width:1200px){.c{}}
  `)
  assert.equal(counts[768], 2)
  assert.equal(counts[1200], 1)
})

test('unparseable is empty when all queries are parseable or absent', () => {
  const { widths, unparseable } = resolveBreakpoints({
    cssTexts: ['@media (min-width: 768px) { }', '@media print { }']
  })
  assert.equal(unparseable.length, 0, 'no unparseable units in this CSS')
})
