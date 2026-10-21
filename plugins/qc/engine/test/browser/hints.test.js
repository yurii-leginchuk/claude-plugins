import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingsForContent } from './harness.js'

const page = (body) => `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif}</style></head><body>${body}</body></html>`

test('B9 finds an icon touching its text, and stays silent when there is a gap', async () => {
  const icon = '<svg width="16" height="16"><rect width="16" height="16"/></svg>'
  const tight = await findingsForContent(page(`<span id="pill" style="display:inline-flex;gap:0">${icon}<span>Insurance</span></span>`), { only: ['B9'] })
  assert.equal(tight.length, 1)
  assert.match(tight[0].found, /0px from the text/)
  assert.ok(Number.isFinite(tight[0].y))
  const spaced = await findingsForContent(page(`<span style="display:inline-flex;gap:8px">${icon}<span>Insurance</span></span>`), { only: ['B9'] })
  assert.deepEqual(spaced, [])
})

test('B5 finds text past its box, not text that fits', async () => {
  const over = await findingsForContent(page('<div style="width:80px;background:#eee;white-space:nowrap">A very long label here</div>'), { only: ['B5'] })
  assert.equal(over.length, 1)
  assert.match(over[0].found, /past the right edge/)
  assert.deepEqual(await findingsForContent(page('<div style="width:400px;background:#eee">Fits</div>'), { only: ['B5'] }), [])
})

test('B3 finds a big empty block, not one with a picture or text', async () => {
  const empty = await findingsForContent(page('<p>Top</p><section style="height:400px;background:#ddd"></section>'), { only: ['B3'] })
  assert.equal(empty.length, 1)
  assert.match(empty[0].found, /400px block/)
  assert.deepEqual(await findingsForContent(page('<section style="height:400px">Text</section>'), { only: ['B3'] }), [])
})
