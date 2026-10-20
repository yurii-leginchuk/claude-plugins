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
  assert.match(f[0].found, /duplicate/)
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

test('I5 flags canonical differing only by trailing slash with explicit message', () => {
  const f = I5.check(mk({ url: 'https://ex.com/about', canonical: 'https://ex.com/about/' }), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].expected, 'https://ex.com/about')
  assert.match(f[0].found, /canonical with an extra slash/)
  assert.match(f[0].found, /https:\/\/ex\.com\/about\//)
})

test('I5 tolerates a missing site index', () => {
  assert.deepEqual(I5.check(mk({}), {}), [])
})

test('I6 treats whitespace-only title as empty', () => {
  assert.equal(I6.check(mk({ title: '   ' }), {}).length, 1)
})

test('I7 treats whitespace-only description as empty', () => {
  assert.equal(I7.check(mk({ metaDescription: '   ' }), {}).length, 1)
})

test('I7 tolerates a missing site index', () => {
  assert.deepEqual(I7.check(mk({}), {}), [])
})

test('I6 detects duplicates when one has padded whitespace', () => {
  const pages = [
    mk({ url: 'https://ex.com/a', title: 'Same Title' }),
    mk({ url: 'https://ex.com/b', title: '  Same Title  ' })
  ]
  const site = { index: buildIndex(pages) }
  const f = I6.check(pages[1], site)
  assert.equal(f.length, 1)
  assert.match(f[0].found, /duplicate/)
})

test('I7 detects duplicates when one has padded whitespace', () => {
  const pages = [
    mk({ url: 'https://ex.com/a', metaDescription: 'Same Desc' }),
    mk({ url: 'https://ex.com/b', metaDescription: '  Same Desc  ' })
  ]
  const site = { index: buildIndex(pages) }
  const f = I7.check(pages[1], site)
  assert.equal(f.length, 1)
})
