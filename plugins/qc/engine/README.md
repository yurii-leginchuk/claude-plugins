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
| `--facts <file.json>` | site facts for E9/E12/H9/H11; default `$QC_FACTS_DIR/<host>.json` (`~/.qc-facts/`), skipped when absent |

Environment detection (`dev` vs `prod`) matters because `dev` suppresses `noindex`-related findings
that would otherwise fire on every page of a legitimately unlaunched site. See `src/lib/env.js` for
the exact rules (host pattern, Dev Link/`--prod` pairing, `noindex` ratio heuristic).

## Site facts

E9 (GBP links), E12 (phones), H9 (retired terms) and H11 (emails, rating) compare the site against what is known
to be true about the business. That reference lives in a per-host JSON file, outside the snapshot
cache so `qc cache clear` never deletes it:

```json
{
  "phones": ["+1 (718) 969-0845"],
  "emails": ["info@example.com"],
  "rating": 4.7,
  "banned": ["Boston", { "term": "Equine", "note": "service dropped 2026-03" }],
  "ignore": ["/privacy-policy/", "/press/"],
  "states": ["Maine"],
  "gbp": [
    { "name": "Brighton", "url": "https://maps.app.goo.gl/kV6b8jGcAc5xs63E9",
      "address": "1 Main Street, Brighton, CO 80601", "paths": ["/locations/brighton/"] }
  ]
}
```

Every field is optional. The file is read from `--facts <path>`, otherwise from
`$QC_FACTS_DIR/<host>.json` (default `~/.qc-facts/`). A missing default file means no facts; a
missing `--facts` file or a file that does not parse is an error, not a silent skip.

- **E12** with `phones`: every `tel:` link, visible North American number and JSON-LD `telephone`
  must be one of them. Without `phones` it compares the site with itself: a number dialled from a
  few pages while another is on most of the site is reported as a heuristic (multi-location sites
  legitimately differ).
- **H9** with `banned`: whole-word, case-insensitive search in copy, title, meta description and
  JSON-LD. `note` becomes the finding's `expected`.
- **H11** with `emails` and/or `rating`: `mailto:`, emails in copy and JSON-LD must be in the list;
  the JSON-LD `aggregateRating` must equal `rating` (high), and a rating written in copy next to
  "stars", "/5", "Google" or "rated" is compared as a heuristic.
- **E9** always: a link to a Google search or to the address on the map (`/maps/search`,
  `?q=`, `/search?q=`) instead of the profile, a retired `g.page/<name>` link (a redirect hop), a
  short link that does not open, and an address in the copy that is not a link (by pattern,
  heuristic). Directions links (`/maps/dir/`) are left alone. With `gbp`: every profile link and
  Google Maps iframe must open one of the listed profiles, compared by CID (short links are
  resolved, so two different `maps.app.goo.gl` links to one profile match); a page under an
  entry's `paths` must link that location; each `address` (its street line, `Rd` = `Road`) must
  be a link wherever it appears. Without `gbp` it compares the site with itself: the same anchor
  text opening different profiles on different pages is a heuristic.
- **H12** uses `states` plus the states of the `gbp` addresses as the states a page may name;
  **I20** uses the `gbp` addresses for the schema `streetAddress`.
- `ignore`: URL path prefixes the facts-based rules skip.

## Site-logic rules

Cross-page checks that need no reference data (most are heuristic, see each rule file):

| Rule | Checks |
|---|---|
| I18 | internal link that lands through a redirect (`finalUrl` from the link check) |
| E2 | one link text opening different pages; the minority target is reported |
| F12 | `#fragment` with no element of that id, on the page or the linked page; labelled `href="#"` |
| H5 | stale `©` year; a past year in a non-post title/H1/description |
| H10 | header or footer text differing from the majority of pages |
| E13 | visible phone without `tel:`; explicit author/reviewer byline without a link |
| K14 | newest posts missing from the blog listing; listing not newest-first |
| E14 | sitemap page with no inbound internal link (sitemap runs only; posts and archives skipped) |
| E15 | self-link in the body, clickable date, exit links on `/lp/` PPC pages |
| I20 | schema address/phone absent from the page or not in facts; schema URL of another site |
| I10 | breadcrumbs missing where most pages have them; crumb outside the URL's parents |
| H12 | another US state named in the copy of a page about one state |
| K13 | dev vs live (dev audits with `--prod` or a sheet's Dev Link): menu and footer items, live pages that 404 on dev, lost schema types, headings, title/description, logo |

K13's live side is fetched once and kept in `prod-compare.json` next to the snapshot (same TTL;
`--fresh` rebuilds it). The summary carries `prodCompare` (pages compared, live pages missing on
dev) or `null`.

A snapshot is reused only if it was parsed by the current `PARSE_VERSION` (`parse/page.js`) and
for the same target: a whole-site snapshot never answers a sheet run, and a sheet snapshot only
answers the same list of URLs. Browser rows recorded before the crawl the report is built on are
left out of findings and counted in `browserCoverage.stalePages`. The diff against the previous
run compares only the static rules both runs executed, so `--only` runs do not show other rules as
fixed.

The audit summary carries `facts` (path and counts) or `null`, so a caller can tell "matched the
facts" from "had no facts". Schema checks need `jsonLdRaw`, which pages cached before this field
existed do not have: run with `--fresh` once after upgrading (the same holds for E9's map
iframes, `mapEmbeds`). Resolved GBP short links are kept in the snapshot's `meta.gbp`; a cached
run only resolves links it has not seen, such as new entries in the facts file.

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
