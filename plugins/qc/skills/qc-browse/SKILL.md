---
name: qc-browse
description: Run the browser QC pass (visual/interactive checks — horizontal scroll, overflow, overlapping elements, hover/focus, cursor, contrast, a 1920→320 resize sweep, console errors, broken images) over a site that `/qc-site` has already audited, then republish the report with browser findings, breakpoints, and screenshots merged in. Use when the user says "qc browse", "проверь визуально", "прогони браузерную проверку", "сделай скриншоты дефектов", "проверь адаптивность", "browser pass", or asks for visual/responsive checks on top of an existing QC audit.
argument-hint: <host|site-url> [--breakpoints a,b,c] [--pages n] [--force] [--headed]
---

# /qc-browse — browser (visual/interactive) QC pass

The engine (`<plugin-root>/engine`) does all the checking — page navigation, breakpoint resolution,
DOM measurement, screenshot capture, and rule evaluation. Your job is to run its CLI, parse the JSON
it prints, and present the result faithfully. **Never re-implement a check, never eyeball a
screenshot and add your own finding, never guess at a breakpoint or a defect the engine didn't
report.** If a rule looks wrong, say so and propose a fix to the rule file — do not paper over it.

This command does **not** crawl a site itself. It only reads the snapshot `/qc-site` (`qc audit`)
already saved — page list, links, parsed HTML. If that snapshot doesn't exist yet, the engine
refuses to run and says so; tell the user to run `/qc-site` first, don't try to work around it.

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
6. **A successful browser pass does not itself update the report.** `qc browse` only records
   findings to `browser.jsonl` — it does not render or publish HTML. To see the merged report, run
   `/qc-site`'s audit command again on the same host (no need for `--fresh`; the browser findings
   come from `browser.jsonl`, independent of the static snapshot's cache age):

   ```bash
   node <plugin-root>/engine/src/cli.js audit "<site-url>"
   ```

   Read `reportPath` from that summary and publish it with the Artifact tool (favicon `✅`, title
   `QC · <host>`), same as `/qc-site` does. **Load the `artifact-design` skill first** — mandatory
   before publishing artifact HTML.
7. Summarise in chat, in Russian:
   - Coverage first, plainly: "проверено N из M страниц" — and if `pagesDone < pagesTotal` or
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
   - The Artifact link and the run directory (`runDir`, from the republished audit).

## Rules

- Never re-implement a check yourself, and never look at a screenshot and add your own finding — the
  engine already decided what counts as a defect. If a rule seems wrong, say so and propose a fix to
  the rule file; do not paper over it in the summary.
- Never suggest `--force` to "fix" an interrupted or slow run — that discards real, already-captured
  results (findings and screenshots) for every page already checked. `--force` is only for a
  deliberate full re-check the user actually asked for.
- If the CLI exits non-zero, or a snapshot doesn't exist for the host, report the failure plainly
  (with the stderr message) and stop — do not publish an Artifact, do not report coverage numbers,
  do not guess at what a partial or missing run would have found.
- If the user asks to browse a host that was never audited with `/qc-site`, tell them to run
  `/qc-site` first — `qc browse` has no page-discovery of its own and will refuse to run.
