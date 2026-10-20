import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPayload, push, nonEnglishFields } from '../src/push.js'
import { defectIdentity } from '../src/report/json.js'

const f = (o) => ({ rule: 'E3', title: 'target', severity: 'major', confidence: 'high', engine: 'static', selector: 'a', found: 'x', expected: 'y', page: 'https://ex.com/a/', ...o })
const run = () => {
  const a = f({}), b = f({ page: 'https://ex.com/b/', where: 'footer' }), h = f({ rule: 'J3', confidence: 'heuristic', found: 'contrast' })
  const m = { ...f({ rule: 'H16', found: 'quote times', engine: 'claude', check: 'content', id: 'M1' }), review: { verdict: 'confirmed', note: 'n' } }
  const fp = { ...f({ rule: 'E1', found: 'bot' }), review: { verdict: 'false-positive', note: 'opens' } }
  return {
    dir: '/nowhere', review: { summary: 'Cleaning company' },
    input: { host: 'ex.com', env: 'prod', envReason: 'live', pages: 10, ranAt: 1792507215451, diff: { added: [1], fixed: [], remaining: [] } },
    kept: [a, b, h, m], rejected: [fp],
    manual: { checks: [{ check: 'menu', page: 'https://ex.com/', width: 360, status: 'ok', checked: 'fine', shots: ['visual/manual-0-0.png'] }], findings: [m] },
    ids: { [defectIdentity(a)]: 'D1', [defectIdentity(h)]: 'D2', [defectIdentity(fp)]: 'D3' },
  }
}

test('buildPayload sends results, not HTML: one entry per defect with all its pages, ids kept', () => {
  const { payload, files } = buildPayload(run())
  assert.equal(payload.host, 'ex.com')
  assert.equal(payload.about, 'Cleaning company')
  assert.deepEqual(payload.defects.map(d => d.code), ['D1', 'D2', 'M1', 'D3'])
  const d1 = payload.defects[0]
  assert.deepEqual(d1.pages, [{ url: 'https://ex.com/a/', where: null }, { url: 'https://ex.com/b/', where: 'footer' }])
  assert.equal(payload.defects[3].review.verdict, 'false-positive')
  assert.equal(payload.stats.distinct.major, 2, 'D1 and M1 count; the heuristic and the false positive do not')
  assert.deepEqual(payload.manual[0].evidence, ['manual-0-0.png'])
  assert.equal(files.get('manual-0-0.png'), '/nowhere/visual/manual-0-0.png')
})

test('push needs credentials and reports the server error plainly', async () => {
  await assert.rejects(push('ex.com', { env: { HOME: '/nonexistent' } }), /no access to the reports site|no run for/)
})

test('nothing Cyrillic leaves for the reports site', () => {
  const { payload } = buildPayload(run())
  assert.deepEqual(nonEnglishFields(payload), [])
  payload.defects[0].review = { verdict: 'confirmed', note: 'ссылка битая' }
  payload.manual[0].checked = 'всё ок'
  assert.deepEqual(nonEnglishFields(payload), ['D1.review.note', 'manual.0.checked'])
})
