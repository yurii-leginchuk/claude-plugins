// Just enough PNG to compare two screen pieces: the 8-bit RGB/RGBA,
// non-interlaced files Chromium writes. Two captures of one section at
// sub-pixel different heights on the page differ by anti-aliasing only, so
// equal pixels are too strict: the pictures are compared as 8×8-block grey
// averages, where that noise is gone and a changed word or a moved icon is not.
import { readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

export function pngSize(file) {
  const b = Buffer.alloc(8)
  const fd = openSync(file, 'r')
  try { readSync(fd, b, 0, 8, 16) } finally { closeSync(fd) }
  return { width: b.readUInt32BE(0), height: b.readUInt32BE(4) }
}

export function decodePng(buf) {
  let pos = 8
  let width, height, channels
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0 || ![2, 6].includes(body[9])) throw new Error('png: only 8-bit RGB/RGBA, not interlaced')
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = y ? out[(y - 1) * stride + x] : 0
      const c = y && x >= channels ? out[(y - 1) * stride + x - channels] : 0
      let v = raw[src + x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      out[y * stride + x] = v & 255
    }
  }
  return { width, height, channels, data: out }
}

const BLOCK = 8
// Grey per pixel row and 8 px column: enough to line two pieces up by a row.
export function fingerprint(file) {
  const { width, height, channels, data } = decodePng(readFileSync(file))
  const cols = Math.ceil(width / BLOCK)
  const sum = new Float64Array(cols * height), n = new Uint16Array(cols * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const k = y * cols + ((x / BLOCK) | 0)
      sum[k] += (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10
      n[k]++
    }
  }
  return { width, height, cols, grey: Uint8Array.from(sum, (v, k) => Math.round(v / n[k])) }
}

// The same picture: one width, heights two pixels apart at most, and no
// 8×8 block off by more than a few grey levels from the block in the other
// picture at the same place or one row up or down: one section at y .3 and
// at y .7 snaps some of its lines of text a row apart. The page's height is
// whole pixels and a section's top is not, hence the height slack.
export function samePicture(a, b, tolerance = 6) {
  if (a.width !== b.width || Math.abs(a.height - b.height) > 2) return false
  const { cols } = a
  const h = Math.min(a.height, b.height)
  const block = (fp, row0, c) => { let v = 0; for (let y = row0; y < row0 + BLOCK; y++) v += fp.grey[y * cols + c]; return v / BLOCK }
  for (let r = 1; r + BLOCK + 1 < h; r += BLOCK) {
    for (let c = 0; c < cols; c++) {
      const v = block(a, r, c)
      if ([0, -1, 1].every(s => Math.abs(v - block(b, r + s, c)) > tolerance)) return false
    }
  }
  return true
}
