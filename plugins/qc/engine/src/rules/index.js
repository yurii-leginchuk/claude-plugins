import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function finding(rule, page, props) {
  return {
    rule: rule.id,
    title: rule.title,
    severity: rule.severity,
    engine: rule.engine,
    confidence: rule.confidence || 'high',
    page: page.url,
    breakpoint: null,
    selector: null,
    found: null,
    expected: null,
    ...props,
  }
}

let cache = null

export async function allRules() {
  if (cache) return cache
  const dir = join(here, 'static')
  const files = readdirSync(dir).filter(f => f.endsWith('.js')).sort()
  const mods = await Promise.all(
    files.map(f => import(pathToFileURL(join(dir, f)).href))
  )
  cache = mods.map(m => m.default)
  return cache
}

export async function runStaticRules(pages, site, { only = [], skip = [] } = {}) {
  const rules = (await allRules()).filter(r =>
    (only.length === 0 || only.includes(r.id)) && !skip.includes(r.id))
  const out = []
  for (const page of pages) {
    for (const rule of rules) {
      try {
        out.push(...(rule.check(page, site) || []))
      } catch (e) {
        out.push({
          rule: rule.id, title: rule.title, severity: 'note', engine: 'static',
          confidence: 'high', page: page.url, breakpoint: null, selector: null,
          found: `rule crashed: ${e.message}`, expected: null,
        })
      }
    }
  }
  return out
}
