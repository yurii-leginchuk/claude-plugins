import { finding } from '../index.js'
import { digitsOnly } from '../../lib/text.js'

export default {
  id: 'E5',
  title: 'Задвоенный код страны в номере',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const l of page.links || []) {
      if (l.protocol !== 'tel:') continue
      const raw = l.raw || ''
      const d = digitsOnly(raw)
      const doubledPlus = (raw.match(/\+/g) || []).length > 1
      const doubledOne = d.length === 12 && d.startsWith('11')
      if (doubledPlus || doubledOne) {
        out.push(finding(this, page, {
          selector: l.selector,
          found: raw,
          expected: `tel:+${d.replace(/^11/, '1')}`,
        }))
      }
    }
    return out
  },
}
