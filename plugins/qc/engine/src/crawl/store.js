import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename, normalize, relative } from 'node:path'
import { homedir } from 'node:os'

const CACHE_MARKER = '.qc-cache-marker'
const root = () => process.env.QC_CACHE_DIR || join(homedir(), '.qc-cache')

// Sanitize host to prevent path traversal attacks
function sanitizeHost(host) {
  // Replace path separators and backslashes with underscores
  let sanitized = host.replace(/[\/\\]/g, '_')

  // Replace any sequence of dots with a single underscore to prevent '..' traversal
  sanitized = sanitized.replace(/\.{2,}/g, '_')

  // Remove any other suspicious characters, keep only alphanumeric, single dots, hyphens, underscores
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_')

  // Remove leading/trailing dots and underscores
  sanitized = sanitized.replace(/^[._-]+|[._-]+$/g, '')

  return sanitized
}

// Validate that host sanitizes to a non-empty, reasonable string
function validateHost(host) {
  const sanitized = sanitizeHost(host)
  if (!sanitized || sanitized.length === 0) {
    throw new Error(`Invalid host name: "${host}" is not a valid hostname`)
  }
  return sanitized
}

export const snapshotDir = (host) => {
  validateHost(host)
  return join(root(), sanitizeHost(host))
}

const jsonl = (rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

function readJsonl(p) {
  if (!existsSync(p)) return []
  const content = readFileSync(p, 'utf8')
  if (!content.trim()) return []

  const lines = content.split('\n').filter(Boolean)
  const result = []

  for (let i = 0; i < lines.length; i++) {
    try {
      result.push(JSON.parse(lines[i]))
    } catch (e) {
      const filename = basename(p)
      throw new Error(`Corrupted snapshot: ${filename} has invalid JSON on line ${i + 1}: ${e.message}`)
    }
  }

  return result
}

export function saveSnapshot(host, { meta, pages, links = [] }) {
  const cacheRoot = root()
  const dir = snapshotDir(host)

  // Ensure cache root exists and create marker file if it doesn't
  mkdirSync(cacheRoot, { recursive: true })
  const markerPath = join(cacheRoot, CACHE_MARKER)
  if (!existsSync(markerPath)) {
    writeFileSync(markerPath, 'QC cache directory marker - do not delete\n')
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, savedAt: Date.now() }, null, 2))
  writeFileSync(join(dir, 'pages.jsonl'), jsonl(pages))
  writeFileSync(join(dir, 'links.jsonl'), jsonl(links))
  return dir
}

export function loadSnapshot(host) {
  const dir = snapshotDir(host)
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) return null

  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (e) {
    throw new Error(`Corrupted snapshot: meta.json is invalid JSON: ${e.message}`)
  }

  let pages, links
  try {
    pages = readJsonl(join(dir, 'pages.jsonl'))
  } catch (e) {
    // Re-throw with context
    throw e
  }

  try {
    links = readJsonl(join(dir, 'links.jsonl'))
  } catch (e) {
    // Re-throw with context
    throw e
  }

  return { meta, pages, links }
}

function dirBytes(dir) {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      total += st.isDirectory() ? dirBytes(p) : st.size
    }
  } catch {
    // Ignore errors reading directory
  }
  return total
}

export function listSnapshots() {
  const base = root()
  if (!existsSync(base)) return []

  const result = []

  try {
    for (const h of readdirSync(base)) {
      const metaPath = join(base, h, 'meta.json')
      if (!existsSync(metaPath)) continue

      try {
        const s = loadSnapshot(h)
        result.push({
          host: h,
          pages: s.pages.length,
          ageDays: (Date.now() - (s.meta.savedAt || 0)) / 86400000,
          bytes: dirBytes(join(base, h)),
        })
      } catch {
        // Skip corrupted snapshots
        continue
      }
    }
  } catch {
    // Ignore errors reading cache directory
  }

  return result
}

// Validate that a resolved path is strictly inside the cache root (path containment check)
function assertPathInsideCacheRoot(target) {
  const cacheRoot = resolve(root())
  const targetResolved = resolve(target)

  // Check that target is not the cache root itself
  if (targetResolved === cacheRoot) {
    throw new Error(`Refusing to delete cache root itself: ${target}`)
  }

  // Check that target is strictly inside cache root using relative path
  const rel = relative(cacheRoot, targetResolved)
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Refusing to delete path outside cache root: ${target}`)
  }
}

export function clearSnapshot(host) {
  const dir = snapshotDir(host)

  // Belt-and-braces: verify the path is strictly inside cache root
  assertPathInsideCacheRoot(dir)

  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

// Safety checks for clearAll to prevent catastrophic accidents
function validateCacheDirForClearAll() {
  const cacheRoot = root()

  // Never operate on filesystem root
  if (cacheRoot === '/' || cacheRoot === '\\') {
    throw new Error('Refusing to clearAll: cache root is filesystem root')
  }

  // Never operate on home directory
  const home = homedir()
  const normalized = resolve(cacheRoot)
  const normalizedHome = resolve(home)
  if (normalized === normalizedHome) {
    throw new Error('Refusing to clearAll: cache root is the home directory - this is dangerous')
  }

  // Cache root must exist
  if (!existsSync(cacheRoot)) {
    throw new Error(`Refusing to clearAll: cache root does not exist: ${cacheRoot}`)
  }

  // Cache root must be a directory
  const stat = statSync(cacheRoot)
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to clearAll: cache root is not a directory: ${cacheRoot}`)
  }

  // Positive check: marker file must exist to prove this is a QC cache directory
  const markerPath = join(cacheRoot, CACHE_MARKER)
  if (!existsSync(markerPath)) {
    throw new Error(`Refusing to clearAll: no QC cache marker found at ${cacheRoot} - this directory does not appear to be a QC cache`)
  }
}

export function clearAll() {
  validateCacheDirForClearAll()
  const n = listSnapshots().length
  rmSync(root(), { recursive: true, force: true })
  return n
}

export function saveRun(host, findings, reportHtml) {
  const dir = join(snapshotDir(host), 'runs', String(Date.now()))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(findings, null, 2))
  if (reportHtml) writeFileSync(join(dir, 'report.html'), reportHtml)
  return dir
}

export function previousRun(host) {
  const runs = join(snapshotDir(host), 'runs')
  if (!existsSync(runs)) return null

  let dirs = []
  try {
    dirs = readdirSync(runs).sort()
  } catch {
    // If runs directory cannot be read, return null
    return null
  }

  if (!dirs.length) return null

  const p = join(runs, dirs.at(-1), 'findings.json')
  if (!existsSync(p)) return null

  try {
    return { findings: JSON.parse(readFileSync(p, 'utf8')) }
  } catch {
    // If findings.json is corrupted, return null
    return null
  }
}
