import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, appendFileSync,
} from 'node:fs'
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

// `preserveSavedAt`: by default (false, every existing caller) saveSnapshot
// stamps `savedAt: Date.now()` -- correct for `audit`, where a save always
// means "a crawl just happened, this snapshot IS fresh now." It is wrong
// for a caller that reuses an existing snapshot's crawled pages/links
// unchanged and only adds metadata alongside them (e.g. `browse` persisting
// discovered breakpoint widths into meta): that caller did not just crawl
// anything, and unconditionally stamping `savedAt` would make an
// already-stale snapshot lie about its own age to every later reader of it
// -- `audit`'s SNAPSHOT_TTL_MS reuse check and the HTML report's staleness
// banner both key on this exact field, so a false-fresh `savedAt` silently
// defeats both. When true, the PREVIOUS meta.json's `savedAt` is read back
// off disk and kept; only a snapshot with no prior meta.json (or one whose
// meta.json cannot be parsed -- nothing trustworthy to preserve) falls back
// to stamping a fresh timestamp, same as the default path.
export function saveSnapshot(host, { meta, pages, links = [], preserveSavedAt = false }) {
  const cacheRoot = root()
  const dir = snapshotDir(host)

  // Ensure cache root exists and create marker file if it doesn't
  mkdirSync(cacheRoot, { recursive: true })
  const markerPath = join(cacheRoot, CACHE_MARKER)
  if (!existsSync(markerPath)) {
    writeFileSync(markerPath, 'QC cache directory marker - do not delete\n')
  }

  mkdirSync(dir, { recursive: true })

  let savedAt = Date.now()
  if (preserveSavedAt) {
    const metaPath = join(dir, 'meta.json')
    if (existsSync(metaPath)) {
      try {
        const existing = JSON.parse(readFileSync(metaPath, 'utf8'))
        if (typeof existing.savedAt === 'number') savedAt = existing.savedAt
      } catch {
        // Corrupted existing meta.json has no trustworthy savedAt to carry
        // forward -- fall back to stamping a fresh one, same as if this
        // were a brand-new snapshot.
      }
    }
  }

  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, savedAt }, null, 2))
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
  const cacheRoot = root()

  // Enumerate host directories the same way listSnapshots does
  // Only delete what we own: host directories (those with meta.json) and the marker
  const hostsToDelete = []
  try {
    for (const h of readdirSync(cacheRoot)) {
      const metaPath = join(cacheRoot, h, 'meta.json')
      if (existsSync(metaPath)) {
        hostsToDelete.push(h)
      }
    }
  } catch {
    // Tolerate read errors, delete what we can identify
  }

  // Delete each identified host directory
  for (const host of hostsToDelete) {
    const hostDir = join(cacheRoot, host)
    try {
      rmSync(hostDir, { recursive: true, force: true })
    } catch {
      // Continue deleting others even if one fails
    }
  }

  // Delete the marker file
  const markerPath = join(cacheRoot, CACHE_MARKER)
  try {
    if (existsSync(markerPath)) {
      rmSync(markerPath, { force: true })
    }
  } catch {
    // Continue even if marker deletion fails
  }

  // Try to remove the root directory
  // This succeeds only if the directory is now empty
  // If there are unrelated files/dirs, the root stays in place
  try {
    const remaining = readdirSync(cacheRoot)
    if (remaining.length === 0) {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  } catch {
    // If we can't read the directory or delete it, leave it in place
  }

  return hostsToDelete.length
}

// Browser-pass results (Task 7): one row per page, appended as the pass
// progresses rather than written once at the end. That is what makes an
// interrupted run leave a usable partial result -- a crash or a Ctrl-C after
// page 200 of 348 still leaves 200 rows on disk, and loadBrowserResults()
// (via runBrowserPass's `already` set) is what makes a rerun resume instead
// of redoing them. A row is `{ url, widths, findings, error }`; run.js may
// add extra fields (e.g. widthsFailed for a page that opened but measured
// incompletely at one width) -- this store treats a row as an opaque object.
export function appendBrowserResult(host, row) {
  const dir = snapshotDir(host)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, 'browser.jsonl'), JSON.stringify(row) + '\n')
}

export function loadBrowserResults(host) {
  const p = join(snapshotDir(host), 'browser.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

// The current state of each page, not the raw append log. browser.jsonl is
// append-only (that is what makes an interrupted run leave a usable partial
// result), so once a FAILED page becomes retryable -- see runBrowserPass's
// `already` set, which no longer treats an error row as done -- one url can
// legitimately carry more than one row: the failure, then the retry's
// outcome. The last row for a url is the one that describes the page as it
// stands now; every earlier row is superseded history. Anything answering
// "was this page checked, and how did it end up" (the resume set, the
// report's coverage header) must read this rather than counting raw rows,
// or a page that failed once and then succeeded would be counted as both.
export function latestBrowserResultsByUrl(host) {
  const byUrl = new Map()
  for (const row of loadBrowserResults(host)) {
    if (row && typeof row.url === 'string') byUrl.set(row.url, row)
  }
  return byUrl
}

// Removes everything `qc browse` recorded for this host: the results file AND
// the screenshot crops keyed off those results.
//
// The crops used to survive --force, while captureDefect() (src/browser/
// screenshot.js) short-circuits on `existsSync(out)` -- so a --force rerun
// re-measured every page but silently reused every stale PNG. That is
// backwards for the one case --force exists for: /qc-browse tells users it
// "deletes all previously recorded browser findings and screenshots for this
// host", "e.g. after a site redesign", which is exactly when a crop from
// the previous design is actively misleading evidence rather than a saved
// round-trip.
export function clearBrowserResults(host) {
  const dir = snapshotDir(host)
  const p = join(dir, 'browser.jsonl')
  if (existsSync(p)) rmSync(p, { force: true })
  const shots = join(dir, 'shots')
  if (existsSync(shots)) rmSync(shots, { recursive: true, force: true })
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
