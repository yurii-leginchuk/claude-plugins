import { finding } from '../index.js'

const LEGAL = /privacy|terms|policy|conditions/i
// Documents and downloads: a visitor reading one should not lose the page.
const FILE = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|rtf|odt|ods)(?:$|[?#])/i

// Where a link opens (NN/g; WCAG G201):
//   a file (PDF, doc, …)               new tab
//   an internal page                   same tab
//   the policy link inside a form      new tab, so the form is not lost
//   tel: or an #anchor in a new tab    an empty tab opens: wrong
// External pages are the client's style and are not checked; rel="noopener"
// is implied by every current browser (Chrome 88, Firefox 79, Safari 12.1)
// and is not checked either. mailto: in a new tab is E6's.
export default {
  id: 'E3',
  title: 'Link opens in the wrong tab',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const l of page.links || []) {
      const raw = String(l.raw || '')
      const blank = (l.target || '').toLowerCase() === '_blank'
      if (blank && (l.protocol === 'tel:' || /^#/.test(raw))) {
        out.push(finding(this, page, {
          link: l, severity: 'minor', found: `${l.protocol === 'tel:' ? 'phone link' : 'anchor link'} “${l.text || raw}” opens a new, empty tab: ${raw}`,
          expected: 'remove target="_blank" (in Elementor: untick “Open in new window”)',
        }))
        continue
      }
      if (!l.href) continue
      if (FILE.test(l.href)) {
        if (!blank) {
          out.push(finding(this, page, {
            link: l, severity: 'minor', found: `file link “${l.text || raw}” opens in the same tab, so the visitor leaves the page: ${raw}`,
            expected: 'target="_blank" (in Elementor: tick “Open in new window”)',
          }))
        }
        continue
      }
      if (l.inForm && LEGAL.test(`${l.href} ${l.text || ''}`)) {
        if (!blank) {
          out.push(finding(this, page, {
            link: l, found: `link “${l.text || raw}” in a form opens in the same tab, so the filled-in form is lost`,
            expected: 'target="_blank" (in Gravity Forms: add target="_blank" in the consent HTML)',
          }))
        }
        continue
      }
      if (l.internal && blank) {
        out.push(finding(this, page, {
          link: l, found: `internal page link opens in a new tab: ${raw}`,
          expected: 'remove target="_blank" (in Elementor: untick “Open in new window”)',
        }))
      }
    }
    return out
  },
}
