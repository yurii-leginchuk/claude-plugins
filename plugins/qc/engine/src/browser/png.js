// Just enough PNG to compare two screen pieces: the 8-bit RGB/RGBA,
// non-interlaced files Chromium writes. Two captures of one section at
// sub-pixel different heights on the page differ by anti-aliasing only, so
// equal pixels are too strict: the pictures are compared as 8×8-block grey
// averages, where that noise is gone and a changed word or a moved icon is not.
import { readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { inflateSync, deflateSync, crc32 } from 'node:zlib'

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

// An 8-bit RGB/RGBA PNG back from decodePng's pixels (filter 0 on every row).
export function encodePng({ width, height, channels, data }) {
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0)
    return Buffer.concat([len, Buffer.from(type, 'latin1'), body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// The spot outlined on a picture: a 4 px red frame around box {x, y, w, h} (px), kept inside the picture.
export function markBox(file, box, out) {
  const img = decodePng(readFileSync(file))
  const { width, height, channels, data } = img
  const x0 = Math.max(0, Math.round(box.x) - 4), y0 = Math.max(0, Math.round(box.y) - 4)
  const x1 = Math.min(width - 1, Math.round(box.x + box.w) + 4), y1 = Math.min(height - 1, Math.round(box.y + box.h) + 4)
  if (x1 <= x0 || y1 <= y0) throw new Error(`box ${JSON.stringify(box)} is outside the ${width}×${height} picture`)
  const paint = (x, y) => { const i = (y * width + x) * channels; data[i] = 224; data[i + 1] = 36; data[i + 2] = 94; if (channels === 4) data[i + 3] = 255 }
  for (let t = 0; t < 4; t++) {
    for (let x = x0; x <= x1; x++) { paint(x, Math.min(y1, y0 + t)); paint(x, Math.max(y0, y1 - t)) }
    for (let y = y0; y <= y1; y++) { paint(Math.min(x1, x0 + t), y); paint(Math.max(x0, x1 - t), y) }
  }
  writeFileSync(out, encodePng(img))
  return out
}
