import { finding } from '../index.js'

export default {
  id: 'I2',
  title: 'Gaps in the heading hierarchy',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    let prev = null
    for (const h of page.headings || []) {
      if (prev !== null && h.level > prev + 1) {
        out.push(finding(this, page, {
          selector: h.selector,
          found: `skipped level: h${prev} → h${h.level}`,
          expected: `h${prev + 1}`,
        }))
      }
      prev = h.level
    }
    return out
  },
}
