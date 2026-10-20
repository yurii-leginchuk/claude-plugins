---
name: qc-site
description: Run a static QC audit over a whole WordPress/Elementor site and publish a rule-grouped HTML report. Accepts a site URL or a Google Sheets strategy link (uses the Dev Link column when present). Use when the user says "qc site", "qc сайта", "проверь сайт", "прогони QC по сайту", "сделай аудит сайта", "проверь качество сайта", or gives a site URL plus a strategy spreadsheet.
argument-hint: <site-url|google-sheet-url> [--env dev|prod] [--prod <url>] [--facts <file.json>] [--fresh] [--only IDs] [--skip IDs] [--concurrency n]
---

# /qc-site — static QC of a whole site

The engine (`<plugin-root>/engine`) does all the checking — page discovery, fetching, link
checking, rule evaluation, severity/confidence classification, and HTML report rendering. Your job
is to run its CLI, parse the JSON it prints, and present the result faithfully. **Never re-implement
a check, never parse or interpret raw HTML yourself, never eyeball a page and add your own finding.**
If a rule looks wrong, say so and propose a fix to the rule file — do not paper over it, silently
adjust a number, or invent a finding the engine didn't report.

**This command alone never opens a browser.** It fetches and statically parses HTML, so on its own
it only covers what's inspectable from markup (broken links, meta, headings, forms, alt text, etc).
Visual and interactive defects — horizontal scroll, overflow, overlapping elements, hover/focus
behaviour, contrast, console errors, broken images, and per-breakpoint screenshots — only appear
once `/qc-browse` has been run for the same host at least once: it records to `browser.jsonl`, and
*every* subsequent `qc audit` on that host reads and merges it into the report automatically, no
extra flag needed. A report with none of that is a **static-only** report, and the report's own
header says so plainly ("браузерная проверка не выполнялась") — never read a static-only `Pass` as
"the site passed its visual checks", it means nothing about them either way. If the user's request
implies visual/responsive checking ("как сайт выглядит на мобильном", "проверь адаптивность",
screenshots, overlapping elements), point them at `/qc-browse` instead of, or in addition to, this
command.

## Steps

1. Resolve the engine path: `<plugin-root>/engine`. If `node_modules` is missing there, run
   `npm install` in that directory once (only needed on a fresh checkout — do this before the
   first audit, not on every invocation).
2. Run the audit, passing through any flags the user gave:

   ```bash
   node <plugin-root>/engine/src/cli.js audit "<input>" [flags]
   ```

   Crawling tens to low hundreds of pages takes minutes — run it in the background and report
   progress rather than blocking the conversation on it.
3. **Check the exit code before trusting anything on stdout.** The engine's `renderReport`,
   `rollUp`, and `diffRuns` throw on malformed input, and the CLI catches every thrown error,
   prints it to stderr, and exits non-zero. A non-zero exit means no valid report was produced —
   surface the stderr message as a failure and stop. Never present a partial JSON blob, a guess, or
   "it probably worked" as if the audit succeeded. Common causes: no URL/sheet given, an unreadable
   sheet, an unknown `--only`/`--skip` rule id, zero pages discovered, or every page fetch failing.
4. On success, the last line of stdout is one JSON object. It carries (at minimum): `host`, `env`,
   `envReason`, `pages`, `pagesRequested`, `pagesFailed`, `failedUrls`, `source`, `sitemapStatus`,
   `fromCache`, `cacheAgeDays`, `verdict`, `counts`, `distinct`, `heuristics`, `diff`,
   `browserCoverage`, `runDir`, `reportPath`. Read `reportPath` — the file it points to must exist;
   if it doesn't, treat the run as failed rather than publishing nothing.

   `browserCoverage` is `null` when `/qc-browse` has never been run for this host — say so if it's
   null, don't just leave it unmentioned. When it's an object (`{ pagesDone, pagesTotal, widths }`),
   `counts`/`distinct`/`verdict` above already include whatever browser findings exist, and the
   report's rule groups include the browser-only rules (horizontal scroll, overflow, overlap,
   hover/focus, contrast, console errors, broken images) alongside the static ones — mention the
   coverage numbers, and flag it plainly if `pagesDone < pagesTotal`.

   `counts` vs `distinct` vs `heuristics` — read this carefully, it changes what you should lead
   with:
   - `counts` is **raw occurrences**: a template-level defect (e.g. one footer link missing
     `rel="noopener"`) repeated across every page counts once per page. On a 31-page real site this
     inflated `major` to 56 when the actual fix list was 15 items.
   - `distinct` collapses repeats of the same `rule + selector + found` into one entry. This is the
     number that reflects actual remaining work — **lead the summary with `distinct`, not
     `counts`**. Mention `counts` only as a secondary "blast radius" figure (how many pages a fix
     touches), never as the headline number. The HTML report leads with the same split — its first
     tile reads «N дефектов / M вхождений на K страницах» — so your summary and the artifact agree.
   - `heuristics` (also split by severity) are findings the engine could not confirm with enough
     certainty to count toward the verdict — e.g. an external link that returned 400/403 (could be
     the site blocking automated requests, not a dead link) or a new-tab/no-new-tab style call.
     These are excluded from `verdict` and `counts`/`distinct` by design. **Always surface them
     explicitly as "needs a human look" — do not hide them, and do not imply they're confirmed
     defects either.** A heuristic-only run can show `verdict: "Pass"` with all-zero `counts` while
     `findings.json`/the HTML report still holds real, unconfirmed items — say so if that happens.
