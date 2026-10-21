---
name: qc-site
description: Run a full QC of a whole WordPress/Elementor site (static audit, then the browser pass) and publish a rule-grouped HTML report. Accepts a site URL or a Google Sheets strategy link (uses the Dev Link column when present). Use when the user says "qc site", "qc сайта", "проверь сайт", "прогони QC по сайту", "сделай аудит сайта", "проверь качество сайта", or gives a site URL plus a strategy spreadsheet.
argument-hint: <site-url|google-sheet-url> [--env dev|prod] [--prod <url>] [--facts <file.json>] [--fresh] [--only IDs] [--skip IDs] [--concurrency n] [--static]
---

# /qc-site — full QC of a whole site

**You are the senior QA at a marketing agency, and this is a client's site.** You find out what
the site is for, decide what to check, do it like a visitor — journeys such as booking, calling
or buying, end to end, at a phone and a desktop width — look at every page's screenshots, read
the copy, and send subagents to do parts of it in parallel. **Read `qa-playbook.md` (next to this
file) before you start**: journeys per site type, the visual rubric, the subagents, the second
check, the severity table, and what is not a defect.

The engine (`<plugin-root>/engine`) is your set of instruments. What its scripts **measure** —
a 404, a missing `tel:`, a heading level, a missing `rel`, a horizontal scroll — is a fact and
reaches the report on its own; never re-measure it by hand. Everything else it reports is a
**candidate** (`judge` or `verify` in `qc findings`: judgement rules, clicks, console errors,
every heuristic) and reaches the report only with your verdict. Your own defects go through the
review file's `manual`, each with its evidence and the second check's result. If a rule keeps
being wrong, say so and propose a fix to the rule file.

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
header says so plainly ("Browser check was not run") — never read a static-only `Pass` as
"the site passed its visual checks", it means nothing about them either way. If the user's request
implies visual/responsive checking ("как сайт выглядит на мобильном", "проверь адаптивность",
screenshots, overlapping elements), point them at `/qc-browse` instead of, or in addition to, this
command.

## Language

Reports are **English**: the engine writes its findings in English, and so does everything you add
to them — the About-the-site lines, review notes, manual-check `checked` text, content defects.
The chat summary goes in the language the user writes to you in. Translate a report only if the
user asks for it: translate the HTML artifact (`report.html`) and republish it; the QC Reports site
(`qc push`) takes English only and refuses anything with Cyrillic in it.

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
   3. **Read the content** with `discovery_page_md_get` (markdown, cheap, from the PA CMS): every
      page that is not a post — do not sample them — and the newest 10 posts. This is what the
      copy agent works from later, so note where things are said.
   4. **Write the knowledge base** (`~/.qc-facts/<host>.md`, plain Markdown, ~1–2 screens):
      - the site type (local service, healthcare, e-commerce, restaurant, lead-gen landing, …)
        and what it exists to make visitors do (call, book, buy, send a form);
      - the journeys you will run (from `qa-playbook.md`, adapted: «book a cleaning from a
        service page», «verify insurance»), each with where it starts and what should happen;
      - the business in 2–3 sentences: who, what, where, for whom;
      - services and locations, one line each with URL;
      - contacts: phones, emails, addresses, hours, GBP links as the site states them;
      - forms and the main CTAs (where they lead);
      - claims worth cross-checking: years in business, counts, prices, insurances, staff;
      - page counts by type;
      - anything odd you already noticed while reading (another network site's email, a
        placeholder, a page that contradicts another) — these go to the chat summary as
        "noticed by Claude, not covered by a rule".
   5. **Show the user** the site type, the journeys, the services, locations and anything odd in
      one short message, and ask them to confirm or correct. Then write into the facts file (keep the other fields):
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
   visual pass, and say which widths ran. It takes every page that is not a post and the newest
   10 posts (`--posts <n>` or `--posts all` to change it; the summary's `pagesLeftOut` says how many
   older posts it skipped — the static audit still read them). Run it in the background too. If it exits non-zero (e.g. Chromium not installed — `npx playwright install
   chromium` in the engine dir), say so, publish the static report, and stop. For its summary
   fields and failure handling follow `/qc-browse` steps 4–5. A check "from scratch" / after changes to
   the site needs `audit --fresh` and then `browse --force`: a plain browse skips every page it has
   already measured (check `browserCoverage.stalePages` is 0 before publishing).

   While the engine runs, **start the QA work** (`qa-playbook.md` «Subagents»): the copy & facts
   agent and the judge can start at once (they read the CMS markdown and the pages); the
   journeys and the manual checks (mobile and desktop menu, popups, forms without submitting,
   FAQ, keyboard focus — `/qc-browse` «Manual checks») need the browser; the visual agents (`model: "sonnet"`, ~60 pieces each, 6–10 read per step) start
   after the second audit, from `qc tiles <host>` (every page cut into full-size pieces — each
   agent gets its page types and must look at every piece). Everything they find goes into the
   review file in step 5.
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
     tile reads "N defects / M occurrences on K pages" — so your summary and the artifact agree.
   - `heuristics` (also split by severity) are findings the engine could not confirm — e.g. an
     external link that returned 400/403 (could be bot protection, not a dead link). They do not
     count toward `verdict` or `distinct`; they are candidates, and step 5 settles every one.
