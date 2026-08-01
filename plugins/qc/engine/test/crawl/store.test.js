import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

let store, dir, originalCacheDir

before(async () => {
  originalCacheDir = process.env.QC_CACHE_DIR
  dir = mkdtempSync(join(tmpdir(), 'qc-store-'))
  process.env.QC_CACHE_DIR = dir
  store = await import('../../src/crawl/store.js')
})

afterEach(() => {
  process.env.QC_CACHE_DIR = dir
})

after(() => {
  process.env.QC_CACHE_DIR = originalCacheDir
  rmSync(dir, { recursive: true, force: true })
})

test('saves and reloads a snapshot', () => {
  store.saveSnapshot('ex.com', {
    meta: { host: 'ex.com', env: 'dev' },
    pages: [{ url: 'https://ex.com/a', title: 'A' }],
    links: [{ url: 'https://ex.com/a', status: 200 }],
  })
  const s = store.loadSnapshot('ex.com')
  assert.equal(s.meta.env, 'dev')
  assert.equal(s.pages.length, 1)
  assert.equal(s.pages[0].title, 'A')
})

test('loadSnapshot returns null for an unknown host', () => {
  assert.equal(store.loadSnapshot('nope.com'), null)
})

test('listSnapshots reports the host and page count', () => {
  const list = store.listSnapshots()
  const row = list.find(r => r.host === 'ex.com')
  assert.equal(row.pages, 1)
  assert.equal(typeof row.ageDays, 'number')
})

test('saveRun and previousRun round-trip findings', () => {
  store.saveRun('ex.com', [{ rule: 'E4', page: 'https://ex.com/a' }], '<html></html>')
  const prev = store.previousRun('ex.com')
  assert.equal(prev.findings[0].rule, 'E4')
})

test('clearSnapshot removes the host', () => {
  assert.equal(store.clearSnapshot('ex.com'), true)
  assert.equal(store.loadSnapshot('ex.com'), null)
})

// Judgement call tests

function withTempCache(fn) {
  const testDir = mkdtempSync(join(tmpdir(), 'test-'))
  const savedCacheDir = process.env.QC_CACHE_DIR
  try {
    process.env.QC_CACHE_DIR = testDir
    return fn(testDir)
  } finally {
    process.env.QC_CACHE_DIR = savedCacheDir
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {}
  }
}

test('snapshotDir sanitizes host to prevent path traversal', () => {
  const malicious = '../../etc'
  const result = store.snapshotDir(malicious)
  assert(!result.includes('..'), 'path traversal attempt should be sanitized')
  assert(result.startsWith(dir), 'sanitized path must remain within cache root')
})

test('snapshotDir handles various path traversal attempts', () => {
  const attempts = ['../../../etc', '/etc/passwd', '..\\..\\windows', './../../secret']
  for (const attempt of attempts) {
    const result = store.snapshotDir(attempt)
    assert(!result.includes('..'), `${attempt} should be sanitized`)
    assert(result.startsWith(dir), `${attempt} result must stay within cache root`)
  }
})

test('loadSnapshot on missing meta.json returns error', () => {
  withTempCache((testDir) => {
    mkdirSync(join(testDir, 'badhost'), { recursive: true })
    // Create a pages.jsonl but no meta.json
    writeFileSync(join(testDir, 'badhost', 'pages.jsonl'), '{"url":"test"}\n')

    const result = store.loadSnapshot('badhost')
    assert.equal(result, null, 'should return null when meta.json missing')
  })
})

test('loadSnapshot on corrupted meta.json raises clear error', () => {
  withTempCache((testDir) => {
    mkdirSync(join(testDir, 'badhost'), { recursive: true })
    // Write invalid JSON to meta.json
    writeFileSync(join(testDir, 'badhost', 'meta.json'), 'not valid json {')

    let error = null
    try {
      store.loadSnapshot('badhost')
    } catch (e) {
      error = e
    }

    assert(error, 'should throw an error on corrupted meta.json')
    assert(error.message.includes('meta.json'), 'error message should identify the file')
  })
})

