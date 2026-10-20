import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

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
