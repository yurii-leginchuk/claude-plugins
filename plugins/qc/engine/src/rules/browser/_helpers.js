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
