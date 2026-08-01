import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEnv } from '../../src/lib/env.js'

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