test('loadSnapshot on corrupted pages.jsonl raises clear error', () => {
  withTempCache((testDir) => {
    mkdirSync(join(testDir, 'badhost'), { recursive: true })
    writeFileSync(join(testDir, 'badhost', 'meta.json'), JSON.stringify({ host: 'badhost' }))
    // Write invalid JSONL (second line is truncated)
    writeFileSync(join(testDir, 'badhost', 'pages.jsonl'), '{"url":"valid"}\n{"url":"invalid')

    let error = null
    try {
      store.loadSnapshot('badhost')
    } catch (e) {
      error = e
    }

    assert(error, 'should throw an error on corrupted pages.jsonl')
    assert(error.message.includes('pages.jsonl'), 'error message should identify the file')
  })
})

test('listSnapshots tolerates junk files in cache root', () => {
  withTempCache((testDir) => {
    // Save a good snapshot
    store.saveSnapshot('good.com', {
      meta: { host: 'good.com' },
      pages: [],
      links: [],
    })

    // Add junk files
    writeFileSync(join(testDir, 'random.txt'), 'junk')
    mkdirSync(join(testDir, 'no-meta'), { recursive: true })
    writeFileSync(join(testDir, 'no-meta', 'something.json'), '{}')

    // Should not throw, should only return good.com
    const list = store.listSnapshots()
    assert.equal(list.length, 1)
    assert.equal(list[0].host, 'good.com')
  })
})

test('previousRun tolerates missing runs directory', () => {
  withTempCache((testDir) => {
    store.saveSnapshot('test.com', {
      meta: { host: 'test.com' },
      pages: [],
      links: [],
    })

    const result = store.previousRun('test.com')
    assert.equal(result, null, 'should return null when runs directory missing')
  })
})

test('previousRun tolerates empty runs directory', () => {
  withTempCache((testDir) => {
    store.saveSnapshot('test.com', {
      meta: { host: 'test.com' },
      pages: [],
      links: [],
    })

    mkdirSync(join(testDir, 'test.com', 'runs'), { recursive: true })

    const result = store.previousRun('test.com')
    assert.equal(result, null, 'should return null when runs directory is empty')
  })
})

test('previousRun tolerates run directory without findings.json', () => {
  withTempCache((testDir) => {
    store.saveSnapshot('test.com', {
      meta: { host: 'test.com' },
      pages: [],
      links: [],
    })

    mkdirSync(join(testDir, 'test.com', 'runs', '1234567890'), { recursive: true })
    writeFileSync(join(testDir, 'test.com', 'runs', '1234567890', 'report.html'), '<html></html>')

    const result = store.previousRun('test.com')
    assert.equal(result, null, 'should return null when findings.json missing')
  })
})

test('clearAll refuses to operate when cache root is home directory', () => {
  const savedCacheDir = process.env.QC_CACHE_DIR
  try {
    process.env.QC_CACHE_DIR = homedir()

    let error = null
    try {
      store.clearAll()
    } catch (e) {
      error = e
    }

    assert(error, 'should throw error when cache root is home directory')
    assert(error.message.includes('home') || error.message.includes('dangerous'), 'error should explain the danger')
  } finally {
    process.env.QC_CACHE_DIR = savedCacheDir
  }
})

test('clearAll refuses to operate when cache root is filesystem root', () => {
  const savedCacheDir = process.env.QC_CACHE_DIR
  try {
    process.env.QC_CACHE_DIR = '/'

    let error = null
    try {
      store.clearAll()
    } catch (e) {
      error = e
    }

    assert(error, 'should throw error when cache root is filesystem root')
    assert(error.message.includes('root') || error.message.includes('dangerous'), 'error should explain the danger')
  } finally {
    process.env.QC_CACHE_DIR = savedCacheDir
  }
})

