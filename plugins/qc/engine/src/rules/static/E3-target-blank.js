import { finding } from '../index.js'

export default {
  id: 'E3',
  title: 'Правила target=_blank для внутренних и внешних ссылок',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const l of page.links || []) {
      if (!l.href) continue
      const blank = (l.target || '').toLowerCase() === '_blank'
      if (l.internal && blank) {
        out.push(finding(this, page, {
          selector: l.selector, found: `внутренняя ссылка с target=_blank: ${l.raw}`,
          expected: 'без target',
        }))
      }
      if (!l.internal && !blank) {
        out.push(finding(this, page, {
          selector: l.selector, found: `внешняя ссылка без target: ${l.raw}`,
          expected: 'target=_blank rel="noopener"',
        }))
      }
      if (!l.internal && blank && !/noopener/i.test(l.rel || '')) {
        out.push(finding(this, page, {
          selector: l.selector, found: `внешняя ссылка без rel=noopener: ${l.raw}`,
          expected: 'rel="noopener"',
        }))
      }
    }
    return out
  },
}
