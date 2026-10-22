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

test('popups, tabs, accordions and sliders are found once each and counted when a check names them', async () => {
  const { parsePage } = await import('../src/parse/page.js')
  const html = `<div data-jet-popup='{"attached-popup":"jet-popup-77"}'><a href="#">Inquire</a></div>
    <div class="elementor-element" data-id="ab12"><div class="e-n-accordion"><details><summary>What do you do?</summary></details></div></div>
    <div class="elementor-element" data-id="cd34"><div class="swiper"><div class="swiper">inner</div></div></div>`
  const parts = parsePage({ url: 'https://ex.com/', status: 200, html }).parts
  assert.deepEqual(parts.map(p => p.key), ['popup:77', 'accordion:ab12', 'slider:cd34'])
  const { partCoverage } = await import('../src/review.js')
  const out = partCoverage({ parts: parts.map(p => ({ ...p, pages: ['https://ex.com/'] })) }, [{ check: 'popup', part: ['popup:77'] }])
  assert.deepEqual(out.map(p => p.checked), [true, false, false])
})
