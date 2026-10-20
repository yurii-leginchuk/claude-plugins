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
  "services": [{ "name": "Medical Detox", "url": "https://www.example.com/detox-programs/" }],
  "locations": [{ "name": "Portland", "url": "https://www.example.com/" }],
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
- `services` / `locations`: the confirmed list the profile uses instead of menu dropdowns and
  URL roots (Claude builds it from PA CMS markdown in `/qc-site` step 0).
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
| G13 | form choices (select/radio/checkbox) vs the site's services and locations: missing, extra, renamed |
| E16 | services/locations missing from the menu, footer or hub; menu links to pages outside the sitemap; posts linking to removed services |
| K16 | a block (form, FAQ, phone, map, reviews, same form id) most pages of a section have and this one lacks |
| I21 | slug, H1 and title about different things (a copied page); the same H1 on several pages |
| H12 | (also) another location's name in a location page's copy, title, description or image alt |
| H14 | a list under the same heading on several pages ("Insurances we accept") missing an item the others have |
| H17 | generic or missing og:site_name; the brand spelled differently |
| H16 | contradictions across pages: years in business, "N services/locations" vs real counts, 24/7 vs stated hours, prices, staff roles |
| E17 | a CTA whose text and target disagree (Call without tel:, Book to a page without a form, Directions not to Maps); "see our X page" with no such page |
| K13 | dev vs live (dev audits with `--prod` or a sheet's Dev Link): menu and footer items, live pages that 404 on dev, lost schema types, headings, title/description, logo |
| H6 | a placeholder that reached the page: a stand-in image (alt or file name), a copy-doc marker («[LINK PLACEHOLDER]», «Insert … Here»), the same in title, description or schema |
| K17 | a post signed by a service account («PA Dev», admin, test) in the byline, the author archive link or the schema |
| I22 | a working copy (`-dev`, `-test`, `-copy`, `-old`, `elementor-123`) published: from WordPress's REST list of pages and posts (`wp-json/wp/v2`, kept in the snapshot meta as `wpContent`, `null` when closed), the crawl, and links to one |
| E13 | (also) a site path or own URL typed into the copy instead of linked; worse when no such page exists |

The profile (`profile.json` in the run directory: brand, services and locations — from fixed
section roots and from header-menu groups with ≥3 children — phones, emails, forms with their
choices) is what G13, E16, K16, H12, H16 and E17 compare against.

Findings carry `where` (zone, heading, link text or a copy snippet) and `zone`. The report files
each distinct defect under global errors (header, menu, footer, or ≥80% of pages), a section
template (all its pages share one first path segment), or a single page.

`qc findings <host>` lists the latest run's distinct defects as D1…Dn; `qc review <host>
<review.json>` (`{summary, items: [{id, verdict: confirmed|false-positive|unsure, note}]}`)
re-renders that report: false positives move to their own section and stop counting.

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

## Screenshots and Claude's manual checks

`qc browse` saves a full-page WebP (q45, through Chromium; JPEG if that fails) of every page at every width (`~/.qc-cache/<host>/pages/`,
cut at 12000 px). `qc audit` copies them into `<runDir>/visual/` and the report's «Визуальная
проверка» block (folded, grouped by page type, with a page filter; the windows of one page scroll together) links them by relative path — publish them with `report.html`. The summary's
`visual` says how many pages and files.

The engine does not click. `qc review` accepts Claude's manual checks in the review file:
`manual: [{ check, page, width, status, checked, shots, defects }]`, where `check` is `menu`,
`popup`, `form`, `faq`, `focus` (done in Playwright) or `content` (contradictions found by reading
the pages; no width; a defect may name several `pages`). Each check allows its own taxonomy codes
(`MANUAL_CHECKS` in `review.js`); shots are copied next to the report, defects count toward the
verdict and render in the «Ручные проверки Claude» block. `qc findings` adds a `verify` line to
heuristics a real browser settles (E1, F12, J3, F1, F4, X1, B6, C2).

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
