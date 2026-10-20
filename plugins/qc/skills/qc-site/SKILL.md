---
name: qc-site
description: Run a full QC of a whole WordPress/Elementor site (static audit, then the browser pass) and publish a rule-grouped HTML report. Accepts a site URL or a Google Sheets strategy link (uses the Dev Link column when present). Use when the user says "qc site", "qc сайта", "проверь сайт", "прогони QC по сайту", "сделай аудит сайта", "проверь качество сайта", or gives a site URL plus a strategy spreadsheet.
argument-hint: <site-url|google-sheet-url> [--env dev|prod] [--prod <url>] [--facts <file.json>] [--fresh] [--only IDs] [--skip IDs] [--concurrency n] [--static]
---

# /qc-site — full QC of a whole site

The engine (`<plugin-root>/engine`) does all the checking — page discovery, fetching, link
checking, rule evaluation, severity/confidence classification, and HTML report rendering. Your job
is to run its CLI, parse the JSON it prints, and present the result faithfully. **Never re-implement
a check, never parse or interpret raw HTML yourself, never eyeball a page and add your own finding.**
If a rule looks wrong, say so and propose a fix to the rule file — do not paper over it, silently
adjust a number, or invent a finding the engine didn't report.

**By default this command runs both passes**: the static audit, then the browser pass
(`/qc-browse`'s `cli.js browse`), then the audit once more so the published report carries both.
With `--static` (not an engine flag: drop it before calling the CLI) it stops after the static
audit. The static audit alone never opens a browser: it fetches and statically parses HTML, so on its own
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

0. **Get to know the site before auditing it.** Build a knowledge base you will review findings
   against. It lives next to the facts file, `~/.qc-facts/<host>.md`, and is reused: if it exists
   and is under 30 days old, read it and refresh only what changed (new pages in the list).
   1. **Page inventory.** With the PA CMS (`poirier-cms`) tools: `list_sites` → the site whose url
      matches the host (for a dev host, also the live site) → `list_pages` (published, `limit` 200,
      all pages of results). Without PA CMS, use the sitemap via WebFetch.
   2. **Classify every page** by URL, title and, where unclear, its markdown into one of: `home`,
      `service`, `service-hub`, `location`, `location-hub`, `post`, `blog` (listing/category),
      `about`, `team`, `contact`, `admissions` (insurance, intake), `legal`, `thank-you`,
      `landing` (PPC), `careers`, `other`.
   3. **Read the content** with `discovery_page_md_get` (markdown, cheap): the homepage, every hub,
      every service and location page (if more than ~30, all hubs plus a sample of 10 of each),
      contact, about, one or two posts. Skim; you need facts, not prose.
   4. **Write the knowledge base** (`~/.qc-facts/<host>.md`, plain Markdown, ~1–2 screens):
      - the business in 2–3 sentences: who, what, where, for whom;
      - services and locations, one line each with URL;
      - contacts: phones, emails, addresses, hours, GBP links as the site states them;
      - forms and the main CTAs (where they lead);
      - claims worth cross-checking: years in business, counts, prices, insurances, staff;
      - page counts by type;
      - anything odd you already noticed while reading (another network site's email, a
        placeholder, a page that contradicts another) — these go to the chat summary as
        «замечено Claude, правилом не покрыто».
   5. **Show the user** the services, locations and anything odd in one short message, and ask
      them to confirm or correct. Then write into the facts file (keep the other fields):
      `services: [{name, url}]`, `locations: [{name, url}]`, `pages: {"/path/": "type"}` — the
      engine's form, menu, footer and copy-paste checks (G13, E16, K16, H12, H16) use them instead
      of guessing from URLs. If the user does not answer, run without them and say so. Never put
      phones or emails read off the site into `phones`/`emails` — those are checked against them.

1. Resolve the engine path: `<plugin-root>/engine`. If `node_modules` is missing there, run
   `npm install` in that directory once (only needed on a fresh checkout — do this before the
   first audit, not on every invocation).
2. Run the audit, passing through any flags the user gave:

   ```bash
   node <plugin-root>/engine/src/cli.js audit "<input>" [flags]
   ```

   Crawling tens to low hundreds of pages takes minutes — run it in the background and report
   progress rather than blocking the conversation on it.

   Then, unless the user passed `--static` and only if the audit exited 0, run the browser pass
   and re-run the audit without `--fresh` (it reuses the snapshot just crawled and merges the
   browser rows), and present that second summary from step 3 on:

   ```bash
   node <plugin-root>/engine/src/cli.js browse "<host>"
   node <plugin-root>/engine/src/cli.js audit "<input>" [flags without --fresh]
   ```

   The browser pass takes ~2–3 minutes per page at its auto-discovered widths (often 8–10); on a
   site over ~15 pages pass `--breakpoints 360,768,1024,1440` unless the user asked for a deep
   visual pass, and say which widths ran. Run it in the background too. If it exits non-zero (e.g. Chromium not installed — `npx playwright install
   chromium` in the engine dir), say so, publish the static report, and stop. For its summary
   fields and failure handling follow `/qc-browse` steps 4–5. A check «с нуля» / after changes to
   the site needs `audit --fresh` and then `browse --force`: a plain browse skips every page it has
   already measured (check `browserCoverage.stalePages` is 0 before publishing).

   While the second audit runs, do the manual checks yourself in Playwright as `/qc-browse`
   «Manual checks» describes (mobile menu, popups, forms without submitting, FAQ, keyboard focus);
   their entries go into the review file in step 5. The browser pass
   also takes a full-page screenshot of every page at every width — the report's «Визуальная
   проверка» block (summary field `visual`).
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
5. **Know the site, then review the findings yourself** before publishing. The engine's rules are
   pattern matches; you are the second pair of eyes.
   - Read your knowledge base from step 0 and `profile.path` (brand, services, locations, phones,
     emails, forms with their options), and write 2–4 plain sentences on what the site is: who the business is, what it offers, where, how
     people contact it. This is the report's «О сайте» block and your reference for the review.
   - Run `node <plugin-root>/engine/src/cli.js findings "<host>"`. It lists the latest run's
     distinct defects as `D1…Dn` with rule, severity, confidence, found, expected, scope
     (global / template / page) and up to three example pages with `where`.
   - Judge each defect: all critical and major ones, and every heuristic (cap ~60, most severe
     first; leave the rest unreviewed and say so). Verdicts: `confirmed`, `false-positive`, `unsure`,
     each with a one-line note in Russian saying why («номер в FAQ действительно без tel:»,
     «email-защита Cloudflare, в браузере это mailto»). Where the entry alone is not enough, open the
     page and look at that spot only. **A defect that carries `verify` is settled in Playwright, the
     way `verify` says** (bot-blocked links opened in a real browser, `href="#"` clicked to see if
     it opens a popup, contrast and overlap looked at on a screenshot, hover actually hovered) —
     never by WebFetch, which sees what the bot-blocked engine saw. Use the profile for the
     logical ones: is the "missing" service really a service of this business, is the "foreign" city
     one it serves. Reading pages here is to confirm or reject an engine finding — never add a finding
     the engine did not report; if you notice something the engine missed, say so in the chat
     summary as «замечено Claude, правилом не покрыто» and propose the rule.
   - **Read the copy for contradictions** (the `content` check — the engine's H16 only matches a
     few patterns). With PA CMS, `discovery_page_md_get` for every page (over ~40 pages: every hub,
     every template's pages up to 10 each, all posts' intros); otherwise WebFetch. Compare what
     pages promise: response and quote times, onboarding and start dates, prices and minimums,
     hours and 24/7, counts (years, crews, locations), insurance and guarantees, service areas;
     and inside one page: an FAQ question with no answer, the same paragraph twice (H8), a CTA
     copied from another page («schedule your restaurant cleaning» on the office page — E17),
     obvious typos (H3). Each contradiction is one `content` defect naming every page it is on
     (`pages`), quoting both claims in `found`. Record `check: "content"` entries without `width`;
     one `ok` entry per site when nothing contradicts, listing in `checked` what was compared.
   - Write `{ "summary": "<about the site>", "items": [{ "id": "D3", "verdict": "...", "note": "..." }], "manual": [ … ] }`
     (`manual`: your Playwright checks and the content check, format in `/qc-browse`) to
     `<runDir>/review-input.json` and run
     `node <plugin-root>/engine/src/cli.js review "<host>" "<runDir>/review-input.json"`. It re-renders
     `report.html`: false positives move to «Отклонено при ревью Claude» and stop counting, the rest
     show your note. Use its printed `verdict`/`distinct` in the summary, not the pre-review ones.
6. Read `reportPath` and publish it with the Artifact tool (icon `checklist`), together with the
   page screenshots in `<runDir>/visual/` as `/qc-browse` «Publishing the report» says — the report
   links them by relative path, so publishing the HTML alone leaves the visual block empty.
   **Load the `artifact-design` skill first** — it is mandatory before authoring or publishing
   artifact HTML, and applies here even though the HTML itself was generated by the engine, not
   written by you.
7. Summarise in chat, in Russian (the operator-facing language for this skill):
   - What the site is (your «О сайте» lines) and how many findings you confirmed, rejected and left
     unsure; name the rejected ones briefly so a rule can be fixed.
   - Lead with global errors (header, menu, footer, every page — one fix each), then template
     errors per section, then single pages: the report is grouped the same way.
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
   - The manual checks (menu, popups, forms, FAQ, focus, content): what you checked, what was fine,
     defects recorded, and which checks you did not do.
   - The visual block: `visual.pages` pages, `visual.files` screenshots, for a look by eye.
   - The run directory (`runDir`) and the Artifact link.

## Site facts (E9, E12, H9, H11, and the services/locations list)

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
  finding — the engine already did that. Reading a page to verify a finding in step 5 is the
  exception, and it only confirms or rejects. The manual checks are the ones you do yourself (Playwright
  for menu, popups, forms, FAQ, focus; reading the pages for content), recorded only through the
  review file's `manual`. If a rule seems wrong, say so and propose a fix to the
  rule file; do not paper over it in the summary or quietly override its output.
- If the input is a Figma link only, tell the user this command needs a site URL — design
  comparison is not part of this version.
- If the sheet's column mapping looks ambiguous (the JSON reports a `source` of `sheet:<name>`
  but a page count far off what the user expects), show the detected sheet and column mapping
  and confirm before continuing.
- If the CLI exits non-zero, or `reportPath` doesn't point to a real file, report the failure
  plainly (with the stderr message) and stop — do not publish an Artifact, do not report a verdict,
  do not guess at numbers.
