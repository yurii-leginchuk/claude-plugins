---
name: qc-browse
description: Run the browser QC pass (visual/interactive checks — horizontal scroll, overflow, overlapping elements, hover/focus, cursor, contrast, a 1920→320 resize sweep, console errors, broken images, full-page screenshots of every page at every width, and hand checks in Playwright of the mobile menu, popups, forms, FAQ and keyboard focus) over a site that `/qc-site` has already audited, then republish the report with browser findings, breakpoints, and screenshots merged in. Use when the user says "qc browse", "проверь визуально", "прогони браузерную проверку", "сделай скриншоты дефектов", "проверь адаптивность", "browser pass", or asks for visual/responsive checks on top of an existing QC audit.
argument-hint: <host|site-url> [--breakpoints a,b,c] [--pages n] [--force] [--headed]
---

# /qc-browse — browser (visual/interactive) QC pass

The engine (`<plugin-root>/engine`) navigates, measures the DOM at every breakpoint, takes the
screenshots and runs the browser rules. What it measures (horizontal scroll, an element past
the screen, a broken image) is a fact; what it guesses (contrast, overlap, hover, a click, a
console error) is a candidate you settle in Playwright. **You are the QA lead**, as in
`/qc-site`: you also check like a visitor — the journeys, the manual checks below, and a look at
every page's screenshots (`../qc-site/qa-playbook.md`). Your own defects are recorded only through
the review file's `manual`, each with its picture, its `impact` and the second check's result.
If a rule looks wrong, say so and propose a fix to the rule file — do not paper over it.

This command does **not** crawl a site itself. It only reads the snapshot `/qc-site` (`qc audit`)
already saved — page list, links, parsed HTML. If that snapshot doesn't exist yet, the engine
refuses to run and says so; tell the user to run `/qc-site` first, don't try to work around it.

## Language

Reports are **English**: the engine writes its findings in English, and so does everything you add
to them — the About-the-site lines, review notes, manual-check `checked` text, content defects.
The chat summary goes in the language the user writes to you in. Translate a report only if the
user asks for it: translate the HTML artifact (`report.html`) and republish it; the QC Reports site
(`qc push`) takes English only and refuses anything with Cyrillic in it.

## Before you run it

- **This is slow, and it gets slower on a weak or shared staging box.** The page loop is
  deliberately sequential — one Chromium instance, one page at a time, at every breakpoint width —
  because parallel browser contexts against a staging server that already struggles to answer make
  things worse, not faster. Budget roughly a minute or more per page on a slow host (up to 45s per
  page per attempt, with one retry on failure, times however many breakpoints). A few hundred pages
  can run for hours. **Run it in the background and report progress, never block the conversation
  on it finishing.** If the user only wants a look, suggest `--pages 20` (or similar) for a quick
  sample before committing to a full run.
- **It is resumable — an interrupted run should be re-run, never restarted with `--force`.**
  Results are written to `browser.jsonl` one page at a time as the pass progresses, so a crash, a
  Ctrl-C, or a killed background process still leaves every page checked so far on disk. Running the
  *exact same command again* (same host, no `--force`) picks up where it left off — pages already
  checked **successfully** are skipped, not redone, and pages that **would not open** are tried
  again. A failed page is recorded as checked unsuccessfully, never as done, so `--force` is never
  the way to retry one. `--force` **deletes all previously recorded browser findings and
  screenshots for this host and starts over from page one** — only use it when the user explicitly
  wants a full fresh browser pass (e.g. after a site redesign), never as a reflex fix for an
  interrupted run.

## Steps

1. Resolve the engine path: `<plugin-root>/engine`. If `node_modules` is missing there, run
   `npm install` in that directory once (fresh checkout only).
2. Confirm a snapshot exists for this host. If the user hasn't run `/qc-site` on it in this session
   and you're not sure, just run `qc browse` anyway — the engine itself refuses cleanly with a
   message naming `qc audit <input>` as the fix; surface that message rather than guessing whether a
   snapshot exists.
3. Run the browser pass, passing through any flags the user gave, **in the background**:

   ```bash
   node <plugin-root>/engine/src/cli.js browse "<host|url>" [flags]
   ```

   It takes every page that is not a post and the newest 10 posts (`--posts <n>|all`);
   `pagesLeftOut` in the summary says how many older posts were skipped.

4. **Check the exit code before trusting anything on stdout.** A non-zero exit means the pass could
   not start at all — no snapshot, a bad flag value, or an unknown browser rule id in `--only`/
   `--skip`. Surface the stderr message and stop. A **zero** exit, though, does not mean the pass
   necessarily covered every page — read the summary fields below before declaring success.
