---
name: qc-cache
description: Inspect or clear the QC snapshot cache used by /qc-site. Use when the user says "qc cache", "qc кэш", "очисти кэш qc", "покажи снапшоты", "какие сайты закэшированы", "сделай свежий обход", or wants a fresh crawl instead of a reused snapshot.
argument-hint: list | clear <host> | clear --all
---

# /qc-cache — manage QC snapshots

This skill only runs the engine's `qc cache` subcommand and presents its output — it does not
read, parse, or modify anything under `$QC_CACHE_DIR` directly. Snapshots live in
`$QC_CACHE_DIR` (default `~/.qc-cache/<host>/`) and hold: the last crawl's parsed pages, link-check
results, and per-run `findings.json`/`report.html` history under `runs/`.

## Setup

Resolve the engine path: `<plugin-root>/engine`. If `node_modules` is missing there, run
`npm install` in that directory once (fresh checkout only).

## Commands

- **`list`** → `node <plugin-root>/engine/src/cli.js cache list`
  Present as a table: host, pages, age in days, size. Flag anything older than 7 days as "possibly
  stale — `/qc-site` will still use it by default unless `--fresh` is passed, until it crosses the
  engine's 24h snapshot TTL." If the command prints `пусто`, say the cache is empty — don't invent
  rows.
- **`clear <host>`** → `node <plugin-root>/engine/src/cli.js cache clear <host>`
- **`clear --all`** → `node <plugin-root>/engine/src/cli.js cache clear --all`

Check the exit code on every call. A non-zero exit means the subcommand failed — surface the
stderr message; don't report success from a failed clear/list.

## Before clearing — always warn first

Clearing a host's snapshot deletes its crawled pages/links **and every saved run under
`runs/<timestamp>/`** for that host. The next `/qc-site` audit on that host loses the "fixed since
last run" comparison (`diff.fixed`/`diff.remaining` reset to "no previous run") because
`diffRuns()` has nothing to compare against.

- Before running `clear <host>` or `clear --all`, tell the operator (in Russian) what will be lost:
  the cached pages/links for that host, and the run history that powers "что починили с прошлого
  раза". This applies even if the user only asked to "clear the cache" without mentioning history.
- For `clear --all`, additionally ask for explicit confirmation before running it — it removes
  history for every host in the cache, not just one.
- If the user's actual goal is "just re-crawl, don't reuse the snapshot," prefer suggesting
  `/qc-site <url> --fresh` instead of clearing — that forces a live crawl without destroying the
  run history the diff depends on.

## Presenting results

Summarise in chat in Russian: what was listed or removed, how many hosts/snapshots were affected,
and (for `clear`) a reminder that the next audit on that host will run without diff history until a
new run completes.
