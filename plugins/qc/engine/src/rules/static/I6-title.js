import { finding } from '../index.js'
import { isThankYouUrl } from '../../lib/kinds.js'

export default {
  id: 'I6',
  title: 'Page title',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const out = []
    // Normalize: trim and use trimmed value for all operations
    const title = (page.title || '').trim()

    if (!title) {
      out.push(finding(this, page, { selector: 'title', found: 'title is empty', expected: 'a unique title' }))
      return out
    }
    const shared = isThankYouUrl(page.url) ? [] : (site?.index?.titles?.get(title) || []).filter(u => !isThankYouUrl(u))
    if (shared.length > 1) {
      out.push(finding(this, page, {
        selector: 'title',
        found: `duplicate title on ${shared.length} pages: "${title}"`,
        expected: 'a unique title',
      }))
    }
    let path
    try { path = new URL(page.url).pathname } catch { path = '' }
    if (path === '/' && /\bhome\b/i.test(title)) {
      out.push(finding(this, page, {
        selector: 'title', found: title, expected: 'home page title without the word “Home”',
      }))
    }
    return out
  },
}
