// A full-page picture of every page at every width, whether or not anything
// was found on it: the report's visual block lets a human scroll through the
// site the way QA does, instead of seeing only the crops of known defects.
//
// WebP from Chromium itself (CDP), not PNG or Playwright's JPEG: measured on
// cleaningny.com, a full page at q45 is 38–46% smaller than JPEG q60 and the
// text stays sharp -- the report ships ~130 of them. JPEG is the fallback
// when CDP is not there. Files live at ~/.qc-cache/<host>/pages/<sha1(url|width)>.webp
// and are overwritten by every pass, so the picture is the page as last measured.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { snapshotDir } from '../crawl/store.js'

export const MAX_SHOT_HEIGHT = 12000
const QUALITY = 45

export function pageShotPath(host, url, width, ext = 'webp') {
  const name = createHash('sha1').update(`${url}|${width}`).digest('hex').slice(0, 16) + '.' + ext
  return join(snapshotDir(host), 'pages', name)
}

export async function capturePage(page, { host, url, width }) {
  mkdirSync(join(snapshotDir(host), 'pages'), { recursive: true })
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
  // Chromium cannot paint taller than ~16k px; a very long page is cut, and
  // the visual block says so.
  const shown = Math.min(height, MAX_SHOT_HEIGHT)
  const cut = height > MAX_SHOT_HEIGHT
  try {
    const cdp = await page.context().newCDPSession(page)
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'webp', quality: QUALITY, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: shown, scale: 1 },
    })
    await cdp.detach().catch(() => {})
    const path = pageShotPath(host, url, width)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return { path, height, cut }
  } catch {
    const path = pageShotPath(host, url, width, 'jpg')
    await page.screenshot({ path, type: 'jpeg', quality: 60, fullPage: true, ...(cut ? { clip: { x: 0, y: 0, width, height: shown } } : {}) })
    return { path, height, cut }
  }
}

// The same page cut into pieces Claude looks at one by one, in PNG at full
// size: a whole-page picture is shrunk when read and q45 blurs a 1–2 px gap,
// so small defects only show in a piece. The first piece is the first screen
// as the visitor sees it (fixed bars included); the rest of the page is cut
// at the tops of its sections with fixed elements hidden, so a footer or a
// testimonials block is the same picture on every page. Files are named by
// the hash of their pixels: a piece shared by many pages is stored, listed
// and looked at once. A section taller than a piece is split with overlap.
export const TILE = { height: 1000, overlap: 100, min: 150 }

export function tilePath(host, width, hash) {
  return join(snapshotDir(host), 'tiles', `${width}-${hash}.png`)
}

// In the page: what makes two captures of one page differ, or show what a
// visitor never sees -- lazy images not yet in, entrance animations not run,
// a carousel moving between two pieces.
async function settle() {
  for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
    window.scrollTo(0, y)
    await new Promise(r => setTimeout(r, 50))
  }
  window.scrollTo(0, 0)
  for (const el of document.querySelectorAll('.swiper, .swiper-container')) {
    // stop only: sliding a loop carousel back to slide one moved it further than a visitor ever sees it
    try { el.swiper?.autoplay?.stop() } catch { /* not a live swiper */ }
  }
  try { window.jQuery?.('.slick-initialized').slick('slickPause') } catch { /* no slick */ }
  const imgs = [...document.images].filter(i => !i.complete)
  await Promise.race([Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r }))), new Promise(r => setTimeout(r, 5000))])
  await new Promise(r => setTimeout(r, 300))
}

// In the page: the y where each section starts, walking down from <body>
// while a block is taller than a piece and its children stack one under the
// other. Every row of the page lies between two cuts, so nothing is left out.
function cuts({ maxH, min }) {
  const H = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
  // unrounded: a section at y 9817.3 cut at 9817 is other pixels than the same section at 5797.7 cut at 5798
  const top = (e) => e.getBoundingClientRect().top + window.scrollY
  const shown = (e) => {
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    return r.height >= 1 && r.width >= 1 && !['fixed', 'absolute'].includes(cs.position) && cs.visibility !== 'hidden'
  }
  const out = new Set([0])
  const walk = (el, depth) => {
    const kids = [...el.children].filter(shown)
    const h = el.getBoundingClientRect().height
    if (depth > 8 || h <= maxH || !kids.length) return
    if (kids.length === 1) return walk(kids[0], depth + 1)
    const rs = kids.map(k => k.getBoundingClientRect()).sort((a, b) => a.top - b.top)
    if (rs.some((r, i) => i && r.top < rs[i - 1].bottom - 2)) return // side by side: one block
    for (const k of kids) { out.add(top(k)); walk(k, depth + 1) }
  }
  walk(document.body, 0)
  const list = [...out].filter(y => y >= 0 && y < H).sort((a, b) => a - b)
  const kept = list.filter((y, i) => i === 0 || y - list[i - 1] >= min) // a sliver joins the piece above
  return { H, cuts: kept }
}

function hideFixed() {
  for (const el of document.querySelectorAll('body *')) {
    if (getComputedStyle(el).position === 'fixed') { el.setAttribute('data-qc-fixed', el.style.visibility); el.style.visibility = 'hidden' }
  }
}
function showFixed() {
  for (const el of document.querySelectorAll('[data-qc-fixed]')) { el.style.visibility = el.getAttribute('data-qc-fixed'); el.removeAttribute('data-qc-fixed') }
}

export async function captureTiles(page, { host, width }, tile = TILE) {
  mkdirSync(join(snapshotDir(host), 'tiles'), { recursive: true })
  await page.evaluate(settle)
  const screenH = page.viewportSize()?.height || 900
  const { H, cuts: tops } = await page.evaluate(cuts, { maxH: tile.height, min: tile.min })
  const cdp = await page.context().newCDPSession(page)
  const tiles = []
  const shoot = async (top, h, kind, beyond = true) => {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: beyond, clip: { x: 0, y: top, width, height: h, scale: 1 },
    })
    const buf = Buffer.from(data, 'base64')
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16)
    const path = tilePath(host, width, hash)
    if (!existsSync(path)) writeFileSync(path, buf)
    tiles.push({ path, hash, top: Math.round(top), bottom: Math.round(top + h), kind })
  }
  try {
    const first = Math.min(screenH, H)
    await shoot(0, first, 'screen', false)
    await page.evaluate(hideFixed)
    for (let i = 0; i < tops.length; i++) {
      const start = tops[i]
      const end = i + 1 < tops.length ? tops[i + 1] : H
      if (end <= first) continue // already in the first screen
      for (let t = start; t < end; t += tile.height - tile.overlap) {
        const h = Math.min(tile.height, end - t)
        await shoot(t, h, 'section')
        if (t + h >= end) break
      }
    }
  } finally {
    await page.evaluate(showFixed).catch(() => {})
    await cdp.detach().catch(() => {})
  }
  return tiles
}
