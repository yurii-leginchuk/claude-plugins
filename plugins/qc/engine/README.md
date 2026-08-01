# qc-engine

Static QC engine for WordPress + Elementor + Gravity Forms sites. Crawls a site (or a Google
Sheets strategy list), runs a fixed catalogue of static rules (broken links, `tel:`/`mailto:`
formatting, heading hierarchy, meta/canonical/title/description, JSON-LD, favicon, dev artifacts,
form structure, etc.), and produces a JSON summary plus a rule-grouped HTML report. See
`../references/taxonomy.md` for the full rule catalogue and its calibration history.

This package is consumed by the `qc` Claude Code plugin's `/qc-site` and `/qc-cache` skills
(`../skills/`), but it is a standalone CLI and can be run directly.

## Install

```bash
npm install
```

## Run an audit

```bash
node src/cli.js audit <site-url|google-sheet-url> [flags]
```

Prints one JSON object to stdout on success (`host`, `env`, `envReason`, `pages`,
`pagesRequested`, `pagesFailed`, `failedUrls`, `source`, `sitemapStatus`, `fromCache`,
`cacheAgeDays`, `verdict`, `counts`, `distinct`, `heuristics`, `diff`, `runDir`, `reportPath`) and
exits 0. `counts` is raw finding occurrences; `distinct` collapses the same defect
(`rule + selector + found`) repeated across pages into one entry — prefer `distinct` when reporting
how much work remains. `heuristics` are findings the engine couldn't confirm with enough certainty
to count toward the verdict (e.g. a link that returned 403 — possibly bot-blocking, not proof of
breakage) and are excluded from `verdict`/`counts`/`distinct`.

On failure (bad input, unreadable sheet, unknown rule id, zero pages found or fetched, etc.) it
prints an error to stderr and exits non-zero — no report is produced. A run's own `Fail` verdict is
not a CLI failure; the process still exits 0 as long as a report was generated.

### Flags

| flag | effect |
|---|---|
| `--fresh` | bypass the snapshot cache and always do a live crawl, regardless of snapshot age |
| `--env dev\|prod` | force the environment classification instead of auto-detecting it |
| `--prod <url>` | assert that the audited host is a dev/staging site paired with this production URL (same strength signal as a strategy sheet's Dev Link column) |
| `--only <ids>` | comma-separated rule ids — run only these |
| `--skip <ids>` | comma-separated rule ids — run everything except these |
| `--concurrency <n>` | page-fetch / link-check concurrency (default 6) |

Environment detection (`dev` vs `prod`) matters because `dev` suppresses `noindex`-related findings
that would otherwise fire on every page of a legitimately unlaunched site. See `src/lib/env.js` for
the exact rules (host pattern, Dev Link/`--prod` pairing, `noindex` ratio heuristic).

## Cache

```bash
node src/cli.js cache list
node src/cli.js cache clear <host>
node src/cli.js cache clear --all
```

Snapshots (crawled pages, link-check results, and per-run `findings.json`/`report.html` history)
are stored under `$QC_CACHE_DIR` (default `~/.qc-cache/<host>/`). By default, `audit` reuses a
snapshot younger than 24h instead of re-crawling — repeat runs against the same host make zero
network requests until the snapshot expires or `--fresh` is passed. Clearing a host's snapshot also
deletes its run history, so the next audit on that host loses the "fixed since last run" (`diff`)
comparison.

## Tests

```bash
npm test
```

Runs `node --test` (discovers every `test/**/*.test.js`); no separate test runner dependency.