test('clearAll refuses to operate when cache root does not exist', () => {
  const savedCacheDir = process.env.QC_CACHE_DIR
  try {
    process.env.QC_CACHE_DIR = '/nonexistent/path/to/cache'

    let error = null
    try {
      store.clearAll()
    } catch (e) {
      error = e
    }

    assert(error, 'should throw error when cache root does not exist')
  } finally {
    process.env.QC_CACHE_DIR = savedCacheDir
  }
})

test('clearAll returns the correct count of cleared snapshots', () => {
  withTempCache((testDir) => {
    store.saveSnapshot('a.com', { meta: { host: 'a.com' }, pages: [] })
    store.saveSnapshot('b.com', { meta: { host: 'b.com' }, pages: [] })
    store.saveSnapshot('c.com', { meta: { host: 'c.com' }, pages: [] })

    const count = store.clearAll()
    assert.equal(count, 3, 'clearAll should return the number of snapshots cleared')

    const list = store.listSnapshots()
    assert.equal(list.length, 0, 'after clearAll, no snapshots should remain')
  })
})

// Critical security tests: degenerate hostname attacks
test('clearSnapshot rejects ".." hostname with clear error', () => {
  withTempCache((testDir) => {
    // Save a legitimate snapshot
    store.saveSnapshot('good.com', { meta: { host: 'good.com' }, pages: [] })

    // Attempt clearSnapshot with degenerate hostname
    let error = null
    try {
      store.clearSnapshot('..')
    } catch (e) {
      error = e
    }

    assert(error, 'clearSnapshot should throw error for degenerate hostname ".."')
    assert(error.message.includes('Invalid') || error.message.includes('host'), 'error should explain it\'s an invalid hostname')

    // Verify the legitimate snapshot still exists
    const list = store.listSnapshots()
    assert.equal(list.length, 1, 'legitimate snapshot should still exist after failed clearSnapshot')
    assert.equal(list[0].host, 'good.com', 'the existing snapshot should be good.com')
  })
})

test('clearSnapshot rejects single "." hostname with clear error', () => {
  withTempCache((testDir) => {
    store.saveSnapshot('valid.com', { meta: { host: 'valid.com' }, pages: [] })

    let error = null
    try {
      store.clearSnapshot('.')
    } catch (e) {
      error = e
    }

    assert(error, 'clearSnapshot should throw error for "."')

    const list = store.listSnapshots()
    assert.equal(list.length, 1, 'legitimate snapshot should still exist')
  })
})

test('clearSnapshot rejects "./" hostname with clear error', () => {
  withTempCache((testDir) => {
    store.saveSnapshot('keep.com', { meta: { host: 'keep.com' }, pages: [] })

    let error = null
    try {
      store.clearSnapshot('./')
    } catch (e) {
      error = e
    }

    assert(error, 'clearSnapshot should throw error for "./"')

    const list = store.listSnapshots()
    assert.equal(list.length, 1, 'legitimate snapshot should still exist')
  })
})

test('clearSnapshot rejects "////" hostname with clear error', () => {
  withTempCache((testDir) => {
    store.saveSnapshot('safe.com', { meta: { host: 'safe.com' }, pages: [] })

    let error = null
    try {
      store.clearSnapshot('////')
    } catch (e) {
      error = e
    }

    assert(error, 'clearSnapshot should throw error for "////"')

    const list = store.listSnapshots()
    assert.equal(list.length, 1, 'legitimate snapshot should still exist')
  })
})

test('clearSnapshot rejects empty string hostname with clear error', () => {
  withTempCache((testDir) => {
    store.saveSnapshot('exists.com', { meta: { host: 'exists.com' }, pages: [] })

    let error = null
    try {
      store.clearSnapshot('')
    } catch (e) {
      error = e
    }

    assert(error, 'clearSnapshot should throw error for empty string')

    const list = store.listSnapshots()
    assert.equal(list.length, 1, 'legitimate snapshot should still exist')
  })
})

