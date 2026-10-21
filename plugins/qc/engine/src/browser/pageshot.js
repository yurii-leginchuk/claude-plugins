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
import { mkdirSync, writeFileSync } from 'node:fs'
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
// so small defects only show in a piece. The pieces cover the whole height
// (no MAX_SHOT_HEIGHT cut) and overlap, so nothing falls between two of them.
export const TILE = { height: 1000, overlap: 100 }

export function tilePath(host, url, width, n) {
  const key = createHash('sha1').update(`${url}|${width}`).digest('hex').slice(0, 16)
  return join(snapshotDir(host), 'tiles', `${key}-${width}-${String(n).padStart(2, '0')}.png`)
}

export async function captureTiles(page, { host, url, width }, tile = TILE) {
  mkdirSync(join(snapshotDir(host), 'tiles'), { recursive: true })
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
  const cdp = await page.context().newCDPSession(page)
  const tiles = []
  try {
    for (let top = 0, n = 1; top < height; top += tile.height - tile.overlap, n++) {
      const h = Math.min(tile.height, height - top)
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true, clip: { x: 0, y: top, width, height: h, scale: 1 },
      })
      const path = tilePath(host, url, width, n)
      writeFileSync(path, Buffer.from(data, 'base64'))
      tiles.push({ path, top, bottom: top + h })
      if (top + h >= height) break
    }
  } finally {
    await cdp.detach().catch(() => {})
  }
  return tiles
}
