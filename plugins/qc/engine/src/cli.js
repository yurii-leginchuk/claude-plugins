#!/usr/bin/env node
// plugins/qc/engine/src/cli.js
//
// The `qc` CLI wires every engine module (discovery, fetch, parse, rules,
// report, store) into one end-to-end audit run. It is intentionally the only
// place in the engine that decides process exit codes, catches module-level
// throws, and prints anything to stdout/stderr -- every other module stays a
// pure library.
import { hostOf, normalizeUrl } from './lib/url.js'
import { detectEnv } from './lib/env.js'
import { discoverPages } from './crawl/discover.js'
import { fetchAll } from './crawl/fetch.js'
import { checkLinks } from './crawl/links.js'
import { loadStrategySheet } from './crawl/sheet.js'
import { parsePage, PARSE_VERSION } from './parse/page.js'
import { buildIndex } from './parse/index.js'
import { loadFacts } from './lib/facts.js'
import { resolveGbpLinks, gbpTargets } from './lib/gbp.js'
import { buildProfile } from './lib/profile.js'
import { pageType } from './lib/page-type.js'
import { SWEEP } from './browser/sweep.js'
import { listFindings, applyReview, idsFor } from './review.js'
import { buildProdCompare, loadProdCompare, saveProdCompare } from './crawl/prod.js'
import { listWpContent } from './crawl/wp.js'
import { runStaticRules, allRules } from './rules/index.js'
import { allBrowserRules } from './rules/browser-index.js'
import { diffRuns, verdict, countDistinct } from './report/json.js'
import { renderReport } from './report/html.js'
import {
  loadSnapshot, listSnapshots, clearSnapshot, clearAll, saveSnapshot, saveRun, previousRun,
  latestBrowserResultsByUrl,
} from './crawl/store.js'
import { resolveBreakpoints } from './browser/breakpoints.js'
import { proveRegions } from './browser/regions.js'
import { runBrowserPass } from './browser/run.js'
import { parse as parseHtml } from 'node-html-parser'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { SNAPSHOT_TTL_MS } from './lib/snapshot-ttl.js'

// How long a saved snapshot is trusted as a stand-in for a live crawl when
// --fresh is not given. See the `--fresh` section of audit() below for the
// full rationale. The constant itself now lives in lib/snapshot-ttl.js,
// alongside the report's staleness-banner threshold, so the two are derived
// together and cannot drift apart the way they did before (see that file's
// header comment for the history -- commit dc6889e's message claimed this
// was already fixed; it set the reuse TTL to the banner's own 7 days, which
// made the banner unreachable instead of fixing it).

const USAGE = `qc audit <site-url|sheet-url> [--fresh] [--env dev|prod] [--prod <url>] [--facts <file.json>] [--only IDs] [--skip IDs] [--concurrency n]
qc browse <host|url> [--breakpoints a,b] [--sweep step|0] [--pages n] [--force] [--concurrency n] [--headed] [--only IDs] [--skip IDs]
  note: in browse, --only/--skip filter only the PRINTED findings (all browser rules still run) --
  this is NOT the same as audit's --only/--skip, which control which rules execute
qc findings <host>                 distinct defects of the latest run with ids, for review
qc review <host> <review.json>     re-render the latest report with Claude's verdicts
qc push <host>                     send the latest run's results to the QC Reports site (~/.config/qc/reports.json)
qc cache list
qc cache clear <host> | --all`

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++ } else { flags[name] = true }
    } else rest.push(a)
  }
  return { flags, rest }
}

const list = (v) => (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [])

// A flag that takes a value (--env, --prod, --only, --skip, --concurrency)
// silently degrading to "no value" when the user forgot the argument (e.g.
// `qc audit https://x --env` with nothing after it, or `--env` immediately
// followed by another flag) would be exactly the kind of silent misconfig
// this task's judgement calls warn against elsewhere -- so every value-flag
// is validated as actually carrying a non-empty string, not just truthy.
function requireStringFlag(flags, name, label) {
  if (flags[name] === undefined) return null
  if (typeof flags[name] !== 'string' || !flags[name].trim()) {
    throw new Error(`${label} needs a value, got: ${JSON.stringify(flags[name])}`)
  }
  return flags[name]
}

// `fetchImpl` is forwarded to loadStrategySheet unchanged -- see sheet.js for
// the injection point itself. It exists so tests (and audit()'s own caller,
// below) can stand a local server in for the real docs.google.com export
// endpoint.
async function loadSheetTarget(sheetUrl, fetchImpl) {
  const sheet = await loadStrategySheet(sheetUrl, fetchImpl ? { fetchImpl } : undefined)
  const urls = [...new Set(sheet.rows.map(r => r.devUrl || r.url).filter(Boolean))]
  // pairedAsDev mirrors env.js's own contract: it is true only when the page
  // list actually came from a sheet's Dev Link column for at least one row --
  // the strongest signal detectEnv accepts, per Task 16's brief notes.
  const pairedAsDev = sheet.rows.some(r => r.devUrl)

  // The production side of that pairing, for I14's dev-side check (a dev page
  // still linking at production = an unreplaced absolute path). Only rows that
  // actually carry BOTH columns describe a pairing. If those rows disagree
  // about which host is production, no host is reported: I14 emits nothing
  // when production is unknown, which is the right outcome -- guessing wrong
  // there would flag every outbound link on the site.
  const prodHosts = [...new Set(
    sheet.rows.filter(r => r.devUrl && r.url).map(r => hostOf(r.url)).filter(Boolean)
  )]
  const prodHost = prodHosts.length === 1 ? prodHosts[0] : null

  // dev URL -> its live URL, for K13's dev/live comparison: a sheet often
  // pairs /services/x-dev/ with /services/x/, which same-path guessing misses.
  const pairs = new Map(sheet.rows.filter(r => r.devUrl && r.url).map(r => [r.devUrl, r.url]))

  return { urls, source: `sheet:${sheet.sheet}`, pairedAsDev, prodHost, pairs }
}

