import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
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

// Important: marker proves directory *was* a cache, not that contents are disposable
test('clearAll with hand-planted marker + unrelated files leaves unrelated content untouched', () => {
  withTempCache((testDir) => {
    // Hand-plant marker without any real cache
    writeFileSync(join(testDir, '.qc-cache-marker'), 'marker\n')
    writeFileSync(join(testDir, 'resume.docx'), 'confidential data')
    mkdirSync(join(testDir, 'Photos'), { recursive: true })
    writeFileSync(join(testDir, 'Photos', 'vacation.jpg'), 'photo data')

    // clearAll deletes marker and empties hosts, but since there are no hosts (no meta.json),
    // it should delete the marker and leave unrelated files
    const count = store.clearAll()
    assert.equal(count, 0, 'clearAll should find 0 hosts to delete')

    // Verify unrelated files still exist
    assert(existsSync(join(testDir, 'resume.docx')), 'resume.docx should survive')
    assert(existsSync(join(testDir, 'Photos')), 'Photos dir should survive')
    // Marker is deleted because it's what we manage
    assert(!existsSync(join(testDir, '.qc-cache-marker')), 'marker should be deleted')
    // Root survives because it has unrelated content
    assert(existsSync(testDir), 'cache root should survive because it contains unrelated files')
  })
})

test('clearAll on legitimate cache with 2 hosts removes hosts, marker, and empty root', () => {
  withTempCache((testDir) => {
    // Create legitimate cache with 2 hosts
    store.saveSnapshot('example.com', { meta: { host: 'example.com' }, pages: [{ url: 'http://example.com' }] })
    store.saveSnapshot('test.org', { meta: { host: 'test.org' }, pages: [{ url: 'http://test.org' }] })

    // Verify both exist
    let list = store.listSnapshots()
    assert.equal(list.length, 2, 'should have 2 snapshots before clearAll')

    // Verify marker exists
    assert(existsSync(join(testDir, '.qc-cache-marker')), 'marker should exist')

    // Clear all
    const count = store.clearAll()
    assert.equal(count, 2, 'clearAll should return 2')

    // Verify snapshots are gone
    list = store.listSnapshots()
    assert.equal(list.length, 0, 'no snapshots should remain')

    // Verify marker is gone
    assert(!existsSync(join(testDir, '.qc-cache-marker')), 'marker should be deleted')

    // Verify root directory is gone (was empty after deleting hosts + marker)
    assert(!existsSync(testDir), 'empty cache root should be deleted')
  })
})

test('clearAll on legitimate cache + 1 unrelated file removes only cache contents', () => {
  withTempCache((testDir) => {
    // Create legitimate cache
    store.saveSnapshot('domain.com', { meta: { host: 'domain.com' }, pages: [] })

    // Add unrelated file
    writeFileSync(join(testDir, 'readme.txt'), 'unrelated content')

    // Clear all
    const count = store.clearAll()
    assert.equal(count, 1, 'clearAll should return 1')

    // Verify host is gone
    let list = store.listSnapshots()
    assert.equal(list.length, 0, 'cache should be empty')

    // Verify marker is gone
    assert(!existsSync(join(testDir, '.qc-cache-marker')), 'marker should be deleted')

    // Verify unrelated file survives
    assert(existsSync(join(testDir, 'readme.txt')), 'unrelated file should survive')

    // Verify root directory still exists (contains unrelated file)
    assert(existsSync(testDir), 'cache root should survive because it contains unrelated file')
  })
})

test('clearAll ignores junk subdirectories without meta.json', () => {
  withTempCache((testDir) => {
    // Create legitimate cache
    store.saveSnapshot('valid.com', { meta: { host: 'valid.com' }, pages: [] })

    // Create junk subdirectory (no meta.json)
    mkdirSync(join(testDir, 'junk-dir'), { recursive: true })
    writeFileSync(join(testDir, 'junk-dir', 'somefile.txt'), 'junk data')

    // Clear all
    const count = store.clearAll()
    assert.equal(count, 1, 'clearAll should return 1 (only valid host)')

    // Verify host is gone
    assert(!existsSync(join(testDir, 'valid.com')), 'cache host should be deleted')

    // Verify junk dir still exists
    assert(existsSync(join(testDir, 'junk-dir')), 'junk directory should survive')
    assert(existsSync(join(testDir, 'junk-dir', 'somefile.txt')), 'junk file should survive')

    // Verify root survives (has junk dir)
    assert(existsSync(testDir), 'cache root should survive')
  })
})

// --- Browser-pass result rows (Task 7) --------------------------------------

test('appendBrowserResult writes rows that loadBrowserResults reads back in order', () => {
  withTempCache(() => {
    store.appendBrowserResult('b.com', { url: 'https://b.com/1', widths: [1440], findings: [], error: null })
    store.appendBrowserResult('b.com', { url: 'https://b.com/2', widths: [1440], findings: [{ rule: 'X1' }], error: null })
    const rows = store.loadBrowserResults('b.com')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].url, 'https://b.com/1')
    assert.equal(rows[1].findings[0].rule, 'X1')
  })
})

test('loadBrowserResults on a host with no browser pass yet returns an empty array', () => {
  withTempCache(() => {
    assert.deepEqual(store.loadBrowserResults('never-run.com'), [])
  })
})

test('appendBrowserResult tolerates a corrupted trailing line instead of losing every row before it', () => {
  withTempCache((testDir) => {
    store.appendBrowserResult('c.com', { url: 'https://c.com/1', widths: [1440], findings: [], error: null })
    const p = join(store.snapshotDir('c.com'), 'browser.jsonl')
    // Simulate a crash mid-write on the second row: a line that isn't valid JSON.
    writeFileSync(p, readFileSync(p, 'utf8') + 'not json\n')
    const rows = store.loadBrowserResults('c.com')
    assert.equal(rows.length, 1, 'the one well-formed row before the corruption is still readable')
    assert.equal(rows[0].url, 'https://c.com/1')
  })
})

test('clearBrowserResults removes only the browser.jsonl file for that host', () => {
  withTempCache(() => {
    store.appendBrowserResult('d.com', { url: 'https://d.com/1', widths: [1440], findings: [], error: null })
    store.saveSnapshot('d.com', { meta: { host: 'd.com' }, pages: [{ url: 'https://d.com/1' }] })
    store.clearBrowserResults('d.com')
    assert.deepEqual(store.loadBrowserResults('d.com'), [])
    // The static snapshot (a separate file) must survive clearing only the browser results.
    assert.ok(store.loadSnapshot('d.com'), 'the static snapshot is untouched')
  })
})

test('clearBrowserResults on a host with no browser results is a harmless no-op', () => {
  withTempCache(() => {
    assert.doesNotThrow(() => store.clearBrowserResults('never-touched.com'))
  })
})
