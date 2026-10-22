import { readFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { extname, basename, join } from 'node:path'

const MIME = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

// The report is one HTML file: each finding's crop goes in as a data URI,
// read once per file however many findings share it.
export function inlineScreenshots(findings) {
  const seen = new Map()
  for (const f of findings) {
    if (!f.shot) continue
    if (!seen.has(f.shot)) {
      try {
        seen.set(f.shot, `data:${MIME[extname(f.shot).toLowerCase()] || 'image/png'};base64,${readFileSync(f.shot).toString('base64')}`)
      } catch {
        seen.set(f.shot, undefined)
      }
    }
    f.shotDataUri = seen.get(f.shot)
  }
  return findings
}

// The reviewed report links its pictures instead: each defect's crop is copied
// next to it as visual/<file> and published with it, so the page stays light
// however many defects it shows.
export function linkScreenshots(findings, dir) {
  mkdirSync(join(dir, 'visual'), { recursive: true })
  for (const f of findings) {
    if (!f.shot || !existsSync(f.shot)) continue
    const name = f.shot.startsWith(join(dir, 'visual')) ? basename(f.shot) : `ev-${basename(f.shot)}`
    const to = join(dir, 'visual', name)
    if (!existsSync(to)) copyFileSync(f.shot, to)
    f.shotSrc = `visual/${name}`
    delete f.shotDataUri
  }
  return findings
}
