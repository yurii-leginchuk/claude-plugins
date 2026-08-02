// Injected into the page as `ctx.helpers`. Must be self-contained: this whole
// object is serialised, so nothing here may reference module scope.
//
// Deliberately written with explicit `function` expressions instead of
// ES2015 method shorthand (`selector(el) {...}`). Shorthand methods stringify
// with their name still attached (`"selector(el) {...}"`), which is invalid
// syntax once spliced back in as an object-literal value (`selector:
// selector(el) {...}`) -- that broke bundle.js's serialiser once already.
// Writing every entry as `key: function (...) {...}` sidesteps the whole bug
// class instead of requiring a source-rewrite step in the bundler. Keep this
// style for any helper added later.
export const helpers = {
  // An id containing a long run of digits (10+) reads as machine-generated
  // per page-load rather than a stable, semantic identifier -- e.g. a
  // SmartMenus-style nav plugin assigning `id="sm-17856341663330366-3"`
  // fresh on every render (the digits are a timestamp/counter, different
  // every time even for the exact same nav item on the exact same page).
  // Trusting it in selector() below would make defectIdentity (report/
  // json.js, which keys directly off that string) treat the SAME recurring
  // defect as a brand-new one on every page/width combination. Measured
  // live (task 11, cleaningny.com): one real dropdown-arrow defect inflated
  // into 13 separate "distinct" findings purely from this, the dominant
  // single contributor to that rule's inflated distinct count. A normal
  // short numeric id (WordPress's own `id="menu-item-42"`, a Gravity Forms
  // `id="label_3_9_0"`) has no 10-digit run and is untouched -- this is
  // narrowly the "looks like Date.now()" shape, not numeric ids in general.
  // Shared by BOTH the element's own id and its parent's (selector() reads
  // a PARENT's id too, for the "tag#id > tag.class" form) -- an unstable id
  // half-fixed on one side and still leaking on the other would still
  // churn every composite selector string built from it.
  stableId: function (el) {
    return el && el.id && !/\d{10,}/.test(el.id) ? el.id : null
  },
  selector: function (el) {
    if (!el || !el.tagName) return 'node'
    const tag = el.tagName.toLowerCase()
    const id = this.stableId(el)
    if (id) return tag + '#' + id
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2)
    const own = cls.length ? tag + '.' + cls.join('.') : tag
    const p = el.parentElement
    if (!p || p === document.body || p === document.documentElement) return own
    const ptag = p.tagName.toLowerCase()
    const pid = this.stableId(p)
    const pdisp = pid ? ptag + '#' + pid : ptag
    return pdisp + ' > ' + own
  },
  visible: function (el) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  },
  // The nearest ancestor (inclusive of `el` itself) carrying an
  // `elementor-<id>` class, or null. This exists so a rule can capture which
  // Elementor container a finding lives in WHILE IT STILL HOLDS THE ELEMENT
  // -- re-deriving the same answer later from `selector` alone (a display
  // string built by `selector()` above, which truncates class lists and
  // ancestry) is not reliable: two elements in different containers can
  // legitimately produce the identical selector string (e.g. a header nav
  // link and a footer nav link both rendering as "div > a.soc"), and
  // re-querying the DOM with that string only ever finds the FIRST match,
  // silently mis-attributing every later occurrence to the wrong container.
  // See src/browser/regions.js and the Task 7 review that caught this.
  containerId: function (el) {
    var cur = el
    while (cur && cur.nodeType === 1) {
      var classes = cur.classList ? Array.prototype.slice.call(cur.classList) : []
      for (var i = 0; i < classes.length; i++) {
        var m = /^elementor-(\d+)$/.exec(classes[i])
        if (m) return m[1]
      }
      cur = cur.parentElement
    }
    return null
  },
  interactive: function (el) {
    const tag = el.tagName.toLowerCase()
    // `aria-haspopup="true"` (or a specific popup type -- menu/listbox/
    // dialog/etc) on ANY element is a standard ARIA signal that it manages a
    // popup/submenu, genuinely clickable regardless of tag or `href`.
    // Checked FIRST, before any tag-specific branch returns early: measured
    // live (task 11, cleaningny.com), a nav item that is purely a submenu
    // TOGGLE -- no direct destination, so authored as `<a
    // aria-haspopup="true" aria-expanded="false">` with no `href` at all --
    // was flagged "cursor:pointer on a non-interactive element". Placing
    // this check after the `tag === 'a'` branch (which returns on
    // `hasAttribute('href')` alone) would never reach it for exactly the
    // tag this defect occurs on.
    if (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false') return true
    if (tag === 'a') return el.hasAttribute('href')
    if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true
    if (tag === 'input') return el.type !== 'hidden'
    // A <label> associated with a form control -- via `for`, or by wrapping
    // the control directly -- is genuinely clickable: activating it (a
    // click, or assistive tech) focuses/toggles the control it labels. It
    // has no NATIVE browser cursor:pointer of its own, so an author who
    // explicitly sets one (a common, correct, accessible pattern for a
    // clickable checkbox/radio label) is not creating a defect. Measured
    // live (task 11, cleaningny.com): every Gravity Forms radio-option
    // label on a real form was flagged "cursor:pointer on a non-interactive
    // element" purely because <label> was missing from this list -- 70
    // occurrences, the single largest F4 false-positive bucket. A <label>
    // with neither `for` nor a wrapped control is NOT made interactive by
    // this branch (it genuinely isn't clickable-to-any-effect), so this
    // does not blanket-exempt every <label> on a page.
    if (tag === 'label') {
      if (el.htmlFor) return true
      return !!el.querySelector('input, select, textarea')
    }
    const role = el.getAttribute('role')
    return ['button', 'link', 'tab', 'menuitem'].includes(role)
  },
  luminance: function (rgb) {
    const f = (v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
  },
  parseRgb: function (str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '')
    if (!m) return null
    const parts = m[1].split(',').map(s => parseFloat(s.trim()))
    if (parts.length >= 4 && parts[3] === 0) return null   // fully transparent
    return [parts[0], parts[1], parts[2]]
  },
  contrast: function (a, b) {
    const la = this.luminance(a)
    const lb = this.luminance(b)
    const hi = Math.max(la, lb)
    const lo = Math.min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
  },
}
