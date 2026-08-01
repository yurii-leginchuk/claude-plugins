export const meta = {
  id: 'F1',
  title: 'Нет реакции на hover',
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
  for (let s = 0; s < sheets.length; s++) {
    let rules
    try { rules = sheets[s].cssRules } catch (e) { continue }
    if (!rules) continue
    for (let r = 0; r < rules.length; r++) {
      const sel = rules[r].selectorText
      if (!sel || !/:hover\b/.test(sel)) continue
      const target = sel.replace(/:hover\b/g, '').trim()
      if (target) targets.push(target)
      // Split on combinators/commas into individual compounds and keep only
      // the ones that actually carry :hover -- this is a light heuristic
      // tokeniser (it does not special-case spaces inside attribute-selector
      // brackets), acceptable for a heuristic rule and consistent with how
      // F5 already reads selectorText.
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
      rule: 'F1', title: 'Нет реакции на hover', severity: 'major', confidence: 'heuristic',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: sel,
      containerId: ctx.helpers.containerId(el),
      found: 'ни одно правило :hover не покрывает этот элемент',
      expected: 'видимая реакция на наведение',
    })
  }
  return out
}
