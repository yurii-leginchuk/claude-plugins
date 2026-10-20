export const meta = {
  id: 'F1',
  title: 'No hover response',
  severity: 'major',
  confidence: 'heuristic',
}

// Runs inside the page. Self-contained by contract -- see _helpers.js's
// top-of-file comment for why every constant this needs must live inside
// check() rather than at module scope.
export function check(ctx) {
  // Same reasoning as F5 (Task 4): preparePage injects
  // `transition:none!important` on every element for repeatable measurement,
  // which makes computed styles useless for detecting a hover effect, and a
  // headless pass cannot synthesise a real :hover pseudo-class anyway. The
  // only reliable signal is what the author actually declared in
  // document.styleSheets. A cross-origin stylesheet throws on `.cssRules` --
  // that sheet is skipped rather than guessed at, same as F5.
  //
  // Two matchers are built from every rule whose selectorText contains
  // ":hover", because a hover effect reaches an element in one of two
  // distinct ways and only checking one direction produces false positives:
  //
  //   1. `targets`: the FULL selector with every ":hover" occurrence
  //      stripped, matched structurally. This catches "el is the element
  //      that visibly changes", including when the :hover lives on an
  //      ANCESTOR compound (".card:hover a" strips to ".card a", and the
  //      <a> itself matches that as a descendant of .card -- exactly the
  //      common theme pattern of writing the hover on a wrapper rather than
  //      on the link).
  //   2. `triggers`: just the individual COMPOUND that carries ":hover"
  //      (".card:hover a" contributes only ".card", not ".card a"),
  //      matched directly against the candidate. This catches "hovering el
  //      itself is what triggers a change elsewhere", e.g.
  //      ".dropdown:hover .menu { display:block }" -- the toggle button
  //      (class "dropdown") has a real, visible hover reaction (revealing a
  //      menu) even though nothing about the button's OWN computed style
  //      changes and it never appears on the right-hand side of any rule.
  //
  // Both matchers only ever consider text that literally contains ":hover",
  // so the injected `*,*::before,*::after{transition:none!important}` reset
  // (no :hover in its selector) can never leak into either list and cause a
  // false "covered" -- the exact way F5 was nearly zeroed by that same
  // injected rule (there, via the transition VALUE looking meaningful; here
  // the analogous risk is a selector looking meaningful when it isn't, so
  // both matchers stay scoped strictly to rules that actually declare hover).
  const targets = []
  const triggers = []
  let sheets
  try { sheets = document.styleSheets } catch (e) { return [] }

  // Splits a (possibly grouped) selectorText on its TOP-LEVEL commas only --
  // a comma inside `[]`/`()` does not start a new compound. Shared reasoning
  // with F5 (see that rule's own copy of this function for the live example
  // that proved it matters): naively stripping ':hover' from the WHOLE
  // selectorText of a grouped rule folds in sibling compounds that never
  // carry ':hover' at all. For F5 that inflated its target set (noise); for
  // F1 the SAME bug under-reports instead -- an over-broad `target` marks
  // candidates as "covered by a hover rule" that the actual :hover compound
  // never touches, hiding a genuine "no hover reaction" finding. Measured
  // live (task 11, cleaningny.com): F1 produced zero findings across 7
  // successful pages, and this is why -- a handful of real, large grouped
  // selectors (nav dropdowns, Elementor pointer-effect classes) were wide
  // enough, once every sibling compound was folded in, to mark most of a
  // page's interactive candidates "covered".
  const splitSelectorGroups = function (sel) {
    const parts = []
    let depth = 0
    let cur = ''
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i]
      if (c === '[' || c === '(') depth++
      else if (c === ']' || c === ')') depth--
      if (c === ',' && depth <= 0) { parts.push(cur); cur = '' } else cur += c
    }
    if (cur.trim()) parts.push(cur)
    return parts.map(function (s) { return s.trim() }).filter(Boolean)
  }

  for (let s = 0; s < sheets.length; s++) {
    let rules
    try { rules = sheets[s].cssRules } catch (e) { continue }
    if (!rules) continue
    for (let r = 0; r < rules.length; r++) {
      const sel = rules[r].selectorText
      if (!sel || !/:hover\b/.test(sel)) continue

      // Only the individual comma-separated group(s) that actually carry
      // ':hover' become a target -- see splitSelectorGroups' comment above.
      const groups = splitSelectorGroups(sel)
      for (let g = 0; g < groups.length; g++) {
        if (!/:hover\b/.test(groups[g])) continue
        const target = groups[g].replace(/:hover\b/g, '').trim()
        if (target) targets.push(target)
      }

      // Split on combinators/commas into individual compounds and keep only
      // the ones that actually carry :hover -- this is a light heuristic
      // tokeniser (it does not special-case spaces inside attribute-selector
      // brackets), acceptable for a heuristic rule. Unlike `targets` above,
      // this one is not vulnerable to the grouped-selector bug: it already
      // extracts individual compounds (splitting on combinators AND commas
      // alike), so a non-hover sibling compound was never folded in here.
      const tokens = sel.match(/[^\s,>+~]+/g) || []
      for (let t = 0; t < tokens.length; t++) {
        if (!/:hover\b/.test(tokens[t])) continue
        const trigger = tokens[t].replace(/:hover\b/g, '').trim()
        if (trigger) triggers.push(trigger)
      }
    }
  }

  const out = []
  const seen = {}
  const candidates = document.querySelectorAll('a[href], button, [role="button"]')
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]
    if (!ctx.helpers.visible(el)) continue
    let covered = false
    for (let h = 0; h < targets.length && !covered; h++) {
      try { if (el.matches(targets[h])) covered = true } catch (e) { /* bad selector */ }
    }
    for (let h = 0; h < triggers.length && !covered; h++) {
      try { if (el.matches(triggers[h])) covered = true } catch (e) { /* bad selector */ }
    }
    if (covered) continue
    const sel = ctx.helpers.selector(el)
    if (seen[sel]) continue
    seen[sel] = 1
    out.push({
      rule: 'F1', title: 'No hover response', severity: 'major', confidence: 'heuristic',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sel,
      containerId: ctx.helpers.containerId(el),
      found: 'no :hover rule covers this element',
      expected: 'a visible response on hover',
    })
  }
  return out
}
