import { finding } from '../index.js'

export default {
  id: 'I1',
  title: 'Количество H1 на странице',
  severity: 'critical',
  engine: 'static',
  check(page, _site) {
    const h1 = (page.headings || []).filter(h => h.level === 1)
    if (h1.length === 1) return []
    return [finding(this, page, {
      selector: h1[0]?.selector || 'body',
      found: h1.length === 0 ? 'H1 не найден' : `H1 на странице: ${h1.length}`,
      expected: 'ровно один H1',
    })]
  },
}
