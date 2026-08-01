import { finding } from '../index.js'
import { doubledCountryCode } from '../../lib/phone.js'

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
      // E5 is the only rule that proposes a correction for this shape -- see
      // lib/phone.js for why E4 deliberately stays silent on it.
      const doubled = doubledCountryCode(raw)
      if (doubled) {
        out.push(finding(this, page, {
          selector: l.selector,
          found: raw,
          expected: doubled.expected,
          // The doubled-leading-1 branch infers the defect from a digit
          // pattern rather than observing it, so it is heuristic; the literal
          // two-'+' branch is directly observed and stays high.
          confidence: doubled.confidence,
        }))
      }
    }
    return out
  },
}
