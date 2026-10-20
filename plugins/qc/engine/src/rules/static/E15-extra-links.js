import { finding } from '../index.js'
import { pathKey } from '../../lib/url.js'
import { classifyGoogleLink } from '../../lib/gbp.js'
import { isLandingPath } from '../../lib/kinds.js'

// Taxonomy E15: links that should not be there.
//
//   a link in the page body to the page itself (a card or button copied
//     from another page, related posts listing the current post);
//   a clickable date ("the date shouldn't be clickable" -- WordPress links
//     post dates to day archives nobody wants);
//   exit links on a PPC landing page (/lp/…): every way off the page is
//     paid traffic leaking. Phone, email, anchors, the profile on Maps and
//     the legal pages stay.
const DATE = /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{4}|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/i
const LEGAL = /privacy|terms|policy|accessibility|hipaa|notice/i

export default {
  id: 'E15',
  title: 'Unneeded link',
  severity: 'minor',
  engine: 'static',
  check(page) {
    const here = pathKey(page.url)
    let path = ''
    try { path = new URL(page.url).pathname } catch { /* stays empty */ }
    const landing = isLandingPath(path)
    const out = []
    const seen = new Set()
    const push = (key, props) => {
      if (seen.has(key)) return
      seen.add(key)
      out.push(finding(this, page, props))
    }
    for (const l of page.links || []) {
      if (!l.href) continue
      const raw = l.raw || ''
      // On an archive the current category in the category filter links
      // to itself on purpose.
      if (l.region === 'main' && !raw.includes('#') && pathKey(l.href) === here && !/\/(category|tag|author)\//.test(here)) {
        push(`self|${l.text}`, {
          link: l,
          found: `link to the same page${l.text ? `: “${l.text}”` : ' (image)'}`,
          expected: 'no link, or a link to another page',
        })
      }
      if (DATE.test(l.text || '')) {
        push(`date|${l.text}`, {
          link: l, confidence: 'heuristic',
          found: `date is clickable: “${l.text}” → ${l.href}`, expected: 'date without a link',
        })
      }
      if (landing && !raw.startsWith('#') && pathKey(l.href) !== here && !LEGAL.test(l.href) && !classifyGoogleLink(raw)) {
        let target = l.href
        try { target = l.internal ? new URL(l.href).pathname : new URL(l.href).host } catch { /* keep href */ }
        if (l.internal && isLandingPath(target)) continue
        push(`lp|${target}`, {
          link: l, confidence: 'heuristic',
          found: `link leads away from the PPC landing page: ${l.href}`,
          expected: 'the landing page has only the phone, the form and anchors',
        })
      }
    }
    return out
  },
}
