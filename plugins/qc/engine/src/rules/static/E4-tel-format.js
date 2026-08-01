import { finding } from '../index.js'
import { digitsOnly } from '../../lib/text.js'

const CLEAN = /^tel:\+\d{8,15}$/

export default {
  id: 'E4',
  title: 'Формат tel: в HTML',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const link of page.links || []) {
      if (link.protocol !== 'tel:') continue
      const raw = link.raw || ''
      if (CLEAN.test(raw)) continue

      const digits = digitsOnly(raw)
      if (!digits) {
        out.push(finding(this, page, {
          selector: link.selector,
          found: raw,
          expected: 'tel:+<код страны><цифры>',
          confidence: 'heuristic',
        }))
        continue
      }

      // If raw already contains a country code (starts with +), it has 11+ digits
      const hasCountryCode = raw.includes('+') && digits.length >= 11
      if (hasCountryCode) {
        // Only formatting defect: strip separators, confidence is high
        out.push(finding(this, page, {
          selector: link.selector,
          found: raw,
          expected: `tel:+${digits}`,
        }))
      } else if (digits.length === 10) {
        // Bare 10-digit number: must infer country code, confidence is heuristic
        out.push(finding(this, page, {
          selector: link.selector,
          found: raw,
          expected: 'tel:+<код страны><10 цифр>',
          confidence: 'heuristic',
        }))
      } else if (digits.length >= 8 && digits.length <= 15 && !raw.includes('+')) {
        // Other lengths without country code: formatting and possibly country issue
        out.push(finding(this, page, {
          selector: link.selector,
          found: raw,
          expected: 'tel:+<код страны><цифры>',
          confidence: 'heuristic',
        }))
      }
    }
    return out
  },
}
