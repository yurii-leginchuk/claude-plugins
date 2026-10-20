import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'

// Taxonomy F12: "Verify Insurance doesn't scroll to the form", "the CTA does
// nothing" -- a `#fragment` link whose target id is not on the page. Common
// after a redesign: the header's "#contact" button is copied to every page
// while only the homepage has the section.
//
// Checked against the ids in the static HTML (`page.ids`). Pages cached
// before that field existed are skipped. `#top` scrolls to the top in every
// browser without an element; `#elementor-action…` and hash routes are
// handled by JavaScript, not by an id.
const JS_FRAGMENT = /^(elementor-action|!|\/)|[:=]/

function fragmentOf(raw) {
  const i = raw.indexOf('#')
  if (i < 0) return null
  try { return decodeURIComponent(raw.slice(i + 1)) } catch { return raw.slice(i + 1) }
}

export default {
  id: 'F12',
  title: 'Anchor link leads nowhere',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    if (!Array.isArray(page.ids)) return []
    const byPath = new Map((site?.pages || []).map(p => [pathKey(p.url), p]))
    const here = pathKey(page.url)
    const out = []
    const seen = new Set()
    const push = (key, props) => {
      if (seen.has(key)) return
      seen.add(key)
      out.push(finding(this, page, props))
    }
    for (const l of page.links || []) {
      const raw = l.raw || ''
      const frag = fragmentOf(raw)
      if (frag === null) continue
      if (frag === '') {
        // A bare "#" in a menu is a dropdown parent, and an icon with no
        // text is a JS toggle; in the page, a labelled one is a button
        // wired to nothing unless JavaScript took it over.
        if (raw === '#' && l.region === 'main' && l.text) {
          push(`#|${l.selector}|${l.text}`, {
            link: l, confidence: 'heuristic', severity: 'minor',
            found: `placeholder link href="#": “${l.text}”`,
            expected: 'a real link or a button',
          })
        }
        continue
      }
      if (frag.toLowerCase() === 'top' || JS_FRAGMENT.test(frag)) continue
      // Another site's #fragment is that site's business.
      if (!raw.startsWith('#') && !l.internal) continue
      const samePage = raw.startsWith('#') || (l.href && pathKey(l.href) === here)
      const target = samePage ? page : byPath.get(pathKey(l.href))
      if (!target || !Array.isArray(target.ids) || target.ids.includes(frag)) continue
      push(`${raw}`, {
        link: l,
        // A broken "Skip to content" is an accessibility defect nobody sees.
        ...(/^skip to/i.test(l.text || '') ? { severity: 'minor' } : {}),
        found: samePage
          ? `anchor #${frag}: the page has no element with this id`
          : `link ${raw}: page ${pathKey(l.href)} has no element #${frag}`,
        expected: /^skip to/i.test(l.text || '')
          ? `add id="${frag}" to <main> or the main container of the page`
          : `set CSS ID “${frag}” on the right section (Elementor: Advanced → CSS ID) or change the link`,
      })
    }
    return out
  },
}
