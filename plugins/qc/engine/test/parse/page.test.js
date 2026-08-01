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
