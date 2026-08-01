import { finding } from '../index.js'
import { digitsOnly } from '../../lib/text.js'
import { doubledCountryCode } from '../../lib/phone.js'

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

      // Only early exit: if the value is already clean
      if (CLEAN.test(raw)) continue

      // A value carrying its country code twice belongs to E5, which proposes
      // the concrete correction. E4's hasCountryCode branch used to treat
      // "12 digits with a +" as "just strip separators", producing
      // `tel:+117189690845` for `tel:+1+17189690845` -- still doubled, and
      // flatly contradicting the `tel:+17189690845` E5 proposes for the same
      // href, both at major. E4 emits nothing here rather than emitting a
      // second, differently-worded finding about the same defect.
      if (doubledCountryCode(raw)) continue

      // Otherwise, ALWAYS emit a finding
      const digits = digitsOnly(raw)

      // Determine expected value and confidence based on what we can infer
      let expected, confidence

      // Country code is present if:
      // - has + and 8-15 digits (valid E.164 range), OR
      // - has 11-15 digits without + (country code likely present)
      const hasPlus = raw.includes('+')
      const inE164Range = digits.length >= 8 && digits.length <= 15
      const hasCountryCode = (hasPlus && inE164Range) || (digits.length >= 11 && digits.length <= 15)

      if (hasCountryCode) {
        // Country code is present: just strip separators
        expected = `tel:+${digits}`
        confidence = 'high'
      } else if (digits.length === 10 && !hasPlus) {
        // Exactly 10 digits, no country code: must infer it
        expected = 'tel:+<код страны><10 цифр>'
        confidence = 'heuristic'
      } else {
        // Too few, too many, empty, or + with wrong digit count: defect is certain
        // but we cannot propose a specific number
        expected = 'tel:+<код страны><номер>'
        confidence = 'high'
      }

      out.push(finding(this, page, {
        selector: link.selector,
        found: raw,
        expected,
        confidence,
      }))
    }
    return out
  },
}