5. Read `reportPath` and publish it with the Artifact tool (favicon `✅`, title `QC · <host>`).
   **Load the `artifact-design` skill first** — it is mandatory before authoring or publishing
   artifact HTML, and applies here even though the HTML itself was generated by the engine, not
   written by you.
6. Summarise in chat, in Russian (the operator-facing language for this skill):
   - **Вердикт** (`verdict`) and the **distinct** counts per severity (critical/major/minor) —
     this is the headline, phrased as "N реальных дефектов", not raw occurrence counts.
   - Raw `counts` as a secondary line ("встречаются на M страницах"), only if it materially adds
     information (e.g. a single defect repeated on many pages).
   - `heuristics`, explicitly labeled as needing manual confirmation, broken down by severity —
     never silently dropped from the summary.
   - The **detected environment** (`env`) and **why** (`envReason`) — the user needs to know this
     because it determines whether `noindex` findings were suppressed (a `dev` classification
     silences `I4`-style findings that would otherwise fire on every page).
   - `diff` (added/fixed/remaining vs the previous run for this host), if `runDir` shows this
     wasn't the first run. The report renders all three as tiles: «новых», «починено», «осталось».
   - The top rule groups by distinct-defect count. Read this off the report, do not invent or
     recompute it: each rule row's summary line reads `<N> дефектов · <M> страниц · <K> находок`,
     where `N` is that row's distinct-defect count — the number to rank by and to quote. Inside the
     row, each distinct defect is rendered as its own block with its own `найдено` / `ожидается` /
     `селектор` and its own page list, so "8 дефектов" means eight separately described problems,
     not one example repeated.
   - If the report's header carries a `Sitemap: <status>` warning box, say so: the page list may be
     incomplete, so the audit may not have covered the whole site.
   - Dev vs live (`prodCompare`): on a dev audit, if it is `null` say that K13 did not run because
     production is unknown (pass `--prod <live-url>`); otherwise state pages compared and
     `missingOnDev` — live pages that 404 on dev are launch blockers, list them first.
   - Stale browser rows (`browserCoverage.stalePages` > 0): those pages were measured before the
     crawl this report is built on, so their browser findings are left out. Say so and suggest
     `/qc-browse` again.
   - Browser coverage (`browserCoverage`): if `null`, say plainly that no browser/visual pass has
     run for this host and that `/qc-browse` is what adds it. If present, state `pagesDone`/
     `pagesTotal` and the widths checked, and lead with "частично" language rather than a clean
     verdict if `pagesDone < pagesTotal` — a partial browser pass must never be presented as if the
     whole site's visual behaviour was checked.
   - The run directory (`runDir`) and the Artifact link.

## Site facts (E9, E12, H9, H11)

Phones, GBP profiles, retired terms, emails and the review rating are checked against a per-host facts file
(`~/.qc-facts/<host>.json`, or `--facts <path>`; format in the engine README, «Site facts»).
Without it H9 and H11 report nothing, and E9 and E12 only compare the site with itself.

- Read `facts` in the summary. If it is `null`, say so in the summary: «факты сайта не заданы —
  H9/H11 не проверялись, E9/E12 сравнивали сайт только сам с собой».
- To create the file, get the values from the user, the client's strategy sheet or the GBP
  listing. Never fill it from the site being audited — that would make every defect match
  itself. If a value is unknown, leave the field out rather than guessing; ask the user for the
  retired services/locations (`banned`), since only they know what the client dropped.
- For `gbp`, take each location's link from GBP's own «Поделиться» (Share) button or from the
  user, plus its address and the site paths of its location page. The link on the site is
  what is being checked, so it cannot be the source.
- Write the file only after the user has confirmed the values, then rerun the audit.

## Rules

- Never re-implement a check yourself, and never read/parse raw page HTML directly to produce a
  finding — the engine already did that. If a rule seems wrong, say so and propose a fix to the
  rule file; do not paper over it in the summary or quietly override its output.
- If the input is a Figma link only, tell the user this command needs a site URL — design
  comparison is not part of this version.
- If the sheet's column mapping looks ambiguous (the JSON reports a `source` of `sheet:<name>`
  but a page count far off what the user expects), show the detected sheet and column mapping
  and confirm before continuing.
- If the CLI exits non-zero, or `reportPath` doesn't point to a real file, report the failure
  plainly (with the stderr message) and stop — do not publish an Artifact, do not report a verdict,
  do not guess at numbers.
