import { finding } from '../index.js'

export default {
  id: 'S1',
  title: 'JSON-LD не парсится',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.jsonLd || [])
      .filter(b => !b.ok)
      .map(b => finding(this, page, {
        selector: 'script[type="application/ld+json"]',
        found: b.error || 'ошибка разбора',
        expected: 'валидный JSON-LD',
      }))
  },
}