// Reads a cached snapshot for `host` and returns it only if it is still
// within SNAPSHOT_TTL_MS. Returns null (never throws) on: no snapshot, a
// stale snapshot, or a corrupted one -- all three simply mean "do a live
// crawl instead", the difference being surfaced to the user as a warning
// only for the corrupted case.
//
// `wanted` is what THIS invocation asked to audit. A snapshot holds one page
// set per host, so a sheet run after a whole-site run (or the reverse) must
// not quietly report on the other page set: a whole-site audit answered from
// a 10-row sheet snapshot can come back Pass. A snapshot parsed by an older
// PARSE_VERSION is likewise re-crawled -- its PageDocs lack fields new rules
// read, and those rules then report wrong things rather than nothing.
function loadFreshSnapshot(host, wanted = null) {
  let snap
  try {
    snap = loadSnapshot(host)
  } catch (e) {
    console.error(`warning: the cache for ${host} is corrupted (${e.message}), running a fresh crawl`)
    return null
  }
  if (!snap || !snap.meta || typeof snap.meta.savedAt !== 'number') return null
  const ageMs = Date.now() - snap.meta.savedAt
  if (ageMs >= SNAPSHOT_TTL_MS) return null
  if (!snap.pages.length) return null
  if (snap.meta.parseVersion !== PARSE_VERSION) {
    console.error(`the cache for ${host} was parsed by an older parser version, running a fresh crawl`)
    return null
  }
  if (wanted && !sameTarget(snap.meta, wanted)) {
    console.error(`the cache for ${host} was saved for a different set of pages, running a fresh crawl`)
    return null
  }
  return { snap, ageDays: ageMs / 86400000 }
}

function sameTarget(meta, wanted) {
  const cachedSheet = String(meta.source || '').startsWith('sheet:')
  if (!wanted.urls) return !cachedSheet
  if (!cachedSheet || !Array.isArray(meta.requestedUrls)) return false
  const a = [...meta.requestedUrls].sort()
  const b = [...wanted.urls].sort()
  return a.length === b.length && a.every((u, i) => u === b[i])
}

// Reads each browser finding's `shot` file (a PNG on disk, written by
// src/browser/screenshot.js) and sets `shotDataUri` on the finding in place
// -- the base64 data URI renderReport actually embeds. renderReport itself
// stays filesystem-free (it is exercised directly with hand-built
// `shotDataUri` values in test/report/html-browser.test.js), so this is the
// one place in the engine that turns a `shot` path into report-ready bytes.
//
// A defect in a shared region occurs on every page it appears on, and
// run.js's backfill means every one of those occurrences already points at
// the SAME file path -- so the same path is read at most once per audit run
// (cached by path in `seen`) rather than once per occurrence.
//
// A missing/unreadable file (deleted from the cache after browser.jsonl was
// written, or a capture that genuinely failed and left `shot` unset) must
// not fail the whole audit -- the finding is still valid evidence without
// its crop; it simply renders with no image, same as any finding that never
// had one.
function inlineScreenshots(findings) {
  const seen = new Map()
  for (const f of findings) {
    if (!f.shot) continue
    if (seen.has(f.shot)) {
      f.shotDataUri = seen.get(f.shot)
      continue
    }
    try {
      const uri = `data:image/png;base64,${readFileSync(f.shot).toString('base64')}`
      seen.set(f.shot, uri)
      f.shotDataUri = uri
    } catch {
      seen.set(f.shot, undefined)
    }
  }
  return findings
}