// Critical security tests: clearAll marker protection
test('clearAll refuses when cache marker is missing (arbitrary directory)', () => {
  withTempCache((testDir) => {
    // Create an unrelated directory with some files (do not call saveSnapshot)
    writeFileSync(join(testDir, 'resume.docx'), 'confidential data')
    mkdirSync(join(testDir, 'Photos'), { recursive: true })
    writeFileSync(join(testDir, 'Photos', 'vacation.jpg'), 'photo data')

    // Try to clearAll without the marker
    let error = null
    try {
      store.clearAll()
    } catch (e) {
      error = e
    }

    assert(error, 'clearAll should throw error when marker is missing')
    assert(error.message.includes('marker') || error.message.includes('QC cache'), 'error should mention the marker')

    // Verify files are still there
    assert(existsSync(join(testDir, 'resume.docx')), 'resume.docx should still exist')
    assert(existsSync(join(testDir, 'Photos')), 'Photos directory should still exist')
  })
})

test('clearAll works correctly when marker is present (proper QC cache)', () => {
  withTempCache((testDir) => {
    // Save a snapshot, which creates the marker
    store.saveSnapshot('domain.com', { meta: { host: 'domain.com' }, pages: [] })

    // Verify marker exists
    const markerPath = join(testDir, '.qc-cache-marker')
    assert(existsSync(markerPath), 'marker file should exist after saveSnapshot')

    // clearAll should work
    const count = store.clearAll()
    assert.equal(count, 1, 'clearAll should return 1')

    // Verify cache is cleared
    const list = store.listSnapshots()
    assert.equal(list.length, 0, 'cache should be empty after clearAll')

    // Marker should be gone too
    assert(!existsSync(markerPath), 'marker should be deleted by clearAll')
  })
})

test('clearAll refuses with relative QC_CACHE_DIR without marker', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'relative-'))
  const savedCwd = process.cwd()
  const savedCacheDir = process.env.QC_CACHE_DIR

  try {
    process.chdir(tempDir)
    process.env.QC_CACHE_DIR = 'notacache'

    const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs')
    mkdir('notacache', { recursive: true })
    write(join('notacache', 'important.txt'), 'important data')

    let error = null
    try {
      store.clearAll()
    } catch (e) {
      error = e
    }

    assert(error, 'clearAll should throw error for relative path without marker')
    assert(error.message.includes('marker'), 'error should mention marker')

    // Verify the file still exists
    assert(existsSync(join('notacache', 'important.txt')), 'important.txt should still exist')
  } finally {
    process.chdir(savedCwd)
    process.env.QC_CACHE_DIR = savedCacheDir
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('clearAll works with trailing slash in QC_CACHE_DIR', () => {
  withTempCache((testDir) => {
    // Save snapshot with normal path
    store.saveSnapshot('test.com', { meta: { host: 'test.com' }, pages: [] })

    // Verify we can clear with trailing slash
    const savedCacheDir = process.env.QC_CACHE_DIR
    try {
      process.env.QC_CACHE_DIR = testDir.endsWith('/') ? testDir : testDir + '/'

      const count = store.clearAll()
      assert.equal(count, 1, 'clearAll should work with trailing slash')
    } finally {
      process.env.QC_CACHE_DIR = savedCacheDir
    }
  })
})

test('clearAll rejects QC_CACHE_DIR containing .. segments', () => {
  const savedCacheDir = process.env.QC_CACHE_DIR
  try {
    process.env.QC_CACHE_DIR = '/tmp/../../etc/passwd'

    let error = null
    try {
      store.clearAll()
    } catch (e) {
      error = e
    }

    assert(error, 'clearAll should reject paths with .. segments')
  } finally {
    process.env.QC_CACHE_DIR = savedCacheDir
  }
})
