export const meta = {
  id: 'F5',
  title: 'Изменение на hover без transition',
  severity: 'minor',
  confidence: 'high',
}

// Runs inside the page. Self-contained by contract -- see _helpers.js's
// top-of-file comment for why every constant this needs must live inside
// check() rather than at module scope.
export function check(ctx) {
  // preparePage (Task 1) injects `transition:none!important` on every
  // element so measurements are repeatable, which makes the COMPUTED
  // transition empty everywhere -- reading getComputedStyle().transition
  // here would report that nothing on the site has a transition, always.
  // The only reliable signal left is what the author actually declared, so
  // this walks document.styleSheets and reads cssRules directly. A
  // cross-origin stylesheet throws on `.cssRules` access; when that happens
  // the sheet is skipped rather than guessed at, since a finding this rule
  // can't substantiate is worse than a finding it never made.
  const out = []
  let sheets
  try { sheets = document.styleSheets } catch (e) { return [] }

  // Splits a (possibly grouped) selectorText on its TOP-LEVEL commas only --
  // a comma inside `[]` (an attribute value) or `()` (a functional
  // pseudo-class like :not(a, b)) does not start a new compound. Needed
  // because naively stripping ':hover' from the WHOLE selectorText of a
  // grouped rule mixes UNRELATED sibling compounds into the derived base.
  // Measured live (task 11, cleaningny.com): a real rule grouped a genuine
  // `...elementor-menu-toggle:focus:hover` compound alongside five sibling
  // compounds that never mention ':hover' at all (a dropdown menu's plain
  // `a`, `a:focus`, `a.elementor-item-active`, `a.highlighted`, and the bare
  // `.elementor-menu-toggle`) -- the old whole-string strip turned all six
  // into one `document.querySelectorAll()` target, flagging nav menu links
  // and a menu-toggle button that have nothing to do with the actual hover
  // rule. Splitting into groups first and keeping only the group(s) that
  // themselves contain ':hover' fixes that at the source.
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

  // Full selectorText (possibly grouped, e.g. "a, button" or a class like
  // ".btn") of every non-hover rule that declares a real transition.
  // Matched against elements individually below via el.matches() rather than
  // compared as strings against the hover rule's own selector -- a plain
  // string comparison misses a transition declared on a grouped selector, a
  // shared utility class, or a `*` reset, all of which are common in
  // production themes and all of which legitimately cover an element whose
  // OWN :hover rule uses a different selector text entirely.
  const transitionSelectors = []
  const hoverRules = []     // { base, text }

  for (let s = 0; s < sheets.length; s++) {
    let rules
    try { rules = sheets[s].cssRules } catch (e) { continue }   // cross-origin sheet
    if (!rules) continue
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r]
      if (!rule.selectorText) continue

      if (/:hover\b/.test(rule.selectorText)) {
        // Judgement call: a :hover rule that changes nothing visible (an
        // empty block, or one that only sets a custom property) declares a
        // hover state without any perceptible effect -- there's nothing to
        // transition, so it isn't treated as "has a hover" at all. A
        // custom-property-only rule (`--x: red`) might matter elsewhere via
        // var(), but that's invisible from here; flagging it would trigger
        // on every hover-driven theming toggle regardless of whether it
        // does anything, which is exactly the false positive this rule must
        // avoid emitting.
        let hasVisibleChange = false
        for (let p = 0; p < rule.style.length; p++) {
          if (rule.style[p].indexOf('--') !== 0) { hasVisibleChange = true; break }
        }
        if (!hasVisibleChange) continue
        // Only the individual comma-separated group(s) that actually carry
        // ':hover' become a base -- a sibling compound in the same group
        // without ':hover' (e.g. "a:active" beside "a:hover", or the whole
        // menu-toggle case above) describes something else entirely and
        // must not be folded into this rule's target. See
        // splitSelectorGroups' comment above.
        const groups = splitSelectorGroups(rule.selectorText)
        for (let g = 0; g < groups.length; g++) {
          if (!/:hover\b/.test(groups[g])) continue
          const base = groups[g].replace(/:hover\b/g, '').trim()
          if (base) hoverRules.push({ base: base, text: rule.cssText })
        }
      } else {
        // "Declares a transition" means a real one -- preparePage (Task 1)
        // injects `*,*::before,*::after{transition:none!important}` on
        // every page so measurements are repeatable, and that rule's
        // cssText plainly contains the word "transition". A naive substring
        // or property-presence check treats that universal reset as if
        // every element on every page had an authored transition, which
        // would silently zero out this entire rule. `transition: none` (or
        // `transition-property: none`) is the ABSENCE of a transition, not
        // a declaration of one, so it's explicitly excluded here.
        const val = rule.style
          ? (rule.style.getPropertyValue('transition') || rule.style.getPropertyValue('transition-property'))
          : ''
        const norm = (val || '').trim().toLowerCase()
        if (norm && norm !== 'none') transitionSelectors.push(rule.selectorText)
      }
    }
  }

  const hasDeclaredTransition = function (el) {
    for (let i = 0; i < transitionSelectors.length; i++) {
      try {
        if (el.matches(transitionSelectors[i])) return true
      } catch (e) { continue }   // unparseable/unsupported selector -- skip, don't guess
    }
    return false
  }

  const seen = {}
  for (let i = 0; i < hoverRules.length; i++) {
    const base = hoverRules[i].base.trim()
    if (!base) continue
    let els
    try { els = document.querySelectorAll(base) } catch (e) { continue }
    for (let j = 0; j < els.length; j++) {
      const el = els[j]
      if (!ctx.helpers.visible(el)) continue
      if (hasDeclaredTransition(el)) continue
      const sel = ctx.helpers.selector(el)
      if (seen[sel]) continue
      seen[sel] = 1
      out.push({
        rule: 'F5', title: 'Изменение на hover без transition', severity: 'minor',
        confidence: 'high', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
        selector: sel, containerId: ctx.helpers.containerId(el),
        found: 'правило ' + base + ':hover меняет стиль без transition',
        expected: 'добавить transition',
      })
    }
  }
  return out
}
