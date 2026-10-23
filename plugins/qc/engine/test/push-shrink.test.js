import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { encodePng } from '../src/browser/png.js'
import { shrinkLarge, MAX_EVIDENCE_BYTES } from '../src/push.js'

test('a PNG over the server limit goes as WebP under a .webp name, and the payload follows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qc-shrink-'))
  const width = 700; const height = 400
  const data = randomBytes(width * height * 3)
  const path = join(dir, 'tile-T1.png')
  writeFileSync(path, encodePng({ width, height, channels: 3, data }))
  assert.ok(statSync(path).size > MAX_EVIDENCE_BYTES, 'the fixture is big enough')
  const files = new Map([['tile-T1.png', path], ['small.png', path.replace('tile-T1', 'small')]])
  const payload = { defects: [{ evidence: ['tile-T1.png'] }], manual: [{ evidence: ['tile-T1.png', 'other.png'] }] }
  await shrinkLarge(files, payload)
  assert.equal(files.has('tile-T1.png'), false)
  const webp = files.get('tile-T1.webp')
  assert.ok(statSync(webp).size <= MAX_EVIDENCE_BYTES)
  assert.equal(readFileSync(webp).subarray(8, 12).toString(), 'WEBP')
  assert.deepEqual(payload.manual[0].evidence, ['tile-T1.webp', 'other.png'])
  assert.deepEqual(payload.defects[0].evidence, ['tile-T1.webp'])
})