5. On success, stdout's last line is one JSON object. Read (at minimum): `pagesTotal`, `pagesDone`,
   `pagesFailed`, `failedUrls`, `widths`, `droppedWidths`, `unparseableWidths`, `stoppedEarly`,
   `notes`. **Never claim full coverage without checking `pagesDone` against `pagesTotal` — a
   run that covered 40 of 348 pages must be reported as partial, not as "done".**
   - `stoppedEarly: true` means the pass gave up after 10 consecutive page failures (almost
     certainly a dead or unreachable host) — say so plainly, don't just note the raw counts.
   - `notes` carries operator-relevant caveats the engine itself flagged (e.g. `--concurrency` only
     applying to breakpoint CSS discovery, not the page loop; `--only`/`--skip` filtering only the
     printed summary here, not which rules ran — see the next bullet). Read every entry and mention
     any that apply out loud, don't silently drop them.
   - **`--only`/`--skip` mean something different here than in `/qc-site`.** In `browse`, every
     browser rule always runs against every page — these flags only filter which findings are
     *printed in this command's own summary*. They do **not** control what gets recorded to
     `browser.jsonl` or what a later `/qc-site` report will include. If the user passed either flag,
     say this explicitly so they don't assume a rule was skipped entirely.
6. **Do the manual checks yourself, in Playwright.** The engine never clicks, hovers or tabs, so
   the mobile menu, popups, forms, FAQ accordions and keyboard focus are yours — follow «Manual
   checks» below and keep each result for the review file (`manual`), screenshots included.
7. **A successful browser pass does not itself update the report.** `qc browse` only records
   findings to `browser.jsonl` — it does not render or publish HTML. To see the merged report, run
   `/qc-site`'s audit command again on the same host (no need for `--fresh`; the browser findings
   come from `browser.jsonl`, independent of the static snapshot's cache age):

   ```bash
   node <plugin-root>/engine/src/cli.js audit "<site-url>"
   ```

   Then run `qc findings` / `qc review` as `/qc-site` step 5 describes, with your `manual` entries in
   the review file — that is what puts the manual-checks block and its screenshots into the report. Publish
   it as «Publishing the report» below says. **Load the `artifact-design` skill first** — mandatory
   before publishing artifact HTML.
8. Summarise in chat, in the user’s language:
   - Coverage first, plainly: "N of M pages checked" — and if `pagesDone < pagesTotal` or
     `stoppedEarly`, lead with that, not with the findings. A partial pass must never be presented
     as if it covered the whole site.
   - `widths` actually used, and whether they were discovered from the site's own CSS or given via
     `--breakpoints`; mention `droppedWidths`/`unparseableWidths` if either is non-empty — a media
     condition the engine couldn't resolve to a pixel width is real information, not noise.
   - `pagesFailed` and a sample of `failedUrls`, if any — pages that would not open at all. Say
     that re-running the same command retries exactly those pages; do not suggest `--force`.
   - Once the report is republished (step 6): the same distinct-vs-occurrences framing `/qc-site`
     uses (lead with `distinct`, not raw `counts`), now including browser-only rules (C1/C2, overlap,
     hover/focus/cursor, contrast, elements past the screen edge in the resize sweep (C8), console errors, broken images). The report shows each
     browser finding's breakpoint(s) and, where captured, a screenshot — mention that screenshots are
     only captured once per distinct defect (at the first breakpoint it was seen), so a crop showing
     360px doesn't mean the defect is absent at 1440px if the row also lists 1440 among its
     breakpoints.
   - The manual checks: for each (menu, popup, form, FAQ, focus) the pages × widths you checked,
     what was fine, the defects you recorded; name the ones you did not get to.
   - The visual block: `visual.pages` pages with `visual.files` full-page screenshots (every page
     at every width, defects or not) — say they are in the report for a look by eye.
   - The Artifact link and the run directory (`runDir`, from the republished audit).

## Manual checks (Claude, Playwright MCP)

The engine records full-page screenshots of every page at every width, but it never clicks, hovers
or presses a key. You do, with the `mcp__playwright__*` tools (load them with ToolSearch in one
call: navigate, resize, snapshot, click, hover, type, fill_form, evaluate, take_screenshot,
press_key, console_messages, network_requests, run_code_unsafe). The menu, popup, form, FAQ and
focus checks are template checks: one page per template. The journeys and the visual review
(`../qc-site/qa-playbook.md`) are recorded the same way, as `journey` and `visual` entries.

Screenshots: give `browser_take_screenshot` an absolute `filename` under `~/.qc-cache/<host>/manual/`
(the Playwright MCP refuses paths outside the home directory, the scratchpad included) and list
the same absolute paths in `shots`. Add `?qc=<random>` to every URL so a cached HTML does not
answer.

