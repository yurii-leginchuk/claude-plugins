import { finding } from '../index.js'
import { isThankYouUrl } from '../../lib/kinds.js'

export default {
  id: 'I7',
  title: 'Page meta description',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    // Normalize: trim and use trimmed value for all operations
    const description = (page.metaDescription || '').trim()

    if (!description) {
      return [finding(this, page, {
        selector: 'head', found: 'description missing', expected: 'a unique description',
      })]
    }
    const shared = isThankYouUrl(page.url) ? [] : (site?.index?.descriptions?.get(description) || []).filter(u => !isThankYouUrl(u))
    if (shared.length > 1) {
      return [finding(this, page, {
        selector: 'meta[name=description]',
        found: `duplicate description on ${shared.length} pages`,
        expected: 'a unique description',
      })]
    }
    return []
  },
}
