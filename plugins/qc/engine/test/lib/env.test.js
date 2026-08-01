import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEnv, isDevHost } from '../../src/lib/env.js'

const pages = (n, noindex) => Array.from({ length: n }, (_, i) => ({
  url: `https://h/${i}`, robots: { index: !noindex, follow: true, raw: null },
}))

test('an explicit override wins', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(3), override: 'dev' }).env, 'dev')
})

test('being paired as the dev side wins over the hostname', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(3), pairedAsDev: true }).env, 'dev')
})

test('patest.website is recognised as dev', () => {
  assert.equal(detectEnv({ host: 'starshep-dev.patest.website', pages: pages(3) }).env, 'dev')
})

test('a staging segment is recognised as dev', () => {
  assert.equal(detectEnv({ host: 'staging.ex.com', pages: pages(3) }).env, 'dev')
})

test('mostly-noindex pages read as dev', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(10, true) }).env, 'dev')
})

test('a plain host with indexable pages reads as prod', () => {
  assert.equal(detectEnv({ host: 'cleaningny.com', pages: pages(10) }).env, 'prod')
})

test('no pages yields unknown', () => {
  assert.equal(detectEnv({ host: 'cleaningny.com', pages: [] }).env, 'unknown')
})

test('one all-noindex page does not conclude dev (insufficient sample)', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(1, true) }).env, 'unknown')
})

test('four all-noindex pages do not conclude dev (below threshold)', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(4, true) }).env, 'unknown')
})

test('five all-noindex pages conclude dev (minimum threshold)', () => {
  assert.equal(detectEnv({ host: 'ex.com', pages: pages(5, true) }).env, 'dev')
})

test('starshep-dev.example.com is recognised as dev', () => {
  assert.equal(detectEnv({ host: 'starshep-dev.example.com', pages: pages(1) }).env, 'dev')
})

test('acme-staging.com is recognised as dev', () => {
  assert.equal(detectEnv({ host: 'acme-staging.com', pages: pages(1) }).env, 'dev')
})

test('dev.ex.com is recognised as dev', () => {
  assert.equal(detectEnv({ host: 'dev.ex.com', pages: pages(1) }).env, 'dev')
})

// ---------------------------------------------------------------------------
// Review follow-up (Important 6): isDevHost matched `(^|[-.])` before each
// keyword, so a hyphen anywhere before "dev"/"test" was enough. That
// classified plausible production domains as dev -- and a dev classification
// silences I4 (noindex, Critical) on every page and disables I14 entirely, so
// a production site shipped with noindex would have passed QC in silence. The
// five pre-existing negative tests only probed the prefix direction
// (devonshire, contest, ...); the suffix direction was untested, which is
// exactly where the bug lived.
// ---------------------------------------------------------------------------

for (const host of ['quest-test.com', 'intelli-test.com', 'pro-dev.com', 'best-dev.io']) {
  test(`${host} is a production domain, not dev`, () => {
    const { env } = detectEnv({ host, pages: pages(10) })
    assert.equal(env, 'prod', `${host} must not be classified as dev`)
  })
}

test('isDevHost is directly false for the four production lookalikes', () => {
  for (const host of ['quest-test.com', 'intelli-test.com', 'pro-dev.com', 'best-dev.io']) {
    assert.equal(isDevHost(host), false, host)
  }
})

// "-dev" only counts in subdomain position, where another label follows the
// one it ends. That is what separates a real dev host from a brand name.
test('a hyphenated -dev label is dev in subdomain position and prod as the registrable domain', () => {
  assert.equal(Boolean(isDevHost('starshep-dev.example.com')), true)
  assert.equal(Boolean(isDevHost('client-dev.agency.co')), true)
  assert.equal(isDevHost('pro-dev.com'), false)
})

// -staging keeps its unconditional form: acme-staging.com is a staging site,
// and "staging" is not a brand word the way "dev" and "test" are.
test('acme-staging.com stays dev even though it is the registrable domain', () => {
  assert.equal(Boolean(isDevHost('acme-staging.com')), true)
})

test('whole-label keywords still read as dev', () => {
  for (const host of ['dev.ex.com', 'stage.ex.com', 'staging.ex.com', 'test.ex.com', 'x.patest.website']) {
    assert.equal(Boolean(isDevHost(host)), true, host)
  }
})
