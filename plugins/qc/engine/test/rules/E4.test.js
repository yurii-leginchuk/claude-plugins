import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import rule from '../../src/rules/static/E4-tel-format.js'
import E4 from '../../src/rules/static/E4-tel-format.js'
import E5 from '../../src/rules/static/E5-duplicate-plus-one.js'
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

const telPage = (raw) => pageWith([raw])

test('clean E.164 number: no finding', () => {
  assert.deepEqual(rule.check(pageWith(['tel:+17189690845']), {}), [])
})

test('separators with country code (tel:+1-855-607-8758): high confidence', () => {
  const f = rule.check(pageWith(['tel:+1-855-607-8758']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].expected, 'tel:+18556078758')
  assert.equal(f[0].confidence, 'high')
})

test('11+ digits without + (tel:18556078758): high confidence', () => {
  const f = rule.check(pageWith(['tel:18556078758']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].expected, 'tel:+18556078758')
  assert.equal(f[0].confidence, 'high')
})

test('bare 10-digit (tel:7189690845): heuristic confidence', () => {
  const f = rule.check(pageWith(['tel:7189690845']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].expected, 'tel:+<country code><10 digits>')
  assert.equal(f[0].confidence, 'heuristic')
})

test('too few digits (tel:123): high confidence, generic placeholder', () => {
  const f = rule.check(pageWith(['tel:123']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'tel:123')
  assert.equal(f[0].expected, 'tel:+<country code><number>')
  assert.equal(f[0].confidence, 'high')
})

test('+ with insufficient digits (tel:+1234567): high confidence, generic placeholder', () => {
  const f = rule.check(pageWith(['tel:+1234567']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'tel:+1234567')
  assert.equal(f[0].expected, 'tel:+<country code><number>')
  assert.equal(f[0].confidence, 'high')
})

test('too many digits (tel:12345678901234567): high confidence, generic placeholder', () => {
  const f = rule.check(pageWith(['tel:12345678901234567']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'tel:12345678901234567')
  assert.equal(f[0].expected, 'tel:+<country code><number>')
  assert.equal(f[0].confidence, 'high')
})

test('empty tel (tel:): high confidence, generic placeholder', () => {
  const f = rule.check(pageWith(['tel:']), {})
  assert.equal(f.length, 1)
  assert.equal(f[0].found, 'tel:')
  assert.equal(f[0].expected, 'tel:+<country code><number>')
  assert.equal(f[0].confidence, 'high')
})

test('ignores non-tel links', () => {
  const page = { url: 'https://ex.com/a', links: [
    { raw: '/about', protocol: null, selector: 'a', text: 'About' },
  ] }
  assert.deepEqual(rule.check(page, {}), [])
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

// ---------------------------------------------------------------------------
// Review follow-up (Important 5): E4 and E5 look at the same hrefs and used to
// contradict each other. For `tel:+1+17189690845` E4's hasCountryCode branch
// ("12 digits with a + -- just strip separators") proposed
// `tel:+117189690845`, still doubled, while E5 proposed the correct
// `tel:+17189690845` -- both at major. Two different `expected` values for one
// href is worse than saying nothing, so E5 owns the doubled shape and E4 stays
// out of it. Assert that as a property over every doubled input, not just one.
// ---------------------------------------------------------------------------

// Doubled AND nothing else wrong: the '+'/digit duplication is the entire
// defect, so E4 stays fully silent and leaves the whole finding to E5.
const DOUBLED_ONLY = [
  'tel:+1+17189690845',
  'tel:+117189690845',
  'tel:++17189690845',
]

// Doubled AND separator-malformed (hyphens/spaces survive the doubling):
// the two examples named in the brief, plus the pre-existing double-plus-
// with-spaces case. E4 now confirms "this value is not clean" itself
// (`expected: null`, high confidence) rather than letting that certain,
// directly-observable defect disappear into E5's finding -- which is only
// 'heuristic' confidence when the doubling is the inferred (12-digit,
// leading "11") kind.
const DOUBLED_AND_MALFORMED = [
  'tel:+1-1-718-969-0845',
  'tel:+1 1 718 969 0845',
  'tel:+1 +1 718 969 0845',
]

const DOUBLED = [...DOUBLED_ONLY, ...DOUBLED_AND_MALFORMED]

test('E4 and E5 never emit contradictory expected values for the same tel: input', () => {
  for (const raw of [...DOUBLED, 'tel:+17189690845', 'tel:1-855-607-8758', 'tel:7189690845', 'tel:123', 'tel:']) {
    const p = telPage(raw)
    const e4 = E4.check(p, {})
    const e5 = E5.check(p, {})
    // `expected: null` (E4's own "no proposal of mine" marker on the
    // separator-malformed-and-doubled branch) means "no opinion", not a
    // competing opinion -- it must not count as a contradiction against
    // whatever E5 proposes for the same href.
    const expectations = new Set([...e4, ...e5].map(f => f.expected).filter(e => e !== null))
    assert.ok(
      expectations.size <= 1,
      `both rules fired on ${raw} with different expectations: ${[...expectations].join(' vs ')}`
    )
  }
})

test('E4 stays fully silent on a doubled country code with nothing else wrong; E5 owns it and proposes the correction', () => {
  for (const raw of DOUBLED_ONLY) {
    assert.deepEqual(E4.check(telPage(raw), {}), [], `E4 should not fire on ${raw}`)
    const e5 = E5.check(telPage(raw), {})
    assert.equal(e5.length, 1, `E5 should own ${raw}`)
    assert.equal(e5[0].expected, 'tel:+17189690845', `E5 must strip the doubled code in ${raw}`)
  }
})

test('E4 fires (no expected) on a doubled value that is also separator-malformed; E5 still owns the correction', () => {
  for (const raw of DOUBLED_AND_MALFORMED) {
    const e4 = E4.check(telPage(raw), {})
    assert.equal(e4.length, 1, `E4 should fire on ${raw}`)
    assert.equal(e4[0].found, raw)
    assert.equal(e4[0].expected, null, `E4 must not propose a correction for ${raw}`)
    assert.equal(e4[0].confidence, 'high', `the separator defect itself is directly observed, not inferred`)
    assert.equal(e4[0].severity, 'major')

    const e5 = E5.check(telPage(raw), {})
    assert.equal(e5.length, 1, `E5 should still own the correction for ${raw}`)
    assert.equal(e5[0].expected, 'tel:+17189690845', `E5 must strip the doubled code in ${raw}`)
  }
})

test('E4 fires on the two brief-named cases: tel:+1-1-718-969-0845 and tel:+1 1 718 969 0845', () => {
  for (const raw of ['tel:+1-1-718-969-0845', 'tel:+1 1 718 969 0845']) {
    const e4 = E4.check(telPage(raw), {})
    assert.equal(e4.length, 1)
    assert.equal(e4[0].expected, null)
    assert.equal(e4[0].confidence, 'high')
    assert.equal(e4[0].severity, 'major')
  }
})

test('E5 marks the inferred doubled-leading-1 branch heuristic and the observed two-plus branch high', () => {
  const inferred = E5.check(telPage('tel:+117189690845'), {})
  assert.equal(inferred[0].confidence, 'heuristic', '12 digits starting "11" is inferred, not observed')
  const observed = E5.check(telPage('tel:+1+17189690845'), {})
  assert.equal(observed[0].confidence, 'high', 'two literal "+" characters are directly observed')
})
