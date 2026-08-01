import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import rule from '../../src/rules/static/E4-tel-format.js'
import { runStaticRules, allRules } from '../../src/rules/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const rulesDir = join(here, '../../src/rules/static')

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

test('flags separators-only defect with existing country code at high confidence', () => {
  const f = rule.check(pageWith(['tel:+1-855-607-8758']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'E4')
  assert.equal(f[0].expected, 'tel:+18556078758')
  assert.equal(f[0].severity, 'major')
  assert.equal(f[0].confidence, 'high')
})

test('flags bare 10-digit number at heuristic confidence', () => {
  const f = rule.check(pageWith(['tel:7189690845']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].expected, 'tel:+<код страны><10 цифр>')
  assert.equal(f[0].confidence, 'heuristic')
})

test('ignores non-tel links', () => {
  const page = { url: 'https://ex.com/a', links: [
    { raw: '/about', protocol: null, selector: 'a', text: 'About' },
  ] }
  assert.deepEqual(rule.check(page, {}), [])
})

test('does not crash on an empty tel', () => {
  const f = rule.check(pageWith(['tel:']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'heuristic')
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

test('production registry has no test artifacts and valid rule contracts', async () => {
  // Assert no test artifact files
  const files = readdirSync(rulesDir).filter(f => f.endsWith('.js'))
  const testArtifactPattern = /^TEST-|\.test\.js$|\.stub\.js$|\.skip\.js$/
  const artifacts = files.filter(f => testArtifactPattern.test(f))
  assert.equal(artifacts.length, 0, `Found test artifacts in production: ${artifacts.join(', ')}`)

  // Assert every loaded rule has valid contract
  const rules = await allRules()
  for (const r of rules) {
    assert(typeof r.id === 'string' && r.id.length > 0, `Rule has invalid id: ${r.id}`)
    assert(['critical', 'major', 'minor', 'note'].includes(r.severity),
      `Rule ${r.id} has invalid severity: ${r.severity}`)
    assert(typeof r.engine === 'string' && r.engine.length > 0,
      `Rule ${r.id} has invalid engine: ${r.engine}`)
    assert(typeof r.check === 'function', `Rule ${r.id} has invalid check: not a function`)
  }
})
