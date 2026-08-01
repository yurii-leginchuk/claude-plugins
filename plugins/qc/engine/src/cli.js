#!/usr/bin/env node
// plugins/qc/engine/src/cli.js
//
// The `qc` CLI wires every engine module (discovery, fetch, parse, rules,
// report, store) into one end-to-end audit run. It is intentionally the only
// place in the engine that decides process exit codes, catches module-level
// throws, and prints anything to stdout/stderr -- every other module stays a
// pure library.
import { hostOf } from './lib/url.js'
import { detectEnv } from './lib/env.js'
import { discoverPages } from './crawl/discover.js'
import { fetchAll } from './crawl/fetch.js'
import { checkLinks } from './crawl/links.js'
import { loadStrategySheet } from './crawl/sheet.js'
import { parsePage } from './parse/page.js'
import { buildIndex } from './parse/index.js'
import { runStaticRules, allRules } from './rules/index.js'
import { diffRuns, verdict, countDistinct } from './report/json.js'
import { renderReport } from './report/html.js'
import {
  loadSnapshot, listSnapshots, clearSnapshot, clearAll, saveSnapshot, saveRun, previousRun,
} from './crawl/store.js'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// How long a saved snapshot is trusted as a stand-in for a live crawl when
// --fresh is not given. See the `--fresh` section of audit() below for the
// full rationale; this constant is the one number that decision hinges on.
//
// 7 days, deliberately, resolving a contradiction between two halves of this
// engine: the spec and report/html.js's staleness banner both say 7 days,
// while this constant said 24h -- which meant a snapshot was refused before it
// could ever reach 7 days old, `cacheAgeDays` was always < 1, and the banner
// was unreachable dead code. Of the two definitions, 7 days is the one to keep:
// the banner exists precisely so a reused-but-aging snapshot announces itself,
// and --fresh is the override for anyone who wants a live crawl regardless.
// A 24h TTL with a 7-day banner is the worst of both -- it re-crawls sites
// needlessly AND never warns.
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d, matching the report's banner