5. **Review everything before publishing.** The engine's candidates are pattern matches; you
   decide them, and you add what your own QA found.
   - Read your knowledge base from step 0 and `profile.path` (brand, services, locations, phones,
     emails, forms with their options), and write 2–4 plain sentences on what the site is: who the business is, what it offers, where, how
     people contact it. This is the report's "About the site" block and your reference for the review.
   - Run `node <plugin-root>/engine/src/cli.js findings "<host>"`. It lists the latest run's
     distinct defects as `D1…Dn` with rule, severity, confidence, found, expected, scope
     (global / template / page) and up to three example pages with `where`.
   - **Every candidate is yours to decide — all of them, no cap** (split them between agents when
     there are many). A defect with `judge` (H14 lists, H12 places, H16 contradictions, H17 brand,
     G13 form options, E16 inventory, E17 CTA, E2 link text, E15 extra links, I21 copied pages, H6
     placeholders, I20 schema facts) is settled by reading the page and the knowledge base the way
     a person would («recipes have their own ingredients» → false-positive; «one location lists
     11 insurers, the others 12» → confirmed). A defect with `verify` (clicks, console errors,
     contrast, bot-blocked links, every heuristic) is settled **in Playwright, the way `verify`
     says** — never by WebFetch, which sees what the bot-blocked engine saw. A candidate nobody
     judged is left out of the report, and the report says how many.
   - Also look at the measured ones: critical and major first. They are facts, but you may still
     find one is not a defect here (Cloudflare email protection, a `mailto:` in the browser) —
     say so with `false-positive`.
   - Verdicts: `confirmed`, `false-positive`, `unsure` («cannot tell from what I see» — honest, it
     shows as «needs a look» and does not count), each with a one-line note in English saying why,
     a page it names written as a link, `[Newark](https://site/locations/newark/)`. Candidates of
     one rule that share the cause can be settled together with one note, each id listed.
   - **Your own defects** — journeys, the visual review, the manual checks, the copy — go into
     `manual` (format in `/qc-browse`): each needs its evidence (a screenshot; for copy, the
     words quoted from the page), an `impact` from the playbook's table (the engine sets the
     severity from it), and `verified` from the second check.
   - **Run the second check** (`qa-playbook.md` «The second check») on every `manual` defect
     before applying the review, and write each answer into `verified`.
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
   - **Look at every defect's evidence crop.** Run
     `node <plugin-root>/engine/src/cli.js evidence "<host>"` (Playwright opens each defect's page,
     finds the spot and saves a crop with it outlined; `--force` redoes them). Open the crops
     (a contact sheet of several per image is fine) and check each points at the right thing; a
     crop of the wrong element is a locator problem to report, a crop that shows no defect is a
     reason to change the verdict. `notFoundIds` and `invisible` are spots it could not show —
     look at those pages yourself.
   - **Say who fixes each defect** (`category` on an item or a manual defect): `dev` — a developer
     fixes it on the site without another team (markup, links, CSS, forms, plugins, a missing
     option); `seo` — it most likely needs input from the SEO department (titles, descriptions,
     schema facts, indexing, redirects, site structure); `copy` — it most likely needs input from
     the copy team (wording, claims, contradictions, a missing paragraph or answer, who the author
     is). The engine gives every rule a default; set `category` only where this defect differs
     (a heading-level skip that is a tag swap is `dev`; a schema placeholder address needs the real
     address — `seo`; a hub card for a missing service needs its text — `copy`). The report shows
     the team on every defect (the split is hidden in the report for now; the data is kept).
   - Write `{ "summary": "<about the site>", "items": [{ "id": "D3", "verdict": "...", "note": "...", "category": "dev" }], "manual": [ … ] }`
     (`manual`: your Playwright checks and the content check, format in `/qc-browse`) to
     `<runDir>/review-input.json` and run
     `node <plugin-root>/engine/src/cli.js review "<host>" "<runDir>/review-input.json"`. It re-renders
     `report.html`: false positives are left out of the report (the verdict stays in the run and on QC Reports, not shown), the rest
     show your note, and the journeys open the report. Use its printed `verdict`/`distinct`,
     `journeys`, `notReproduced` and `unjudged` in the summary, not the pre-review numbers.
     **`tiles.seen` must equal `tiles.total`** before you publish: the unseen pieces go to a visual
     agent, and the review runs again.
6. Read `reportPath` and publish it with the Artifact tool (icon `checklist`), together with the
   page screenshots in `<runDir>/visual/` as `/qc-browse` «Publishing the report» says — the report
   links them by relative path, so publishing the HTML alone leaves the visual block empty.
   **Load the `artifact-design` skill first** — it is mandatory before authoring or publishing
   artifact HTML, and applies here even though the HTML itself was generated by the engine, not
   written by you.
