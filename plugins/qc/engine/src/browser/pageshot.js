// A full-page picture of every page at every width, whether or not anything
// was found on it: the report's visual block lets a human scroll through the
// site the way QA does, instead of seeing only the crops of known defects.
//
// JPEG, not PNG: a full page at 1440px runs to several megabytes as PNG and
// the report ships ~130 of them. Files live at
// ~/.qc-cache/<host>/pages/<sha1(url|width)>.jpg and are overwritten by every
// pass, so the picture is always the page as it was last measured.
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { snapshotDir } from '../crawl/store.js'

export const MAX_SHOT_HEIGHT = 12000
const QUALITY = 60

export function pageShotPath(host, url, width) {
  const name = createHash('sha1').update(`${url}|${width}`).digest('hex').slice(0, 16) + '.jpg'
  return join(snapshotDir(host), 'pages', name)
}

export async function capturePage(page, { host, url, width }) {
  const path = pageShotPath(host, url, width)
  mkdirSync(join(snapshotDir(host), 'pages'), { recursive: true })
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
  // Chromium cannot paint taller than ~16k px; a very long page is cut, and
  // the visual block says so.
  const clip = height > MAX_SHOT_HEIGHT ? { x: 0, y: 0, width, height: MAX_SHOT_HEIGHT } : undefined
  await page.screenshot({ path, type: 'jpeg', quality: QUALITY, fullPage: true, ...(clip ? { clip } : {}) })
  return { path, height, cut: Boolean(clip) }
}