// `fetchImpl`, when given, is threaded through to loadStrategySheet for a
// sheet-based target -- it has no effect on plain-site targets. This exists
// purely for test injection (a local server standing in for a sheet
// endpoint); normal CLI invocations from main() never pass it.
export async function audit(input, flags, { fetchImpl } = {}) {
  if (!input) throw new Error('give a site URL or a spreadsheet link')

  let concurrency = 6
  const concurrencyFlag = requireStringFlag(flags, 'concurrency', '--concurrency')
  if (concurrencyFlag !== null) {
    const n = Number(concurrencyFlag)
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--concurrency must be a positive number, got: ${concurrencyFlag}`)
    }
    concurrency = n
  }

  let envOverride = null
  const envFlag = requireStringFlag(flags, 'env', '--env')
  if (envFlag !== null) {
    if (!['dev', 'prod'].includes(envFlag)) {
      throw new Error(`--env must be 'dev' or 'prod', got: ${envFlag}`)
    }
    envOverride = envFlag
  }

  // --prod <url> is a manual pairedAsDev signal: the operator is asserting
  // "this target is a dev/staging site, and here is its production
  // counterpart" by hand, the same strength of signal env.js already treats
  // pairedAsDev as when it comes from a strategy sheet's Dev Link column. No
  // rule currently consumes prodUrl itself; it is threaded through to the
  // summary purely so a later rule (or a human) has it on hand.
  const prodUrl = requireStringFlag(flags, 'prod', '--prod')
  if (prodUrl !== null && !hostOf(prodUrl)) {
    throw new Error(`--prod must be a valid URL of the production site, got: ${prodUrl}`)
  }

  const factsFlag = requireStringFlag(flags, 'facts', '--facts')

  const onlyIds = list(requireStringFlag(flags, 'only', '--only'))
  const skipIds = list(requireStringFlag(flags, 'skip', '--skip'))
  if (requireStringFlag(flags, 'only', '--only') !== null && !onlyIds.length) {
    throw new Error('--only needs a list of rule ids')
  }
  if (requireStringFlag(flags, 'skip', '--skip') !== null && !skipIds.length) {
    throw new Error('--skip needs a list of rule ids')
  }
  const validIds = (await allRules()).map(r => r.id).sort()
  const unknownIds = [...new Set([...onlyIds, ...skipIds])].filter(id => !validIds.includes(id))
  if (unknownIds.length) {
    // Silently auditing with zero matching rules (e.g. a typo'd --only id)
    // would produce a report with no findings for that rule -- a false
    // all-clear indistinguishable from a genuinely clean site. Fail loudly
    // instead, naming the bad id(s) and every valid one.
    throw new Error(
      `unknown rule ids: ${unknownIds.join(', ')}. ` +
      `Available: ${validIds.join(', ')}`
    )
  }

  const isSheet = /docs\.google\.com\/spreadsheets/.test(input)

  let host
  let sheetTarget = null
  if (isSheet) {
    sheetTarget = await loadSheetTarget(input, fetchImpl)
    if (!sheetTarget.urls.length) throw new Error(`no pages found in the spreadsheet: ${input}`)
    host = hostOf(sheetTarget.urls[0])
  } else {
    host = hostOf(input)
  }
  if (!host) throw new Error(`could not parse the URL: ${input}`)

  // Reference facts for E9/E12/H9/H11 (lib/facts.js). Loaded before any crawl
  // so a malformed file fails the run in a second, not after ten minutes of
  // fetching.
  const facts = loadFacts(host, factsFlag)

  // The dev/prod pairing signal THIS invocation supplies, independent of
  // caching: either the sheet's Dev Link column (only known once the sheet
  // above has actually been parsed, which happens on every invocation
  // regardless of cache use) or the operator manually asserting it via
  // --prod. --prod is treated as the more explicit, more recent signal when
  // both are present, so it wins the reason text too.
  const invocationPairedAsDev = Boolean(prodUrl) || Boolean(isSheet && sheetTarget.pairedAsDev)
  const invocationPairedAsDevReason = prodUrl
    ? `dev/prod pair set by the --prod flag (${prodUrl})`
    : (isSheet && sheetTarget.pairedAsDev ? 'the host is in the Dev Link column' : null)

  // The production host that pairing names, threaded into `site` for I14's
  // dev-side check. --prod is the more explicit signal and wins, same as it
  // does for the pairing itself.
  const invocationProdHost = (prodUrl ? hostOf(prodUrl) : null) || (isSheet ? sheetTarget.prodHost : null)

  // --fresh vs default:
  //
  // The engine keeps a per-host snapshot (crawl/store.js) purely as a cache
  // of the last successful crawl's parsed pages and link-check results. By
  // default, audit() reuses that snapshot -- skipping discovery, fetchAll,
  // AND checkLinks entirely, so a repeat run against the same host makes
  // zero network requests -- as long as it is younger than SNAPSHOT_TTL_MS.
  // This exists because QC audits are commonly re-run several times in a
  // row while iterating on a single rule (`--only E4`) or just re-reading a
  // report, and re-crawling a whole site on every invocation is both slow
  // and rude to the target host.
  //
  // --fresh bypasses that cache unconditionally and always performs a live
  // crawl, no matter how young the snapshot is.
  //
  // Either way, the summary this function returns always says which one
  // happened (`fromCache` + `cacheAgeDays`), and renderReport is given the
  // real snapshot age (not a hardcoded 0) so its own "this data may be
  // stale, rerun with --fresh" banner fires correctly. A stale snapshot
  // must never look identical to a fresh crawl in the output -- this is
  // what keeps that true.
  const cached = flags.fresh ? null : loadFreshSnapshot(host, { urls: isSheet ? sheetTarget.urls : null })

  let crawlStartedAt = Date.now()
  let gbpKnown = new Map()
  let pages, linkStatus, source, sitemapStatus, pairedAsDev, pairedAsDevReason, prodHost
  let fromCache, cacheAgeDays, pagesRequested, pagesFailed, failedUrls

  if (cached) {
    const { snap, ageDays } = cached
    pages = snap.pages
    linkStatus = new Map(snap.links.map(l => [l.url, { status: l.status, ok: l.ok, error: l.error, ...(l.finalUrl ? { finalUrl: l.finalUrl } : {}) }]))
    gbpKnown = new Map((snap.meta.gbp || []).map(g => [g.url, g]))
    source = snap.meta.source
    sitemapStatus = snap.meta.sitemapStatus ?? null
    // The signal THIS invocation supplies must win over whatever the
    // snapshot remembers -- a snapshot saved by an earlier plain-URL run
    // (pairedAsDev: false) must not silently override a sheet's Dev Link
    // column or an explicit --prod on the run happening right now, or a
    // genuinely-dev site gets audited as if it were production (I4 flips
    // from silent to a false Critical on every page). The snapshot's own
    // value is only a fallback for when this invocation supplies no signal
    // of its own at all.
    pairedAsDev = invocationPairedAsDev || (snap.meta.pairedAsDev ?? false)
    pairedAsDevReason = invocationPairedAsDev
      ? invocationPairedAsDevReason
      : (snap.meta.pairedAsDevReason ?? null)
    prodHost = invocationProdHost || (snap.meta.prodHost ?? null)
    fromCache = true
    cacheAgeDays = ageDays
    pagesRequested = snap.meta.pagesRequested ?? pages.length
    pagesFailed = snap.meta.pagesFailed ?? 0
    failedUrls = snap.meta.failedUrls ?? []
  } else {
    let urls
    if (isSheet) {
      urls = sheetTarget.urls
      source = sheetTarget.source
      sitemapStatus = null
    } else {
      const found = await discoverPages(input)
      urls = found.urls
      source = found.source
      sitemapStatus = found.sitemapStatus
    }
    pairedAsDev = invocationPairedAsDev
    pairedAsDevReason = invocationPairedAsDevReason
    prodHost = invocationProdHost
    if (!urls.length) throw new Error('no pages found to audit')

    crawlStartedAt = Date.now()
    const fetched = await fetchAll(urls, { concurrency })
    pages = []
    failedUrls = []
    for (const [url, res] of fetched) {
      // A 404/5xx/timeout on one page must not silently vanish from the
      // count -- it is recorded as a failure and surfaced in the summary,
      // never just dropped. `res.ok` (not just `res.body`) gates success:
      // a 404 page can still carry a non-empty body ("not found" HTML),
      // and treating that as a successfully-audited page would be wrong.
      if (res.ok && res.body) {
        // Parse against the URL the response actually came from, not the one
        // we asked for. fetchOne follows redirects, so requesting `/about` on
        // a site that 301s to `/about/` returns the `/about/` document with a
        // correctly self-referencing canonical -- and keying the PageDoc to
        // the requested URL made I5 report a Critical "canonical with an extra
        // slash" on every such page. That is the normal case for hand-typed
        // strategy-sheet URLs and for any http->https site, so it fired
        // site-wide. finalUrl also keeps buildIndex keys, I6's homepage check
        // and internal/external link classification honest.
        //
        // The *requested* URL is still what failedUrls records below, so
        // "which of the URLs I was given could not be fetched" stays
        // answerable in the operator's own terms.
        pages.push(parsePage({
          url: res.finalUrl || url, html: res.body, status: res.status, headers: res.headers,
        }))
      } else {
        failedUrls.push({ url, status: res.status, error: res.error || null })
      }
    }
    if (!pages.length) {
      throw new Error(
        `could not fetch any page: all ${failedUrls.length} of ${urls.length} ` +
        `requests failed`
      )
    }
    linkStatus = await checkLinks(pages, { concurrency })
    fromCache = false
    cacheAgeDays = 0
    pagesRequested = urls.length
    pagesFailed = failedUrls.length
  }

  const { env, reason } = detectEnv({ host, pages, pairedAsDev, pairedAsDevReason, override: envOverride })

  // GBP short links -> the profile they open (E9). Only links the snapshot
  // has not resolved yet go to the network, so a cached run normally makes
  // none; links added to the facts file since the crawl still get resolved.
  const gbp = await resolveGbpLinks(gbpTargets(pages, facts), {
    known: gbpKnown, ...(fetchImpl ? { fetchImpl } : {}),
  })

  // What WordPress lists as published (I22: working copies outside the
  // sitemap). Kept in the snapshot meta, so a cached run asks once.
  let wpContent = cached ? cached.snap.meta.wpContent : undefined
  if (wpContent === undefined) {
    wpContent = await listWpContent(new URL(pages[0].url).origin).catch(() => null)
  }

  // Dev vs live (K13): only for a dev audit that knows production. Cached
  // next to the snapshot on its own clock, so a cached dev run does not
  // re-fetch the live site every time; --fresh rebuilds it.
  let prod = null
  if (env === 'dev' && prodHost) {
    prod = flags.fresh ? null : loadProdCompare(host, prodHost)
    if (!prod) {
      prod = await buildProdCompare({
        pages, prodHost, pairs: sheetTarget?.pairs, wholeSite: !isSheet, concurrency,
      })
      saveProdCompare(host, prod)
    }
  }

  const site = {
    host, env, prodHost, pages, index: buildIndex(pages), linkStatus, facts, gbp, source, prod, wpContent,
  }
  const staticFindings = await runStaticRules(pages, site, { only: onlyIds, skip: skipIds })

  // Task 10: merge in whatever `qc browse` has already recorded for this
  // host. `latestBrowserResultsByUrl` reads browser.jsonl directly (never re-runs
  // the browser pass -- `audit` never launches a browser at all) and returns
  // [] when the file does not exist, which is exactly the "browse was never
  // run" case `browserCoverage` below distinguishes from "browse ran and
  // covered N of M pages". --only/--skip above validate against static rule
  // ids only (see `validIds`) and never touch these -- a browser-pass id
  // would already have thrown "unknown rule ids" before
  // reaching here, so browser findings are always included whole.
  // Latest row per url, not the raw append log: a page that failed and was
  // then retried successfully legitimately carries two rows (see
  // store.js/latestBrowserResultsByUrl), and counting both would report it as
  // simultaneously done and failed.
  // A browser row older than the crawl this report is built on describes a
  // page as it was before: a horizontal scroll fixed since and re-crawled
  // with --fresh must not keep failing the verdict. Rows written before
  // `at` existed count as current for a cached run and stale after a fresh
  // crawl. Stale rows are left out of findings and counted in coverage, so
  // the summary can say "rerun qc browse".
  const crawledAt = cached ? cached.snap.meta.savedAt : crawlStartedAt
  const allBrowserRows = [...latestBrowserResultsByUrl(host).values()]
  const isStale = (r) => (typeof r.at === 'number' ? r.at : (cached ? Infinity : 0)) < crawledAt
  const browserRows = allBrowserRows.filter(r => !isStale(r))
  const staleBrowserPages = allBrowserRows.length - browserRows.length
  // A third-party script's console error (a captcha, a chat widget) is
  // rarely the site's to fix: it is shown for a human look, not counted.
  const liveBrowserIds = new Set([...(await allBrowserRules()).map(r => r.id), 'C8'])
  const browserFindings = browserRows.flatMap(r => r.findings || [])
    .filter(f => liveBrowserIds.has(f.rule))
    .map(f => (f.rule === 'X1' && String(f.found).startsWith('[third-party]') ? { ...f, confidence: 'heuristic' } : f))
  inlineScreenshots(browserFindings)
  const findings = [...staticFindings, ...browserFindings]

  // Coverage is reported only when a browser pass has actually left rows on
  // disk for this host -- an empty array here (never run) must produce NO
  // `browserCoverage`, not one claiming 0-of-N, so renderReport's "browser
  // pass never ran" header (as opposed to its "ran but partial") fires
  // correctly. `pagesDone` mirrors run.js's own definition (a row with
  // `error: null` -- a page that was actually opened and measured), not
  // merely "has a row", so a host with only failed attempts does not read as
  // partially checked.
  //
  // `pagesFailed`/`failedUrls`: the spec requires the count AND the list of
  // pages that would not open to reach the report header. Without them a
  // reader sees "7 of 31" and cannot tell a page the site refused to serve
  // from one the pass has simply not reached yet -- two situations calling
  // for opposite reactions.
  //
  // `droppedWidths`: read from the snapshot meta (where `browse` persists
  // what resolveBreakpoints excluded) BEFORE the saveSnapshot below can
  // overwrite it on a fresh crawl. It already reached browse's own stdout;
  // the spec says excluded widths are listed in the report rather than
  // swallowed, and until now the report was the one place they never
  // appeared.
  const browserFailedRows = browserRows.filter(r => r.error)
  let droppedWidths = []
  try {
    const metaSnap = loadSnapshot(host)
    if (Array.isArray(metaSnap?.meta?.browserWidthsDropped)) {
      droppedWidths = metaSnap.meta.browserWidthsDropped
    }
  } catch {
    // A corrupt snapshot is already the caller's problem elsewhere; the list
    // of excluded widths is not worth failing a whole report over.
  }
  const browserCoverage = allBrowserRows.length
    ? {
        stalePages: staleBrowserPages,
        pagesDone: browserRows.filter(r => !r.error).length,
        pagesTotal: pages.length,
        pagesFailed: browserFailedRows.length,
        failedUrls: browserFailedRows.slice(0, 50).map(r => ({ url: r.url, error: r.error })),
        widths: [...new Set(browserRows.flatMap(r => r.widths || []))].sort((a, b) => a - b),
        droppedWidths,
      }
    : null

  // Compared only over static rules both runs executed: after a `--only E4`
  // run every other rule's findings would otherwise read as fixed, and as
  // new again on the next full run. Browser findings are always included.
  const prev = previousRun(host)
  const ranNow = validIds.filter(id => (!onlyIds.length || onlyIds.includes(id)) && !skipIds.includes(id))
  const common = new Set(prev?.rules ? ranNow.filter(id => prev.rules.includes(id)) : ranNow)
  const comparable = (f) => !validIds.includes(f.rule) || common.has(f.rule)
  const diff = diffRuns(findings.filter(comparable), prev ? (prev.findings || []).filter(comparable) : null)

  if (!cached) {
    saveSnapshot(host, {
      meta: {
        host, env, envReason: reason, source, sitemapStatus, pairedAsDev, pairedAsDevReason,
        prodHost, parseVersion: PARSE_VERSION,
        ...(isSheet ? { requestedUrls: sheetTarget.urls } : {}),
        // Network errors are not kept: a timeout must be retried next run,
        // not remembered as "this link opens nothing".
        gbp: [...gbp.values()].filter(g => g.status !== 0),
        wpContent,
        pageCount: pages.length, pagesRequested, pagesFailed,
        failedUrls: failedUrls.slice(0, 50),
      },
      pages,
      links: [...linkStatus.entries()].map(([url, s]) => ({ url, ...s })),
    })
  }

  // Full-page screenshots of every page (browse, pageshot.js), in crawl
  // order; copied next to the report so it and its pictures publish together.
  const profile = buildProfile(site)
  const pageByUrl = new Map(pages.map(p => [p.url, p]))
  const rowByUrl = new Map(browserRows.filter(r => !r.error).map(r => [r.url, r]))
  const visualFiles = []
  const visual = pages.map(p => rowByUrl.get(p.url)).filter(r => r && Array.isArray(r.shots) && r.shots.length)
    .map(r => ({
      url: r.url,
      title: pageByUrl.get(r.url)?.title || '',
      type: pageType(pageByUrl.get(r.url) || { url: r.url }, profile, facts),
      shots: r.shots.filter(s => s.path && existsSync(s.path)).map(s => {
        visualFiles.push(s.path)
        return { width: s.width, src: `visual/${basename(s.path)}`, cut: Boolean(s.cut) }
      }),
    }))
    .filter(v => v.shots.length)

  const reportInput = {
    host, env, envReason: reason, pages: pages.length, diff,
    snapshotAgeDays: cacheAgeDays, source, sitemapStatus, browserCoverage, visual, ranAt: Date.now(),
  }
  const html = renderReport({ ...reportInput, findings, ids: idsFor(findings, pages.length) })
  const runDir = saveRun(host, findings, html, ranNow)
  let visualBytes = 0
  if (visualFiles.length) {
    mkdirSync(join(runDir, 'visual'), { recursive: true })
    for (const f of visualFiles) {
      copyFileSync(f, join(runDir, 'visual', basename(f)))
      visualBytes += statSync(f).size
    }
  }
  // For `qc review`, which re-renders this run with Claude's verdicts, and
  // for Claude, who reads the profile to describe the site.
  writeFileSync(join(runDir, 'report-input.json'), JSON.stringify(reportInput))
  writeFileSync(join(runDir, 'profile.json'), JSON.stringify(profile, null, 2))

  // `counts` deliberately excludes heuristic-confidence findings, matching
  // verdict()/rollUp()/renderReport() elsewhere in this engine: they are set
  // aside for human review rather than treated as confirmed defects, so they
  // must never move the verdict or inflate a severity tile.
  //
  // But stdout is the machine-readable contract a caller (e.g. a Claude
  // skill) parses, and that caller may never open the HTML report where
  // heuristic findings ARE listed separately. Without a count here, a
  // heuristic-only run reports verdict: 'Pass' with every counts.* at 0 --
  // indistinguishable from a genuinely clean site, even though
  // findings.json holds real, unconfirmed findings that need a human look.
  // `heuristics` closes that gap without folding into `counts` or `verdict`.
  //
  // `heuristics` is broken down by severity, not a single number: 97
  // "external host answered 400, needs a human to click the link" and 32
  // "external link doesn't open in a new tab, a style call" are very
  // different asks of the human reading the summary, and a flat count
  // conflates them. This also gets rid of the `note: 0` illusion in
  // `counts` -- note-severity findings mostly arrive as heuristics (see
  // E1's bot-protection downgrade), so they show up here instead of looking
  // like a phantom zero in `counts`.
  const counts = { critical: 0, major: 0, minor: 0, note: 0 }
  const heuristics = { critical: 0, major: 0, minor: 0, note: 0 }
  for (const f of findings) {
    if (f.confidence === 'heuristic') heuristics[f.severity] = (heuristics[f.severity] ?? 0) + 1
    else counts[f.severity]++
  }

  // `distinct` answers "how many actual defects," not "how many times did a
  // defect show up." `counts` is raw occurrences (a footer link repeated on
  // 31 pages contributes 31 to counts.major); `distinct` collapses that same
  // link, repeated verbatim across pages, to 1 -- while two different wrong
  // phone numbers behind the same selector still count as 2, because the
  // defect identity includes `found`. Both blocks matter: `counts` for
  // blast radius, `distinct` so a caller doesn't tell a human "56 major
  // issues" when the actual fix list is 8 items long.
  const distinct = countDistinct(findings)

  return {
    host, env, envReason: reason, pages: pages.length, source, sitemapStatus,
    fromCache, cacheAgeDays: Number(cacheAgeDays.toFixed(4)),
    pagesRequested, pagesFailed, failedUrls: failedUrls.slice(0, 20),
    prodUrl,
    profile: {
      brand: profile.brand, services: profile.services.items.length, locations: profile.locations.items.length,
      forms: profile.forms.length, path: join(runDir, 'profile.json'),
    },
    // K13's live side: null when this was not a dev audit with a known
    // production host, so "dev matches live" is never claimed unchecked.
    prodCompare: prod ? {
      host: prod.host, pagesCompared: prod.pages.length, pagesRequested: prod.pairs.length,
      missingOnDev: prod.missing.length, wholeSite: prod.wholeSite,
    } : null,
    // Which facts file E9/E12/H9/H11 compared against, or null when there was
    // none -- then H9/H11 ran silent and E12 only compared the site with
    // itself. A caller must be able to tell that apart from "data matched".
    facts: facts ? {
      path: facts.path, phones: facts.phones.length, emails: facts.emails.length,
      rating: facts.rating, banned: facts.banned.length, ignore: facts.ignore.length,
      gbp: facts.gbp.length, states: facts.states.length,
    } : null,
    verdict: verdict(findings), counts, distinct, heuristics,
    diff: { added: diff.added.length, fixed: diff.fixed.length, remaining: diff.remaining.length },
    // null (not omitted) when `qc browse` has never run for this host --
    // matches renderReport's own "never ran" vs "ran but partial" split, and
    // a caller reading the JSON summary alone (never opening the HTML) sees
    // the same distinction the report states in its header.
    browserCoverage,
    // Page screenshots sit in <runDir>/visual/ and the report links them by
    // relative path: publish them alongside report.html.
    visual: { pages: visual.length, files: visualFiles.length, bytes: visualBytes, dir: visualFiles.length ? join(runDir, 'visual') : null },
    runDir, reportPath: join(runDir, 'report.html'),
  }
}

// `browse` accepts <host|url>, unlike `audit` which only ever sees a
// site-url or sheet-url. hostOf() (lib/url.js) requires a full URL with a
// scheme and returns null for a bare host string -- `new URL('example.com')`
// throws. Falling straight through to "could not parse the URL" for the
// common `qc browse example.com` invocation (no scheme, matching how a
// human would type a host) would be a worse experience than `qc cache
// clear <host>` already gets away with by using the raw string directly as
// the cache key. So: try hostOf() first (handles a full URL, keeping the
// SAME host string `audit` would have used to save the snapshot), and only
// fall back to treating the input as a literal bare host when that fails.
function resolveHostInput(input) {
  const viaUrl = hostOf(input)
  if (viaUrl) return viaUrl
  const bare = String(input || '').trim().toLowerCase()
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(bare) ? bare : null
}

// Judgement call 3 (which page's CSS to read for breakpoint discovery): the
// brief says "the first page", but on a real site the home page routinely
// loads a different stylesheet set than an inner template -- a slider or
// hero widget only present there -- so relying on page 1 alone risks
// missing media queries that only ever appear on inner pages. Sampling the
// WHOLE site would catch more, but each fetch costs real time against a
// slow staging server and this cost is paid at most once per host (the
// result is persisted into snapshot meta below). The compromise: sample at
// most 2 pages -- the first page and the last page of the snapshot. "Last"
// is a free, already-available proxy for "a different template than the
// first" (crawl order is rarely alphabetical-by-template, so the first and
// last URLs discovered are unlikely to share a template), without needing
// a third fetch or any content-based heuristic to pick a "representative"
// inner page.
function sampleUrlsForCss(pages) {
  if (!pages.length) return []
  const first = pages[0].url
  const last = pages[pages.length - 1].url
  return last && last !== first ? [first, last] : [first]
}

// Fetches the raw HTML of each sampled url, extracts inline <style> text and
// linked stylesheet hrefs (resolved against the page it was found on), then
// fetches those stylesheets too. Every fetch goes through fetchAll, so the
// same politeness contract (concurrency, timeout, retry, 429/503 back-off)
// that governs the rest of this engine's crawling governs this too.
async function discoverCssTexts(urls, { concurrency }) {
  if (!urls.length) return []
  const parseOpts = { blockTextElements: { script: true, style: true } }
  const pagesFetched = await fetchAll(urls, { concurrency })

  const texts = []
  const sheetUrls = new Set()
  for (const url of urls) {
    const res = pagesFetched.get(url)
    if (!res || !res.ok || !res.body) continue
    let root
    try {
      root = parseHtml(res.body, parseOpts)
    } catch {
      continue
    }
    for (const styleEl of root.querySelectorAll('style')) texts.push(styleEl.text || '')
    for (const linkEl of root.querySelectorAll('link[rel="stylesheet" i]')) {
      const href = normalizeUrl(linkEl.getAttribute('href') || '', res.finalUrl || url)
      if (href) sheetUrls.add(href)
    }
  }

  if (sheetUrls.size) {
    const sheetsFetched = await fetchAll([...sheetUrls], { concurrency })
    for (const res of sheetsFetched.values()) {
      if (res.ok && res.body) texts.push(res.body)
    }
  }
  return texts
}

// `browse` never crawls -- it only ever reads the snapshot `audit` already
// saved (loadSnapshot, imported above; never discoverPages/fetchAll for the
// site's page list). This is the CLI wiring for the browser subsystem built
// across Tasks 1-8: resolve breakpoints, prove regions, and hand both to
// runBrowserPass, which owns the actual page loop.
export async function browse(input, flags) {
  if (!input) throw new Error('give a host or a site URL')

  // --- Flag validation up front (matching audit()'s own convention: every
  // flag is checked before any I/O happens), except --breakpoints, whose
  // validity can be checked here but whose resolution against the snapshot
  // happens further down, once the snapshot itself is loaded. ---

  // Judgement call 1 (--concurrency): the browser page loop itself
  // (src/browser/run.js) is deliberately sequential -- one Chromium
  // instance, one page at a time -- recorded there as a decision, not an
  // oversight: parallel contexts against a staging server that already
  // struggles to answer are likelier to make things worse. Silently
  // accepting the flag and doing nothing with it would be exactly the kind
  // of silent misconfiguration this task's brief warns against, so instead
  // it is honoured for the ONE part of `browse` that actually issues
  // concurrent network requests -- the CSS-discovery fetches below -- and
  // explicitly reported as not touching the page loop, via `notes`.
  let concurrencyValue = null
  const concurrencyFlag = requireStringFlag(flags, 'concurrency', '--concurrency')
  if (concurrencyFlag !== null) {
    const n = Number(concurrencyFlag)
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--concurrency must be a positive number, got: ${concurrencyFlag}`)
    }
    concurrencyValue = n
  }
  const fetchConcurrency = concurrencyValue ?? 6

  let maxPages = Infinity
  const pagesFlag = requireStringFlag(flags, 'pages', '--pages')
  if (pagesFlag !== null) {
    const n = Number(pagesFlag)
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--pages must be a positive integer, got: ${pagesFlag}`)
    }
    maxPages = n
  }

  const force = Boolean(flags.force)
  const headed = Boolean(flags.headed)
  // Resize sweep 1920→320 between the breakpoints; --sweep <step px>, 0 = off.
  const sweepStep = flags.sweep === undefined || flags.sweep === true ? SWEEP.step : Number(flags.sweep)
  if (!Number.isInteger(sweepStep) || sweepStep < 0) throw new Error(`--sweep must be a step in px (0 turns it off), got: ${flags.sweep}`)
  const sweep = sweepStep ? { ...SWEEP, step: sweepStep } : null

  const onlyIds = list(requireStringFlag(flags, 'only', '--only'))
  const skipIds = list(requireStringFlag(flags, 'skip', '--skip'))
  if (requireStringFlag(flags, 'only', '--only') !== null && !onlyIds.length) {
    throw new Error('--only needs a list of rule ids')
  }
  if (requireStringFlag(flags, 'skip', '--skip') !== null && !skipIds.length) {
    throw new Error('--skip needs a list of rule ids')
  }
  const validBrowserIds = (await allBrowserRules()).map(r => r.id).sort()
  const unknownIds = [...new Set([...onlyIds, ...skipIds])].filter(id => !validBrowserIds.includes(id))
  if (unknownIds.length) {
    throw new Error(
      `unknown browser rule ids: ${unknownIds.join(', ')}. ` +
      `Available: ${validBrowserIds.join(', ')}`
    )
  }

  let breakpointsOverride = null
  const breakpointsFlag = requireStringFlag(flags, 'breakpoints', '--breakpoints')
  if (breakpointsFlag !== null) {
    const parsed = breakpointsFlag.split(',').map(s => Number(s.trim()))
    if (!parsed.length || parsed.some(n => !Number.isFinite(n) || n <= 0)) {
      throw new Error(
        `--breakpoints must be a comma-separated list of positive numbers, got: ${breakpointsFlag}`
      )
    }
    breakpointsOverride = parsed
  }

  // --- browse refuses to run without a snapshot; it never crawls. ---
  const host = resolveHostInput(input)
  if (!host) throw new Error(`could not parse the host or URL: ${input}`)

  let snap
  try {
    snap = loadSnapshot(host)
  } catch (e) {
    throw new Error(
      `the snapshot for ${host} is corrupted (${e.message}); run again: qc audit ${input}`
    )
  }
  if (!snap || !Array.isArray(snap.pages) || !snap.pages.length) {
    throw new Error(
      `no saved snapshot for ${host} -- browse does not crawl on its own, ` +
      `run this first: qc audit ${input}`
    )
  }

  const notes = []
  if (concurrencyValue !== null) {
    notes.push(
      `--concurrency=${concurrencyValue} applies only to fetching CSS for breakpoint detection; ` +
      `the browser pass over the pages is always sequential (one Chromium, one page at a time)`
    )
  }

  // Breakpoints: explicit --breakpoints override > previously discovered and
  // stored in snapshot meta (so a resumed run uses the same set) > freshly
  // discovered from the sampled pages' CSS.
  let widths, dropped, unparseable, discoveredNow = false
  if (breakpointsOverride) {
    ;({ widths, dropped, unparseable } = resolveBreakpoints({ override: breakpointsOverride }))
  } else if (Array.isArray(snap.meta.browserWidths) && snap.meta.browserWidths.length) {
    widths = snap.meta.browserWidths
    dropped = snap.meta.browserWidthsDropped ?? []
    unparseable = snap.meta.browserWidthsUnparseable ?? []
  } else {
    const cssTexts = await discoverCssTexts(sampleUrlsForCss(snap.pages), { concurrency: fetchConcurrency })
    ;({ widths, dropped, unparseable } = resolveBreakpoints({ cssTexts }))
    discoveredNow = true
  }

  // Judgement call 2 (unparseable media conditions): resolveBreakpoints
  // surfaces these specifically so they do not silently vanish -- a media
  // condition in `vw`/`%`/`calc()` etc. is real information ("this theme
  // has a breakpoint we can't resolve to a pixel width"), not noise. It is
  // reported twice: structured, in `unparseableWidths` (always present, even
  // empty), for a caller that wants to act on it programmatically; and in
  // `notes`, for a human skimming the summary who would otherwise never look
  // for a field that isn't in the documented minimal contract.
  if (unparseable.length) {
    notes.push(
      `could not parse ${unparseable.length} media condition(s) while detecting breakpoints ` +
      `(unsupported units): ${unparseable.slice(0, 10).join(', ')}` +
      (unparseable.length > 10 ? ', …' : '')
    )
  }

  // Persist ONLY a freshly-discovered set: an override is a one-off,
  // deterministic operator choice that should not overwrite what a future
  // plain `qc browse` would reuse, and a set already loaded from meta is
  // already there. Discovery is the one branch that cost a network round
  // trip and whose result could differ between runs (a theme deploy
  // changing its CSS) -- that is exactly the case the brief's "so a resumed
  // run uses the same set rather than rediscovering a different one" is
  // about.
  //
  // `preserveSavedAt: true` (review fix, Task 9): this write reuses the
  // EXACT pages/links this snapshot already had -- it did not just crawl
  // anything, it only adds breakpoint metadata alongside an unchanged crawl.
  // saveSnapshot() defaults to stamping a fresh `savedAt` because for every
  // OTHER caller (audit, after an actual crawl) that is correct. Here it
  // would silently reset the freshness clock that both `audit`'s
  // SNAPSHOT_TTL_MS reuse check and the HTML report's staleness banner rely
  // on -- a two-week-old crawl would present itself as freshly crawled to
  // every later reader, purely because someone ran `browse` on it. See the
  // "persisting widths does not reset savedAt" tests.
  if (discoveredNow) {
    saveSnapshot(host, {
      meta: {
        ...snap.meta,
        browserWidths: widths,
        browserWidthsDropped: dropped,
        browserWidthsUnparseable: unparseable,
      },
      pages: snap.pages,
      links: snap.links,
      preserveSavedAt: true,
    })
  }

  // Computed once here (not left to runBrowserPass's own internal fallback)
  // so the SAME regions Map both drives finding.region tagging inside the
  // page loop and is available for the summary's own `regions` field below,
  // without loading and re-proving from the snapshot twice.
  const regions = proveRegions(snap.pages)

  const result = await runBrowserPass({
    host,
    pages: snap.pages.map(p => p.url),
    widths,
    opts: { force, maxPages, headed, regions, sweep },
  })

  // Review fix (Task 9): `result.findings` is only what THIS invocation's
  // page loop just processed -- for a resumed run where every page was
  // already `already`-marked done (browser.jsonl), that is an empty array,
  // even though the host has real, previously-recorded findings on disk. A
  // caller reading `findings` as "the browser findings for this site" would
  // see a confident, well-formed, empty result on every run after the
  // first -- a false clean. The full picture lives in browser.jsonl, so it
  // is read back (now including whatever THIS run just appended) and
  // flattened, rather than trusting the in-memory result alone.
  const rows = [...latestBrowserResultsByUrl(host).values()]
  let findings = rows.flatMap(r => r.findings || [])

  // --only/--skip filter the PRINTED findings, not which rules execute
  // in-browser: bundle.js/runBrowserPass expose no per-rule selection knob
  // (extraRules is test-only injection, not a subtraction mechanism), and
  // adding one is out of scope for this CLI-wiring task. This is a
  // DIFFERENT meaning than `qc audit`'s --only/--skip, which do control
  // which rules run at all -- a flag whose behaviour silently changes
  // between two subcommands of the same tool is a trap, so it is called out
  // twice: in USAGE (below) and, whenever either flag is actually used, as
  // a `notes` entry here, not just in this comment.
  //
  // A second practical consequence worth knowing: because a page's
  // "already done" status (browser.jsonl) is recorded regardless of this
  // run's --only/--skip, a later invocation with a wider --only than a
  // previous run used will NOT retroactively surface findings for the
  // newly-included rule unless --force is also given -- the page was
  // already marked done.
  if (onlyIds.length || skipIds.length) {
    notes.push(
      `--only/--skip here filter only the findings printed in this summary -- ` +
      `unlike qc audit, where they decide which rules run at all, ` +
      `browse runs ALL browser rules and only the output is cut down`
    )
  }
  if (onlyIds.length) findings = findings.filter(f => onlyIds.includes(f.rule))
  if (skipIds.length) findings = findings.filter(f => !skipIds.includes(f.rule))

  return {
    host,
    pagesTotal: result.pagesTotal,
    pagesDone: result.pagesDone,
    pagesFailed: result.pagesFailed,
    failedUrls: result.failedUrls,
    widths,
    droppedWidths: dropped,
    unparseableWidths: unparseable,
    stoppedEarly: result.stoppedEarly,
    findings,
    regions: [...regions.entries()].map(([id, r]) => ({ id, ...r })),
    concurrencyIgnored: concurrencyValue !== null,
    notes,
  }
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2))
  const [cmd, ...args] = rest

  try {
    if (cmd === 'audit') {
      const summary = await audit(args[0], flags)
      // A failing QC verdict is a successful run of the tool: exitCode stays
      // 0 as long as a report was actually produced. Only a thrown error
      // (below) sets a non-zero code -- that is reserved for "the run could
      // not be completed" (no pages found, sheet unreadable, unknown rule
      // id, or any other unhandled failure), never for "the site failed QC".
      console.log(JSON.stringify(summary, null, 2))
      return
    }
    if (cmd === 'browse') {
      const summary = await browse(args[0], flags)
      // Same contract as audit(): exit zero whenever the pass produced a
      // result -- even a partial one (pagesFailed > 0, stoppedEarly true) --
      // and non-zero only when it could not start at all (thrown above:
      // no snapshot, bad flag, unknown rule id).
      console.log(JSON.stringify(summary, null, 2))
      return
    }
    if (cmd === 'findings') {
      if (!args[0]) throw new Error('give a host: qc findings <host>')
      console.log(JSON.stringify(listFindings(resolveHostInput(args[0])), null, 2))
      return
    }
    if (cmd === 'review') {
      if (!args[0] || !args[1]) throw new Error('give a host and a review file: qc review <host> <review.json>')
      console.log(JSON.stringify(applyReview(resolveHostInput(args[0]), args[1]), null, 2))
      return
    }
    if (cmd === 'push') {
      if (!args[0]) throw new Error('give a host: qc push <host>')
      const { push } = await import('./push.js')
      console.log(JSON.stringify(await push(resolveHostInput(args[0])), null, 2))
      return
    }
    if (cmd === 'cache') {
      const [sub, who] = args
      if (sub === 'list') {
        const rows = listSnapshots()
        console.log(rows.length ? JSON.stringify(rows, null, 2) : 'empty')
        return
      }
      if (sub === 'clear') {
        if (flags.all || who === '--all') {
          console.log(`snapshots deleted: ${clearAll()}`)
          return
        }
        if (!who) throw new Error('give a host or --all')
        console.log(clearSnapshot(who) ? `deleted: ${who}` : `not found: ${who}`)
        return
      }
      throw new Error(`unknown cache subcommand: ${sub || '(none given)'}`)
    }
    console.log(USAGE)
    process.exitCode = 1
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}

// Only run as a CLI when this file is the actual entry point (`node
// src/cli.js ...`), not when it's imported as a module (e.g. by
// test/cli.test.js importing `audit` directly for in-process tests that
// need to inject a fetchImpl or manipulate QC_CACHE_DIR without spawning a
// subprocess). This is the standard ESM "run as script" guard: process.argv[1]
// is the entry script's path regardless of who imports what, so it only
// matches import.meta.url when this file itself was invoked directly.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  // Safety net: main() already catches everything it awaits, but this
  // guards against a stray synchronous throw (e.g. in parseArgs) never
  // reaching that try block, so this CLI can never exit 0 while silently
  // swallowing an error.
  main().catch((e) => { console.error(e?.stack || e?.message || String(e)); process.exitCode = 1 })
}
