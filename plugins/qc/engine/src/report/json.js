const ORDER = { critical: 0, major: 1, minor: 2, note: 3 }

/**
 * Rules whose 'found' values contain fluctuating counts that don't reflect
 * the actual defect. Map each rule to the normalization pattern.
 * For rules not listed here, the exact 'found' value is part of the defect identity.
 */
const RULES_WITH_FLUCTUATING_COUNTS = {
  // I1 emits "H1 не найден" or "H1 на странице: N" -- N is how many H1s the
  // page has, and "two H1s here, three there" is one defect (the template
  // emits the wrong number of H1s), not two.
  I1: /\d+/g,
  // I6 emits "title пустой" or `дубль title на N страницах: "<title>"` -- N is
  // how many pages currently share that title, which moves as pages are added
  // or fixed while the duplicate-title defect stays the same one.
  I6: /\d+/g,
  // NOTE: the previous comments here described I1 as "Missing N images" and I6
  // as "N broken links". Neither rule has ever emitted either string. These
  // comments sit on defectIdentity, which the whole distinct/diff contract
  // depends on, so they are worth keeping accurate.
}

/**
 * Normalize volatile patterns in the 'found' value only for rules where
 * the digits represent discovered quantities rather than the defect itself.
 * For other rules, the exact value is the defect identity.
 *
 * Examples:
 * - I1 "H1 на странице: 2" vs "H1 на странице: 3" → normalize to same, both represent
 *   "this template emits the wrong number of H1s"
 * - E4 "tel:855-607-8758" vs "tel:855-607-8759" → keep different, different phone numbers are different bugs
 * - E1 "HTTP 404" vs "HTTP 500" → keep different (though defensive; 4xx vs 5xx should probably normalize)
 */
function normalizeFound(found, rule) {
  if (typeof found !== 'string') return found
  // Console lines carry per-request URLs and tokens (Cloudflare Turnstile
  // logs a fresh challenge id each time): one error, hundreds of texts.
  if (rule === 'X1') {
    return found.replace(/https?:\/\/([^/\s]+)[^\s]*/g, '$1/…').replace(/[A-Za-z0-9_.-]{24,}/g, '…')
  }

  const pattern = RULES_WITH_FLUCTUATING_COUNTS[rule]
  if (!pattern) {
    // No normalization needed for this rule - exact value matters
    return found
  }

  // Replace counts with placeholder for this rule
  return found.replace(pattern, 'N')
}

// The core identity of a *defect*, independent of which page it happens to
// show up on: the same rule flagging the same selector with the same
// (normalized) `found` text is one underlying problem, whether it appears
// once or on every page of the site (e.g. a footer link repeated across 31
// pages is one defect, not 31). There is deliberately no `page` in this key
// -- that was already true before regions existed, and stays true now.
//
// `region` (see src/browser/regions.js) is a *label* for the report ("this
// is the footer, fix it once") and, at most, an extra discriminator: when
// present it is appended to the base key, so it can only ever SPLIT an
// identity further (e.g. two coincidentally-identical texts that live in
// two different proved-shared regions), never MERGE two identities that
// were previously distinct. When `region` is absent -- the overwhelming
// majority of findings, since only proved-shared containers carry one --
// the key is byte-identical to the pre-region key, so every previously
// computed distinct count is unchanged. This was gotten wrong in an earlier
// pass of this same task (region replaced page in the key, undoing the
// page-independent collapsing above and inflating a real site's distinct
// major count from 15 to 54); the fix is this file's history, not a retry.
//
// `countDistinct()` in cli.js keys off exactly this function, and `key()`
// below builds on it (adding page) for diffRuns' per-page-occurrence
// tracking -- so "how many distinct defects" and "what changed since last
// run" can never define sameness differently by accident.
export function defectIdentity(f) {
  const base = [f.rule, f.selector, normalizeFound(f.found, f.rule)].join('|')
  return f.region ? `${base}|region:${f.region}` : base
}

const key = (f) => `${defectIdentity(f)}|${f.page}`

