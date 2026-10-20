import { finding, whereInText } from '../index.js'
import { pathKey } from '../../lib/url.js'
import { classifyGoogleLink } from '../../lib/gbp.js'
import { nameOf, sameName } from '../../lib/profile.js'

// A link or a sentence promising something it does not deliver:
//
//   "Call now" that opens a page instead of dialling, "Email us" without
//     mailto:, "Book an appointment" leading to a page with no form,
//     "Get directions" not opening Maps, "Download the PDF" that is a page;
//   "see our pricing page" in the copy when the site has no such page.
//
// Heuristic: a "Call us" link to a contact page with the number on it is a
// choice, not a bug, but QA usually asks for the dialler.
const BOOKING_HOSTS = /calendly|acuity|fareharbor|toasttab|opentable|zocdoc|resy|square|setmore|booksy|vagaro|mindbody|simplybook|squarespace\.com\/scheduling|hubspot|youcanbook|book\.|booking\./i
const MAP_HOSTS = /maps\.apple\.com|bing\.com\/maps|waze\.com|mapquest\.com/i
const FILE = /\.(pdf|docx?|xlsx?|pptx?|zip|csv)(\?|#|$)/i
const PROMISE = /\b(?:see|visit|check out|view|read|explore) our ([a-z][a-z &-]{2,40}?) (?:page|section)\b/gi

const isMenu = (l) => ['header', 'nav', 'footer'].includes(l.region)

function expectation(text) {
  const t = text.toLowerCase()
  // "On-call service" describes, it does not ask to dial.
  if (/(?<![-\w])call\b/.test(t)) return 'call'
  if (/\be-?mail\b/.test(t)) return 'email'
  if (/\b(book|schedule|appointment|reserve)\b/.test(t)) return 'book'
  if (/\b(get )?directions\b|\bview (on )?map\b|^map$/.test(t) && !/site ?map/.test(t)) return 'map'
  if (/\bdownload\b|\bpdf\b/.test(t)) return 'file'
  return null
}

export default {
  id: 'E17',
  title: 'Link or text promises something it does not do',
  severity: 'minor',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    const out = []
    const seen = new Set()
    const push = (key, props) => {
      if (seen.has(key)) return
      seen.add(key)
      out.push(finding(this, page, props))
    }
    const byPath = new Map((site?.pages || []).map(p => [pathKey(p.url), p]))

    for (const l of page.links || []) {
      const text = (l.text || '').trim()
      if (!text || text.length > 40) continue
      const kind = expectation(text)
      if (!kind) continue
      const raw = l.raw || ''
      if (kind === 'call' && l.protocol !== 'tel:') {
        push(`call|${text}|${raw}`, {
          link: l, found: `“${text}” does not call, it points to ${raw}`,
          expected: 'href="tel:+1…" with the site phone number',
        })
      } else if (kind === 'email' && l.protocol !== 'mailto:' && !/contact|\/cdn-cgi\/l\/email-protection/i.test(raw)) {
        // Cloudflare's email obfuscation: a mailto: once its script runs.
        push(`email|${text}|${raw}`, {
          link: l, found: `“${text}” does not open email, it points to ${raw}`,
          expected: 'href="mailto:…" with the site email address',
        })
      } else if (kind === 'book' && !isMenu(l) && l.internal && l.href && !BOOKING_HOSTS.test(raw)) {
        const target = byPath.get(pathKey(l.href))
        if (target && !(target.forms || []).length && !BOOKING_HOSTS.test(target.text || '')) {
          push(`book|${text}|${pathKey(l.href)}`, {
            link: l, found: `“${text}” points to ${pathKey(l.href)}, but there is no booking form there`,
            expected: 'link to a page with a booking form or widget',
          })
        }
      } else if (kind === 'map' && l.href && !classifyGoogleLink(raw) && !MAP_HOSTS.test(raw)) {
        push(`map|${text}|${raw}`, {
          link: l, found: `“${text}” does not open a map, it points to ${raw}`,
          expected: 'link to the GBP profile (maps.app.goo.gl/…)',
        })
      } else if (kind === 'file' && l.href && !FILE.test(raw) && !/\/wp-content\/uploads\//.test(raw)) {
        push(`file|${text}|${raw}`, {
          link: l, found: `“${text}” promises a file, but points to page ${raw}`,
          expected: 'direct link to the file (.pdf etc.)',
        })
      }
    }

    if (site?.pages) {
      const names = site.pages.flatMap(p => {
        const slug = (new URL(p.url).pathname.split('/').filter(Boolean).pop() || '').replace(/-/g, ' ')
        return [nameOf(p), p.title, slug].filter(Boolean)
      })
      for (const m of String(page.text || '').matchAll(PROMISE)) {
        const what = m[1].trim()
        if (names.some(n => sameName(what, n) || n.toLowerCase().includes(what.toLowerCase()))) continue
        push(`promise|${what}`, {
          selector: 'body', where: whereInText(page, m[0]),
          found: `text refers to a “${what}” page, but no such page exists`,
          expected: `create the “${what}” page or remove the reference`,
        })
      }
    }
    return out
  },
}