Every check is recorded as one entry per page × width in the review file's `manual` array:

```json
{ "check": "menu|popup|form|faq|focus|content|visual|journey", "page": "https://site/", "width": 360,
  "status": "ok|defect|skipped", "checked": "what was checked, with numbers",
  "shots": ["/Users/…/.qc-cache/site/manual/menu-360-open.png"],
  "defects": [{ "rule": "D2", "impact": "broken", "verified": "reproduced", "category": "dev",
                "found": "…", "expected": "…", "selector": "…", "shot": 0 }] }
```

A journey adds `"title": "Book a cleaning from a service page"` and `"steps": ["Opened …",
"Tapped «Get a Quote»", …]` — one line per thing the visitor does, in order, and one screenshot
per step in `shots`. `ok` entries go in too — the report shows what was looked at, not only what
broke.

Every defect needs, or the engine refuses the file:
- **evidence**: at least one screenshot in `shots` (`shot` picks which one shows this defect);
  for `content`, the words from the page quoted in `found` («…»);
- **`impact`**: `blocker` (the visitor cannot finish a journey) · `broken` (visibly broken or
  wrong, the journey still possible) · `degraded` (works, worse than it should) · `cosmetic` —
  the engine makes it critical · major · minor · note;
- **`verified`**: the second check's answer — `reproduced`, `not-reproduced` (dropped from the
  report) or `unable` (shown as «needs a look», not counted);
- for `journey` and `visual`, any taxonomy code (`C2`, `B6`, `G14`, `K4`, `E1`, …) with a `title`
  when the code is not one of the manual-check codes below.

**Name a page as a link.** In `found`, `expected`, `checked` and review notes, every page you
mention is written `[Brooklyn](https://site/locations/brooklyn/)` (paths like `/services/x/` and
full URLs become links on their own); the report renders them clickable. Quotes from the site
stay in «…» as they are.

**Timing is not a defect for what the visitor opens themselves.** A popup, a submenu or an
accordion opens on the visitor's click; by the time they reach for its close button or next item,
everything has loaded. If something fails only in the first second or two after it opened, wait
~3 s and try again — record a defect only if it still fails. Timing counts only for what must work
right at page load: the burger, first-screen buttons and links, the form in the hero. A check you
could not do is `skipped` with the reason in `checked`. Each check allows only its own rule codes
(the engine refuses others): menu D1 C2 C6 C9 D9 D2 B6 · popup K4 C6 D9 J2 B6 · form G2 G3 G5 G6 G7 G11
G12 G14 J5 · faq F9 C2 J2 · focus J2 J5 · content H16 H8 H3 H12 E17 · journey and visual: any.

**Check like a visitor, and look at what you opened.** Hover what a visitor hovers, tap what they
tap, open every dropdown, burger, popup and accordion — then, in every open state, look at the
whole screenshot for layout (text past its box, cut labels, overlaps), not only at the thing you
were checking, and run the overflow probe:

```
mcp__playwright__browser_run_code_unsafe { filename: "<plugin-root>/engine/probes/overflow.js" }
```

It lists every run of text that sticks out of the box it is painted in or out of the screen, with
px. Each item it returns is a C2 (in a menu, FAQ) or C6 (past the screen) defect after you have
seen it on the screenshot. A check that only measured focus rings and wrote "all good" next to a
screenshot with labels hanging out of a dropdown is a missed defect.

### Popups

Every button that opens a popup on the checked pages («Get a Quote Now», a quiz, a booking window),
at 360 and 1440: it opens (K4, a blocker, if not); fits the screen with its close button visible, no
horizontal scroll (C6); closes by the cross, by a click outside and by Esc (D9; Esc missing is J2
degraded); the page behind does not scroll while open and comes back after; nothing sticky covers it
(B6). Screenshot it open at both widths.

### Forms (no submission)

