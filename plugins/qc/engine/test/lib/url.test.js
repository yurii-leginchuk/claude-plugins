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
