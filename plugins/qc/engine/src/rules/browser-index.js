import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, 'browser')

let cache = null

export async function allBrowserRules() {
  if (cache) return cache
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.startsWith('_'))
    .sort()
  const mods = await Promise.all(files.map(f => import(pathToFileURL(join(dir, f)).href)))
  cache = mods.map(m => ({ ...m.meta, check: m.check }))
  return cache
}
