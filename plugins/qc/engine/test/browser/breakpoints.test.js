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

test('near-duplicate widths are preserved not collapsed - decision 1: keep all discovered boundaries', () => {
  const css = `
    @media (min-width: 767px) { .a { color: red } }
    @media (min-width: 768px) { .b { color: blue } }
    @media (min-width: 769px) { .c { color: green } }
  `
  const widths = extractMediaWidths(css).sort((a, b) => a - b)
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
  const widths = extractMediaWidths(css)
  // 0px, 100px, 239px should be filtered because < 240; 240px should be included
  assert.ok(!widths.includes(0), 'should exclude 0px')
  assert.ok(!widths.includes(100), 'should exclude 100px')
  assert.ok(!widths.includes(239), 'should exclude 239px')
  assert.ok(widths.includes(240), 'should include 240px')
})

test('em-based media queries are ignored because we cannot reliably convert without base font size', () => {
  // Decision: ignore em-based queries because conversion requires knowing base font size
  const emOnlyCss = '@media (min-width: 20em) { .a { color: red } }'
  assert.deepEqual(extractMediaWidths(emOnlyCss), [], 'should extract nothing from em-based query')

  // Mixed CSS with em and px - should only extract px
  const mixedCss = `
    @media (min-width: 20em) { .a { color: red } }
    @media (min-width: 768px) { .c { color: green } }
  `
  const widths = extractMediaWidths(mixedCss)
  assert.ok(widths.includes(768), 'should include px-based 768px')
  assert.ok(!widths.some(w => w === 320 || w === 16), 'should not attempt to convert em to px')
})

test('decimal widths are floored to integers', () => {
  const css = `
    @media (min-width: 991.98px) { .a { color: red } }
    @media (max-width: 1025.5px) { .b { color: blue } }
  `
  const widths = extractMediaWidths(css).sort((a, b) => a - b)
  assert.ok(widths.includes(991), 'should include floored 991.98 as 991')
  assert.ok(widths.includes(1025), 'should include floored 1025.5 as 1025')
  assert.ok(!widths.includes(992), 'should not include rounded value')
  assert.ok(!widths.includes(1026), 'should not include rounded value')
})
