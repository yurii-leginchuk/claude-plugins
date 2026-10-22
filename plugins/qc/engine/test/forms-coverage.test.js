import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formCoverage } from '../src/review.js'
import { renderReport } from '../src/report/html.js'

const profile = { forms: [
  { id: null, pages: ['https://ex.com/'] },
  { id: 'gform_5', pages: ['https://ex.com/quote', 'https://ex.com/quote', 'https://ex.com/b'], fields: [{ label: 'First Name' }] },
  { id: 'gform_9', pages: ['https://ex.com/referral'], fields: [] },
  { id: 'gform_12', pages: ['https://ex.com/claims'], fields: [] },
] }

test('a form counts as checked when a check names it in any spelling', () => {
  const out = formCoverage(profile, [{ check: 'form', form: ['5'] }, { check: 'journey', form: ['form 12'] }])
  assert.deepEqual(out.map(f => [f.id, f.checked, f.pages]), [['gform_5', true, 2], ['gform_9', false, 1], ['gform_12', true, 1]])
})

test('the report lists forms nobody checked', () => {
  const forms = formCoverage(profile, [{ check: 'form', form: ['gform_5'] }])
  const html = renderReport({ host: 'ex.com', env: 'dev', envReason: 'x', pages: 3, findings: [], diff: { fixed: [], remaining: [], added: [] }, snapshotAgeDays: 0, source: 'sitemap', forms })
  assert.match(html, /Forms not checked by hand<\/b><span class="cnt">2 of 3 forms/)
  assert.match(html, /1 of 3 forms checked by hand/)
})
