import { finding } from '../index.js'

export default {
  id: 'I4',
  title: 'Page is closed to indexing',
  severity: 'critical',
  engine: 'static',
  check(page, site) {
    if (page.robots?.index !== false) return []
    if (site?.env === 'dev') return []
    const unknown = site?.env !== 'prod'
    return [{
      ...finding(this, page, {
        selector: 'meta[name=robots]',
        found: page.robots.raw || 'noindex',
        expected: 'index, follow',
      }),
      severity: unknown ? 'major' : 'critical',
      confidence: unknown ? 'heuristic' : 'high',
    }]
  },
}