6b. **Send the results to the QC Reports site** (qc-reports.poirier.agency, a WordPress plugin with
   a public report where people mark defects fixed and search them):

   ```bash
   node <plugin-root>/engine/src/cli.js push "<host>"
   ```

   It sends the reviewed results — defects with their ids, pages, Claude's verdicts, the manual
   checks and their evidence pictures — not the HTML; the full-page screenshots stay in the
   Artifact. Credentials live in `~/.config/qc/reports.json` (`{url, user, appPassword}`); if the
   file is missing, say so and skip this step rather than fail the QC. Give the printed `url` in the
   summary next to the Artifact link. «Fixed» marks are kept per site and defect, so they carry to
   the next scan; a defect marked fixed that this scan found again is flagged "came back".
7. Summarise in chat, in the user’s language. Name every
   defect by its id as the report shows it — `D12` for the engine's (the same as `qc findings`),
   `M3` for your manual ones — so the reader can type it into the report's search:
   - What the site is (your About-the-site lines), then **the journeys first**: each one done or
     not at 360 and 1440, and what stopped it — «booking is broken on a phone» matters more than
     forty minor defects.
   - How many candidates you confirmed, rejected and left unsure, and how many of your own defects
     the second check could not repeat; name the rejected ones briefly so a rule can be fixed.
   - Lead with global errors (header, menu, footer, every page — one fix each), then template
     errors per section, then single pages: the report is grouped the same way.
   - **Verdict** (`verdict`) and the **distinct** counts per severity (critical/major/minor) —
     this is the headline, phrased as "N real defects", not raw occurrence counts.
   - Raw `counts` as a secondary line ("found on M pages"), only if it materially adds
     information (e.g. a single defect repeated on many pages).
   - What is still «needs a look» (your `unsure` verdicts, defects the second check could not
     check either way) and `unjudged` candidates, if any — never silently dropped.
   - The **detected environment** (`env`) and **why** (`envReason`) — the user needs to know this
     because it determines whether `noindex` findings were suppressed (a `dev` classification
     silences `I4`-style findings that would otherwise fire on every page).
   - `diff` (added/fixed/remaining vs the previous run for this host), if `runDir` shows this
     wasn't the first run. The report renders all three as tiles: "new", "fixed", "remaining".
   - The top rule groups by distinct-defect count. Read this off the report, do not invent or
     recompute it: each rule row's summary line reads `<N> defects · <M> pages · <K> findings`,
     where `N` is that row's distinct-defect count — the number to rank by and to quote. Inside the
     row, each distinct defect is rendered as its own block with its own `found` / `expected` /
     `selector` and its own page list, so "8 defects" means eight separately described problems,
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
     `pagesTotal` and the widths checked, and lead with "partial" language rather than a clean
     verdict if `pagesDone < pagesTotal` — a partial browser pass must never be presented as if the
     whole site's visual behaviour was checked.
   - The manual checks (menu, popups, forms, FAQ, focus, content) and the visual review: what you
     checked, what was fine, defects recorded, and what you did not get to.
   - The run directory (`runDir`) and the Artifact link.

## Site facts (E9, E12, H9, H11, and the services/locations list)

Phones, GBP profiles, retired terms, emails and the review rating are checked against a per-host facts file
(`~/.qc-facts/<host>.json`, or `--facts <path>`; format in the engine README, «Site facts»).
Without it H9 and H11 report nothing, and E9 and E12 only compare the site with itself.

- Read `facts` in the summary. If it is `null`, say so in the summary: "no site facts —
  H9/H11 were not checked, E9/E12 compared the site only with itself".
- To create the file, get the values from the user, the client's strategy sheet or the GBP
  listing. Never fill it from the site being audited — that would make every defect match
  itself. If a value is unknown, leave the field out rather than guessing; ask the user for the
  retired services/locations (`banned`), since only they know what the client dropped.
- For `gbp`, take each location's link from GBP's own Share button or from the
  user, plus its address and the site paths of its location page. The link on the site is
  what is being checked, so it cannot be the source.
- Write the file only after the user has confirmed the values, then rerun the audit.

## Rules

- What the engine measured is not re-measured by hand, and what it proposed is never copied into
  the report without your verdict. Your own defects go only through the review file's `manual`,
  each with its evidence, its `impact` and the second check's `verified`; nothing a picture or a
  quote does not show.
- A defect is what is broken or wrong compared with what the site intends — never a design
  suggestion (`qa-playbook.md` «What counts as a defect»).
- Never submit a real form or place an order; ask the user before a test submission.
- If a rule seems wrong, say so and propose a fix to the rule file; do not paper over it in the
  summary or quietly override its output.
- If the input is a Figma link only, tell the user this command needs a site URL — design
  comparison is not part of this version.
- If the sheet's column mapping looks ambiguous (the JSON reports a `source` of `sheet:<name>`
  but a page count far off what the user expects), show the detected sheet and column mapping
  and confirm before continuing.
- If the CLI exits non-zero, or `reportPath` doesn't point to a real file, report the failure
  plainly (with the stderr message) and stop — do not publish an Artifact, do not report a verdict,
  do not guess at numbers.