const USAGE = `qc audit <site-url|sheet-url> [--fresh] [--env dev|prod] [--prod <url>] [--only IDs] [--skip IDs] [--concurrency n]
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
    throw new Error(`${label} требует значение, получено: ${JSON.stringify(flags[name])}`)
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

  return { urls, source: `sheet:${sheet.sheet}`, pairedAsDev, prodHost }
}

// Reads a cached snapshot for `host` and returns it only if it is still
// within SNAPSHOT_TTL_MS. Returns null (never throws) on: no snapshot, a
// stale snapshot, or a corrupted one -- all three simply mean "do a live
// crawl instead", the difference being surfaced to the user as a warning
// only for the corrupted case.
function loadFreshSnapshot(host) {
  let snap
  try {
    snap = loadSnapshot(host)
  } catch (e) {
    console.error(`предупреждение: кэш для ${host} повреждён (${e.message}), выполняется свежий обход`)
    return null
  }
  if (!snap || !snap.meta || typeof snap.meta.savedAt !== 'number') return null
  const ageMs = Date.now() - snap.meta.savedAt
  if (ageMs >= SNAPSHOT_TTL_MS) return null
  if (!snap.pages.length) return null
  return { snap, ageDays: ageMs / 86400000 }
}

// `fetchImpl`, when given, is threaded through to loadStrategySheet for a
// sheet-based target -- it has no effect on plain-site targets. This exists
// purely for test injection (a local server standing in for a sheet
// endpoint); normal CLI invocations from main() never pass it.
export async function audit(input, flags, { fetchImpl } = {}) {
  if (!input) throw new Error('укажите URL сайта или ссылку на таблицу')

  let concurrency = 6
  const concurrencyFlag = requireStringFlag(flags, 'concurrency', '--concurrency')
  if (concurrencyFlag !== null) {
    const n = Number(concurrencyFlag)
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--concurrency должен быть положительным числом, получено: ${concurrencyFlag}`)
    }
    concurrency = n
  }

  let envOverride = null
  const envFlag = requireStringFlag(flags, 'env', '--env')
  if (envFlag !== null) {
    if (!['dev', 'prod'].includes(envFlag)) {
      throw new Error(`--env должен быть 'dev' или 'prod', получено: ${envFlag}`)
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
    throw new Error(`--prod должен быть корректным URL продакшн-сайта, получено: ${prodUrl}`)
  }

  const onlyIds = list(requireStringFlag(flags, 'only', '--only'))
  const skipIds = list(requireStringFlag(flags, 'skip', '--skip'))
  if (requireStringFlag(flags, 'only', '--only') !== null && !onlyIds.length) {
    throw new Error('--only требует список идентификаторов правил')
  }
  if (requireStringFlag(flags, 'skip', '--skip') !== null && !skipIds.length) {
    throw new Error('--skip требует список идентификаторов правил')
  }
  const validIds = (await allRules()).map(r => r.id).sort()
  const unknownIds = [...new Set([...onlyIds, ...skipIds])].filter(id => !validIds.includes(id))
  if (unknownIds.length) {
    // Silently auditing with zero matching rules (e.g. a typo'd --only id)
    // would produce a report with no findings for that rule -- a false
    // all-clear indistinguishable from a genuinely clean site. Fail loudly
    // instead, naming the bad id(s) and every valid one.
    throw new Error(
      `неизвестные идентификаторы правил: ${unknownIds.join(', ')}. ` +
      `Доступные: ${validIds.join(', ')}`
    )
  }

  const isSheet = /docs\.google\.com\/spreadsheets/.test(input)

  let host
  let sheetTarget = null
  if (isSheet) {
    sheetTarget = await loadSheetTarget(input, fetchImpl)
    if (!sheetTarget.urls.length) throw new Error(`в таблице не найдено ни одной страницы: ${input}`)
    host = hostOf(sheetTarget.urls[0])
  } else {
    host = hostOf(input)
  }
  if (!host) throw new Error(`не удалось разобрать URL: ${input}`)

  // The dev/prod pairing signal THIS invocation supplies, independent of
  // caching: either the sheet's Dev Link column (only known once the sheet
  // above has actually been parsed, which happens on every invocation
  // regardless of cache use) or the operator manually asserting it via
  // --prod. --prod is treated as the more explicit, more recent signal when
  // both are present, so it wins the reason text too.
  const invocationPairedAsDev = Boolean(prodUrl) || Boolean(isSheet && sheetTarget.pairedAsDev)
  const invocationPairedAsDevReason = prodUrl
    ? `dev/prod-пара задана флагом --prod (${prodUrl})`
    : (isSheet && sheetTarget.pairedAsDev ? 'хост стоит в колонке Dev Link' : null)

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
  const cached = flags.fresh ? null : loadFreshSnapshot(host)

  let pages, linkStatus, source, sitemapStatus, pairedAsDev, pairedAsDevReason, prodHost
  let fromCache, cacheAgeDays, pagesRequested, pagesFailed, failedUrls

  if (cached) {
    const { snap, ageDays } = cached
    pages = snap.pages
    linkStatus = new Map(snap.links.map(l => [l.url, { status: l.status, ok: l.ok, error: l.error }]))
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
    if (!urls.length) throw new Error('не найдено ни одной страницы для аудита')

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
        // the requested URL made I5 report a Critical "canonical с лишним
        // слешем" on every such page. That is the normal case for hand-typed
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
        `не удалось получить ни одной страницы: все ${failedUrls.length} из ${urls.length} ` +
        `запросов завершились ошибкой`
      )
    }
    linkStatus = await checkLinks(pages, { concurrency })
    fromCache = false
    cacheAgeDays = 0
    pagesRequested = urls.length
    pagesFailed = failedUrls.length
  }

  const { env, reason } = detectEnv({ host, pages, pairedAsDev, pairedAsDevReason, override: envOverride })

  const site = { host, env, prodHost, pages, index: buildIndex(pages), linkStatus }
  const findings = await runStaticRules(pages, site, { only: onlyIds, skip: skipIds })

  const prev = previousRun(host)
  const diff = diffRuns(findings, prev?.findings || null)

  if (!cached) {
    saveSnapshot(host, {
      meta: {
        host, env, envReason: reason, source, sitemapStatus, pairedAsDev, pairedAsDevReason,
        prodHost,
        pageCount: pages.length, pagesRequested, pagesFailed,
        failedUrls: failedUrls.slice(0, 50),
      },
      pages,
      links: [...linkStatus.entries()].map(([url, s]) => ({ url, ...s })),
    })
  }

  const html = renderReport({
    host, env, envReason: reason, pages: pages.length, findings, diff,
    snapshotAgeDays: cacheAgeDays, source, sitemapStatus,
  })
  const runDir = saveRun(host, findings, html)

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
    verdict: verdict(findings), counts, distinct, heuristics,
    diff: { added: diff.added.length, fixed: diff.fixed.length, remaining: diff.remaining.length },
    runDir, reportPath: join(runDir, 'report.html'),
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
    if (cmd === 'cache') {
      const [sub, who] = args
      if (sub === 'list') {
        const rows = listSnapshots()
        console.log(rows.length ? JSON.stringify(rows, null, 2) : 'пусто')
        return
      }
      if (sub === 'clear') {
        if (flags.all || who === '--all') {
          console.log(`удалено снапшотов: ${clearAll()}`)
          return
        }
        if (!who) throw new Error('укажите хост или --all')
        console.log(clearSnapshot(who) ? `удалён: ${who}` : `не найден: ${who}`)
        return
      }
      throw new Error(`неизвестная подкоманда cache: ${sub || '(не указана)'}`)
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
