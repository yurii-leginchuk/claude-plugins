import { finding } from '../index.js'

export default {
  id: 'I7',
  title: 'Meta description',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    // Treat whitespace-only as empty
    const description = page.metaDescription?.trim() ? page.metaDescription : null

    if (!description) {
      return [finding(this, page, {
        selector: 'head', found: 'description отсутствует', expected: 'уникальный description',
      })]
    }
    const shared = site?.index?.descriptions?.get(description) || []
    if (shared.length > 1) {
      return [finding(this, page, {
        selector: 'meta[name=description]',
        found: `дубль description на ${shared.length} страницах`,
        expected: 'уникальный description',
      })]
    }
    return []
  },
}
