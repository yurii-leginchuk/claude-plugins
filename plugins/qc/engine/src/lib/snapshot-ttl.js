// The one number that both halves of the snapshot-reuse contract must agree
// on: how long a cached crawl is trusted as a stand-in for a live one
// (cli.js's `loadFreshSnapshot`), and how old a REUSED snapshot has to be
// before the report warns a reader it might be stale (report/html.js's
// banner). These used to be two independent literals -- `24h` in cli.js,
// `7 days` in report/html.js -- and drifted; commit dc6889e's message
// claimed reconciling them at "7 days, matching the report's banner", but
// setting the reuse TTL to the SAME 7 days as the banner threshold only
// swapped which of the two numbers was wrong. `loadFreshSnapshot` refuses a
// snapshot at `ageMs >= SNAPSHOT_TTL_MS` -- so every snapshot that ever
// reaches the report is, by construction, strictly YOUNGER than the TTL.
// A banner that fires at `snapshotAgeDays > 7` when reuse itself caps
// `snapshotAgeDays` below 7 can never fire: dead code again, just with a
// different literal wearing the blame.
//
// Both numbers live here now, and the banner threshold is DERIVED from the
// TTL rather than restated, so the two cannot drift apart a third time --
// and, critically, is set strictly below the TTL so the banner is actually
// reachable: a snapshot old enough to be in its last day of eligibility for
// reuse is old enough to tell a reader about.
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d
export const SNAPSHOT_TTL_DAYS = SNAPSHOT_TTL_MS / (24 * 60 * 60 * 1000)

// Warn during the final day before a snapshot ages out of the reuse window,
// not only once it already has (which -- see above -- is unreachable by
// definition). `STALENESS_WARNING_DAYS < SNAPSHOT_TTL_DAYS` is the property
// that makes the banner reachable at all; a test pins exactly that.
export const STALENESS_WARNING_DAYS = SNAPSHOT_TTL_DAYS - 1 // 6d of a 7d TTL
