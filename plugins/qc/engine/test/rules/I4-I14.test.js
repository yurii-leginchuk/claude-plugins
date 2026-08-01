import { test } from 'node:test'
import assert from 'node:assert/strict'
import I4 from '../../src/rules/static/I4-noindex.js'
import I14 from '../../src/rules/static/I14-dev-artifacts.js'
import { detectEnv } from '../../src/lib/env.js'

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

test('I14 stays silent when environment is unknown', () => {
  const p = page({ links: [{ raw: 'https://x.patest.website/a', href: 'https://x.patest.website/a', selector: 'a' }] })
  assert.deepEqual(I14.check(p, { env: 'unknown' }), [])
})

test('dev-host regex does not match devonshire.com', () => {
  assert.equal(detectEnv({ host: 'devonshire.com', pages: [{ url: 'https://h/1', robots: { index: true, follow: true } }] }).env, 'prod')
})

test('dev-host regex does not match stagecoach.co.uk', () => {
  assert.equal(detectEnv({ host: 'stagecoach.co.uk', pages: [{ url: 'https://h/1', robots: { index: true, follow: true } }] }).env, 'prod')
})

test('dev-host regex does not match contest.com', () => {
  assert.equal(detectEnv({ host: 'contest.com', pages: [{ url: 'https://h/1', robots: { index: true, follow: true } }] }).env, 'prod')
})

test('dev-host regex matches starshep-dev.patest.website', () => {
  assert.equal(detectEnv({ host: 'starshep-dev.patest.website', pages: [{ url: 'https://h/1', robots: { index: true, follow: true } }] }).env, 'dev')
})

test('dev-host regex matches staging.ex.com', () => {
  assert.equal(detectEnv({ host: 'staging.ex.com', pages: [{ url: 'https://h/1', robots: { index: true, follow: true } }] }).env, 'dev')
})

test('dev-host regex does not match stage-lighting.com', () => {
  assert.equal(detectEnv({ host: 'stage-lighting.com', pages: [{ url: 'https://h/1', robots: { index: true, follow: true } }] }).env, 'prod')
})

test('dev-host regex does not match test-kitchen.com', () => {
  assert.equal(detectEnv({ host: 'test-kitchen.com', pages: [{ url: 'https://h/1', robots: { index: true, follow: true } }] }).env, 'prod')
})

test('DEV_URL regex flags patest.website links', () => {
  const p = page({ links: [{ raw: 'https://x.patest.website/a', href: 'https://x.patest.website/a', selector: 'a' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 1)
})

test('DEV_URL regex flags dev image URLs', () => {
  const p = page({ images: [{ src: 'https://foo-dev.example.com/i.jpg', selector: 'img' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 1)
})

test('DEV_URL regex does not flag production URLs with dev in path', () => {
  const p = page({ links: [{ raw: 'https://cleaningny.com/services/', href: 'https://cleaningny.com/services/', selector: 'a' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 0)
})

test('DEV_URL regex does not flag CDN URLs with dev in filename', () => {
  const p = page({ images: [{ src: 'https://cdn.example.com/dev-guide.pdf', selector: 'img' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 0)
})
