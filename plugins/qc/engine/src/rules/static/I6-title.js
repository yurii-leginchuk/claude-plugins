import { finding } from '../index.js'
import { isThankYouUrl } from '../../lib/kinds.js'

export default {
  id: 'I6',
  title: 'Title страницы',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const out = []
    // Normalize: trim and use trimmed value for all operations
    const title = (page.title || '').trim()

    if (!title) {
      out.push(finding(this, page, { selector: 'title', found: 'title пустой', expected: 'уникальный title' }))
      return out
    }
    const shared = isThankYouUrl(page.url) ? [] : (site?.index?.titles?.get(title) || []).filter(u => !isThankYouUrl(u))
    if (shared.length > 1) {
      out.push(finding(this, page, {
        selector: 'title',
        found: `дубль title на ${shared.length} страницах: "${title}"`,
        expected: 'уникальный title',
      }))
    }
    let path
    try { path = new URL(page.url).pathname } catch { path = '' }
    if (path === '/' && /\bhome\b/i.test(title)) {
      out.push(finding(this, page, {
        selector: 'title', found: title, expected: 'title главной без слова «Home»',
      }))
    }
    return out
  },
}