Every distinct form (the popup's, contact, any other), at 360 and 1440, **never submitting real
data** — the client gets every lead. Submit it empty: every required field shows an error and has
a `*` (G3); the consent checkbox is required (G2); the email is required (G6); the submit button is
still visible after the error (G7). Type letters into the phone: they must not stay (G5). A focused
field is highlighted (G12). On 360 fields are one column and not cut off (G11). If a test
submission is the only way to check G14, ask the user first. Screenshot the error state.

### FAQ and accordions

One page per template that has them, at 360: open the second item — it opens the second, not
another (F9); the open item's text fits (C2); it opens by Enter/Space from the keyboard (J2, degraded).

### Keyboard focus

One page (home), at 1440 and 360: press Tab from the top through header, the first CTA, one form —
focus is always visible (J5, broken, if it disappears), reaches the menu and the burger (J2), opens
the menu with Enter, and is not trapped. Screenshot a focused element.

### Desktop menu

At 1440 (and at the narrowest width that still shows the desktop menu): open every dropdown the
way a visitor does — `browser_hover` on the parent item. If hover in Playwright opens nothing,
that is usually the stand, not the site (pointer events delegated to a script that synthetic
hover does not trigger): open it with keyboard focus instead (focus the parent link, Tab into the
submenu) and check it the same way; never record D1 for a desktop dropdown on Playwright hover
alone. In each open dropdown: screenshot, the overflow probe, every item readable inside the
panel (C2, broken, when labels run past it), the panel within the screen (C6), nothing covering it
(B6).

### Mobile menu

- **Pages:** the home page plus one page of every other template the profile shows (a service, a
  location, a post, contact). When the audit summary's browser `regions` show the header container
  on every page, the home page alone is enough — say so in `checked`; if headers differ (another
  header template, a landing page), check each.
- **Locating things:** several `.elementor-menu-toggle` usually exist (footer menus have them too);
  scope selectors to the header widget, and add `>> nth=0` where Elementor/ECM renders two
  `.sub-arrow` in one item.
- **Widths:** every browse width at which the header shows a burger instead of the menu (usually
  360 and 768, often 1024). Add `?qc=<random>` to the URL so a cached HTML does not answer.
- **First, the desktop menu** (widest width): one `browser_evaluate` collecting every `href` and
  text inside the header navigation, submenus included (hidden ones too) — that is the list to
  compare with.
- **At each mobile width:**
  1. `browser_resize` (width × 900), navigate, `browser_take_screenshot` of the closed header.
  2. Tap the burger (`browser_snapshot` → `browser_click` on its ref). Screenshot the open menu.
  3. One `browser_evaluate` on the open panel: its box against `innerWidth` (full width? past the
     left/right edge, by how many px?), `documentElement.scrollWidth` against `clientWidth`, the
     panel's links (href + text), the last item's bottom against `innerHeight` and whether the panel
     or the page can scroll to it. If the last item is below the screen, scroll the panel and
     screenshot its bottom.
  4. Open every submenu (its arrow, or the parent item): it must expand and not navigate away.
     Screenshot one expanded submenu.
  5. Close it (burger again, or the close button): the menu must disappear.
  6. Compare the panel's links with the desktop list: missing pages and extra ones. A mobile menu
     built as a separate widget is where items go missing.
- **Record** `check: "menu"`, e.g. `checked`: "opens on tap; 360 of 360 px; does not cross the
  edge; 9 items, the last one visible; the Services submenu expands; closes with the cross;
  links match the desktop menu (11 of 11)". Rules and impact: **D1** the burger opens nothing (blocker) or a submenu does not open /
  taps navigate away (broken); **C6** the open menu sticks out of the screen (broken); **C9** the last
  items cannot be reached (broken); **D9** the menu does not close (broken); **D2** a desktop item is
  missing on mobile (broken), an extra mobile item (degraded — skip phone/CTA buttons the desktop header
  also has). A menu narrower than the screen is not a defect by itself: say it in `checked`, and
  record it as C6 only when it looks broken (cut text, a strip stuck to the toggle). A sticky bar or
  widget lying over the open menu is **B6**.

## Publishing the report

The report links its screenshots by relative path (`visual/<file>`), so they are published with it:
`Artifact` with `file_path` = `reportPath` and `files` = one entry per file in `<runDir>/visual/`
(`{"visual/<file>": "<runDir>/visual/<file>"}`). Limits per publish: 255 files and 64 MB — over that,
publish the report with the first batch, then publish the rest to the same `url` in further calls
(files left out are kept). Sources must sit under the working directory or the scratchpad; if the
run dir does not, copy `report.html` and `visual/` into the scratchpad first.

## Rules

- Never re-measure by hand what the engine measured. Your own defects (manual checks, journeys,
  the visual review) go only through the review file's `manual`, with their picture, `impact`
  and `verified`; a defect is what is broken or wrong, never a design suggestion. If a rule
  seems wrong, say so and propose a fix to the rule file; do not paper over it in the summary.
- Never suggest `--force` to "fix" an interrupted or slow run — that discards real, already-captured
  results (findings and screenshots) for every page already checked. `--force` is only for a
  deliberate full re-check the user actually asked for.
- If the CLI exits non-zero, or a snapshot doesn't exist for the host, report the failure plainly
  (with the stderr message) and stop — do not publish an Artifact, do not report coverage numbers,
  do not guess at what a partial or missing run would have found.
- If the user asks to browse a host that was never audited with `/qc-site`, tell them to run
  `/qc-site` first — `qc browse` has no page-discovery of its own and will refuse to run.