export function rollUp(findings) {
  // Validate that findings is an array (not just iterable, which includes strings)
  if (!Array.isArray(findings)) {
    const received = findings === null ? 'null' : findings === undefined ? 'undefined' : typeof findings
    throw new TypeError(`rollUp requires an array, got ${received}`)
  }

  // Grouped by rule + severity + confidence, not by rule alone: a single
  // rule (E3, say) can legitimately emit findings at more than one severity
  // -- an internal target=_blank house-rule violation at major next to an
  // external missing-noopener hygiene issue at minor. Collapsing those into
  // one rule-wide row (keyed on rule alone, "most severe wins") would hide
  // the whole point of splitting a rule's findings by certainty: the report
  // would show one "Major" chip covering both, exactly the flood this
  // calibration was meant to fix. Each (rule, severity, confidence)
  // combination gets its own row/chip instead.
  //
  // Within a group, findings are further split by defectIdentity() -- the
  // same definition of "one defect" countDistinct() and diffRuns() use.
  // Without that split the report rendered a single found/expected/selector
  // per group and silently dropped every other distinct defect underneath it:
  // on the real cleaningny.com run, 25 distinct solid defects but only 10
  // described in the HTML. The eight distinct E3 majors are eight different
  // links; the report showed one, and one of the two Criticals appeared
  // nowhere while the tile still said "Critical 2". A rendered report that
  // silently omits 60% of the defects it counted is worse than no report,
  // because it looks complete -- so `identities` is not optional detail, it
  // is the group's actual content.
  const groups = new Map()
  for (const f of findings) {
    const groupKey = `${f.rule}|${f.severity}|${f.confidence}`
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        rule: f.rule, title: f.title, severity: f.severity,
        confidence: f.confidence, count: 0, pages: new Set(), example: f,
        identities: new Map(),
      })
    }
    const g = groups.get(groupKey)
    g.count++
    g.pages.add(f.page)

    const identity = defectIdentity(f)
    if (!g.identities.has(identity)) {
      g.identities.set(identity, {
        identity, found: f.found, expected: f.expected, selector: f.selector,
        count: 0, pages: new Set(), example: f, where: {}, zones: new Set(),
      })
    }
    const d = g.identities.get(identity)
    d.count++
    d.pages.add(f.page)
    // Where on each page, so the reader finds the spot without the selector.
    if (f.where && !d.where[f.page]) d.where[f.page] = f.where
    if (f.zone) d.zones.add(f.zone)
  }

  return [...groups.values()].map(g => ({
    ...g,
    pages: [...g.pages],
    // Most-repeated defect first, then a stable tiebreak on `found` so the
    // same run always renders in the same order.
    identities: [...g.identities.values()]
      .map(d => ({ ...d, pages: [...d.pages] }))
      .sort((a, b) => (b.count - a.count) || String(a.found).localeCompare(String(b.found))),
  })).sort((a, b) => {
    const aOrder = ORDER[a.severity] ?? 999
    const bOrder = ORDER[b.severity] ?? 999
    return (aOrder - bOrder) || (b.count - a.count)
  })
}

export function verdict(findings) {
  const solid = findings.filter(f => f.confidence !== 'heuristic')
  if (solid.some(f => f.severity === 'critical')) return 'Fail'
  if (solid.some(f => f.severity === 'major')) return 'Needs fixes'
  return 'Pass'
}

// `counts` (built by the caller, see cli.js) answers "how many raw
// occurrences" -- useful for gauging blast radius (a defect hitting 31
// pages is worse than one hitting 1). `countDistinct` answers a different
// question: "how many actual defects does a human need to go fix," which is
// what a summary consumer (a Claude skill, a person skimming stdout) needs
// in order not to overstate the remaining work by an order of magnitude
// when one template-level bug is repeated across every page.
//
// Keyed on defectIdentity() (rule + selector + normalized found, plus an
// optional region suffix -- no page), the same identity diffRuns' own key()
// builds on -- so "how many distinct defects" and "what changed since last
// run" can never disagree about what counts as "the same defect". Only non-heuristic findings are counted,
// mirroring `counts` so the two blocks describe the same population and
// remain directly comparable (raw vs. distinct of the same solid findings).
export function countDistinct(findings) {
  const seen = { critical: new Set(), major: new Set(), minor: new Set(), note: new Set() }
  for (const f of findings) {
    if (f.confidence === 'heuristic') continue
    const bucket = seen[f.severity]
    if (!bucket) continue // unknown severity: not counted, matches counts' implicit contract
    bucket.add(defectIdentity(f))
  }
  return {
    critical: seen.critical.size, major: seen.major.size,
    minor: seen.minor.size, note: seen.note.size,
  }
}

export function diffRuns(current, previous) {
  // Validate current is an array
  if (!Array.isArray(current)) {
    const received = current === null ? 'null' : current === undefined ? 'undefined' : typeof current
    throw new TypeError(`diffRuns requires current to be an array, got ${received}`)
  }

  // Validate previous is null/undefined or an array (null is allowed as "no previous run")
  if (previous !== null && previous !== undefined && !Array.isArray(previous)) {
    const received = typeof previous
    throw new TypeError(`diffRuns requires previous to be null, undefined, or an array, got ${received}`)
  }

  // Handle null/missing previous
  const prevList = previous || []

  // Count occurrences of each identity in both runs
  const prevCounts = new Map()
  const prevExamples = new Map()  // Keep one example of each key for output
  for (const f of prevList) {
    const k = key(f)
    prevCounts.set(k, (prevCounts.get(k) || 0) + 1)
    if (!prevExamples.has(k)) prevExamples.set(k, f)
  }

  const curCounts = new Map()
  const curExamples = new Map()
  for (const f of current) {
    const k = key(f)
    curCounts.set(k, (curCounts.get(k) || 0) + 1)
    if (!curExamples.has(k)) curExamples.set(k, f)
  }

  // Build result arrays with multiplicity
  const fixed = []
  const remaining = []
  const added = []

  // Iterate once over all unique keys from both runs
  const allKeys = new Set([...prevCounts.keys(), ...curCounts.keys()])

  for (const k of allKeys) {
    const prevCount = prevCounts.get(k) || 0
    const curCount = curCounts.get(k) || 0

    if (prevCount > curCount) {
      // Some instances were fixed
      const numFixed = prevCount - curCount
      const example = prevExamples.get(k)
      for (let i = 0; i < numFixed; i++) {
        fixed.push(example)
      }
    }

    if (curCount > 0 && prevCount > 0) {
      // Some instances remain (exist in both)
      const numRemaining = Math.min(prevCount, curCount)
      const example = curExamples.get(k)
      for (let i = 0; i < numRemaining; i++) {
        remaining.push(example)
      }
    }

    if (curCount > prevCount) {
      // Some instances are new or increased
      const numAdded = curCount - prevCount
      const example = curExamples.get(k)
      for (let i = 0; i < numAdded; i++) {
        added.push(example)
      }
    }
  }

  return { fixed, remaining, added }
}
