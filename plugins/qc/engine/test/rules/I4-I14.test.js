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

// I4 tests
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

// I14 basic tests
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

// I14 false-positive prevention tests
test('I14 does not flag dev URL in query string', () => {
  const p = page({ links: [{ raw: 'https://cleaningny.com/redirect?next=https://evil-dev.test/x', href: 'https://cleaningny.com/redirect?next=https://evil-dev.test/x', selector: 'a' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 0)
})

test('I14 does not flag dev domain as prefix of different host', () => {
  const p = page({ links: [{ raw: 'https://foo.patest.website.evil.com/a', href: 'https://foo.patest.website.evil.com/a', selector: 'a' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 0)
})

// I14 true positive tests
test('I14 flags patest.website links', () => {
  const p = page({ links: [{ raw: 'https://x.patest.website/a', href: 'https://x.patest.website/a', selector: 'a' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 1)
})

test('I14 flags dev image URLs', () => {
  const p = page({ images: [{ src: 'https://foo-dev.example.com/i.jpg', selector: 'img' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 1)
})

test('I14 does not flag production URLs with dev in path', () => {
  const p = page({ links: [{ raw: 'https://cleaningny.com/services/', href: 'https://cleaningny.com/services/', selector: 'a' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 0)
})

test('I14 does not flag CDN URLs with dev in filename', () => {
  const p = page({ images: [{ src: 'https://cdn.example.com/dev-guide.pdf', selector: 'img' }] })
  assert.equal(I14.check(p, { env: 'prod' }).length, 0)
})

// DEV_HOST regex tests - dev domains (must be classified as dev)
test('dev-host regex matches starshep-dev.patest.website', () => {
  assert.equal(detectEnv({ host: 'starshep-dev.patest.website', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'dev')
})

test('dev-host regex matches starshep-dev.example.com', () => {
  assert.equal(detectEnv({ host: 'starshep-dev.example.com', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'dev')
})

test('dev-host regex matches acme-staging.com', () => {
  assert.equal(detectEnv({ host: 'acme-staging.com', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'dev')
})

test('dev-host regex matches staging.ex.com', () => {
  assert.equal(detectEnv({ host: 'staging.ex.com', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'dev')
})

test('dev-host regex matches dev.ex.com', () => {
  assert.equal(detectEnv({ host: 'dev.ex.com', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'dev')
})

// DEV_HOST regex tests - production domains (must NOT be classified as dev)
test('dev-host regex does not match devonshire.com', () => {
  assert.equal(detectEnv({ host: 'devonshire.com', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'prod')
})

test('dev-host regex does not match stagecoach.co.uk', () => {
  assert.equal(detectEnv({ host: 'stagecoach.co.uk', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'prod')
})

test('dev-host regex does not match contest.com', () => {
  assert.equal(detectEnv({ host: 'contest.com', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'prod')
})

test('dev-host regex does not match test-kitchen.com', () => {
  assert.equal(detectEnv({ host: 'test-kitchen.com', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'prod')
})

test('dev-host regex does not match stage-lighting.com', () => {
  assert.equal(detectEnv({ host: 'stage-lighting.com', pages: [{ url: 'https://h/1', robots: { index: true } }] }).env, 'prod')
})

// ---------------------------------------------------------------------------
// Review follow-up (Important 10): the spec's dev-side clause was never
// implemented. On dev, links and src pointing at the *production* domain are
// unreplaced absolute paths -- the dev site quietly serves and links
// production content, so what is under test is not what was built. Dev is the
// primary target environment for this engine, so this is the direction most
// likely to matter daily. It only fires when the run actually knows which host
// is production (a --prod flag or a sheet's Dev Link pairing).
// ---------------------------------------------------------------------------

const devSite = (extra = {}) => ({ env: 'dev', prodHost: 'cleaningny.com', ...extra })

test('I14 flags a link to the production domain when auditing dev', () => {
  const p = page({ links: [{ raw: 'https://cleaningny.com/services/', href: 'https://cleaningny.com/services/', selector: 'a.nav' }] })
  const f = I14.check(p, devSite())
  assert.equal(f.length, 1)
  assert.equal(f[0].severity, 'critical')
  assert.match(f[0].found, /link to prod/)
  assert.equal(f[0].selector, 'a.nav')
})

test('I14 flags an image served from the production domain when auditing dev', () => {
  const p = page({ images: [{ src: 'https://cleaningny.com/wp-content/uploads/hero.jpg', selector: 'img.hero' }] })
  const f = I14.check(p, devSite())
  assert.equal(f.length, 1)
  assert.match(f[0].found, /image from prod/)
})

test('I14 treats www and bare production hosts as the same host', () => {
  const p = page({ links: [{ raw: 'https://www.cleaningny.com/about/', href: 'https://www.cleaningny.com/about/', selector: 'a' }] })
  assert.equal(I14.check(p, devSite()).length, 1)
})

test('I14 emits nothing on dev when no production host is known, rather than guessing', () => {
  const p = page({
    links: [{ raw: 'https://cleaningny.com/services/', href: 'https://cleaningny.com/services/', selector: 'a' }],
    images: [{ src: 'https://cleaningny.com/i.jpg', selector: 'img' }],
  })
  assert.deepEqual(I14.check(p, { env: 'dev' }), [])
  assert.deepEqual(I14.check(p, { env: 'dev', prodHost: null }), [])
})

test('I14 on dev leaves ordinary dev-host and third-party links alone', () => {
  const p = page({
    links: [
      { raw: '/services/', href: 'https://acme-staging.com/services/', selector: 'a.internal' },
      { raw: 'https://facebook.com/x', href: 'https://facebook.com/x', selector: 'a.social' },
    ],
    images: [{ src: 'https://acme-staging.com/i.jpg', selector: 'img' }],
  })
  assert.deepEqual(I14.check(p, devSite()), [])
})

test('I14 on dev does not flag a production host that only appears in a query string', () => {
  const p = page({ links: [{ raw: '/go?next=https://cleaningny.com/x', href: 'https://acme-staging.com/go?next=https://cleaningny.com/x', selector: 'a' }] })
  assert.deepEqual(I14.check(p, devSite()), [])
})

test('I14 still stays silent when the environment is unknown, even with a prodHost', () => {
  const p = page({ links: [{ raw: 'https://cleaningny.com/', href: 'https://cleaningny.com/', selector: 'a' }] })
  assert.deepEqual(I14.check(p, { env: 'unknown', prodHost: 'cleaningny.com' }), [])
})

test('I14 on prod is unaffected by prodHost being present', () => {
  const p = page({ links: [{ raw: 'https://x.patest.website/a', href: 'https://x.patest.website/a', selector: 'a' }] })
  const f = I14.check(p, { env: 'prod', prodHost: 'cleaningny.com' })
  assert.equal(f.length, 1)
  assert.match(f[0].found, /link to dev/)
})
