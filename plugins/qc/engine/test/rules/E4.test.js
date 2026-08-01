import { test } from 'node:test'
import assert from 'node:assert/strict'
import rule from '../../src/rules/static/E4-tel-format.js'
import { runStaticRules, allRules } from '../../src/rules/index.js'

const pageWith = (raws) => ({
  url: 'https://ex.com/a',
  links: raws.map((raw, i) => ({
    raw, href: null, protocol: 'tel:', rel: null, target: null,
    text: raw, internal: false, selector: `a.phone-${i}`,
  })),
})

test('accepts a clean E.164 number', () => {
  assert.deepEqual(rule.check(pageWith(['tel:+17189690845']), {}), [])
})

test('flags dashes, spaces and dots', () => {
  const f = rule.check(pageWith(['tel:855-607-8758']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'E4')
  assert.equal(f[0].expected, 'tel:+18556078758')
  assert.equal(f[0].severity, 'major')
})

test('flags a missing country code', () => {
  const f = rule.check(pageWith(['tel:7189690845']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].expected, 'tel:+17189690845')
})

test('ignores non-tel links', () => {
  const page = { url: 'https://ex.com/a', links: [
    { raw: '/about', protocol: null, selector: 'a', text: 'About' },
  ] }
  assert.deepEqual(rule.check(page, {}), [])
})

test('does not crash on an empty tel', () => {
  assert.equal(rule.check(pageWith(['tel:']), {}).length, 1)
})

test('runStaticRules catches throwing rules and emits note-severity findings', async () => {
  const throwingStub = {
    id: 'TEST-throws',
    title: 'Test Rule That Throws',
    severity: 'major',
    engine: 'static',
    check() {
      throw new Error('intentional test error')
    },
  }
  const pages = [{ url: 'https://ex.com/test', links: [] }]
  const site = { host: 'ex.com' }
  const findings = await runStaticRules(pages, site, { only: ['TEST-throws'], rules: [throwingStub] })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'TEST-throws')
  assert.equal(findings[0].severity, 'note')
  assert.match(findings[0].found, /rule crashed/)
})

test('production registry contains only expected rules', async () => {
  const rules = await allRules()
  const ruleIds = rules.map(r => r.id).sort()
  assert.deepEqual(ruleIds, ['E4'])
})
