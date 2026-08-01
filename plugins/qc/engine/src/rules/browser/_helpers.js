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
  selector: function (el) {
    if (!el || !el.tagName) return 'node'
    const tag = el.tagName.toLowerCase()
    if (el.id) return tag + '#' + el.id
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2)
    const own = cls.length ? tag + '.' + cls.join('.') : tag
    const p = el.parentElement
    if (!p || p === document.body || p === document.documentElement) return own
    const ptag = p.tagName.toLowerCase()
    const pid = p.id ? ptag + '#' + p.id : ptag
    return pid + ' > ' + own
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
    if (tag === 'a') return el.hasAttribute('href')
    if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true
    if (tag === 'input') return el.type !== 'hidden'
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
