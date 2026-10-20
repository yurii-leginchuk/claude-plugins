import { finding } from '../index.js'

const LOREM = /\b(lorem ipsum|dolor sit amet|consectetur adipiscing)\b/i

export default {
  id: 'H1',
  title: 'Leftover Lorem ipsum',
  severity: 'critical',
  engine: 'static',
  check(page, _site) {
    const m = LOREM.exec(page.text || '')
    if (!m) return []
    const at = Math.max(0, m.index - 40)
    return [finding(this, page, {
      selector: 'body',
      found: (page.text || '').slice(at, m.index + 80).trim(),
      expected: 'real text',
    })]
  },
}
