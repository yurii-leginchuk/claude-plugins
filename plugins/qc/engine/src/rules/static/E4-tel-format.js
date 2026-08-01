import { finding } from '../index.js'
import { digitsOnly } from '../../lib/text.js'

const CLEAN = /^tel:\+\d{8,15}$/

function expectedFor(raw) {
  let d = digitsOnly(raw)
  if (!d) return null
  if (d.length === 10) d = `1${d}`          // US number without a country code
  return `tel:+${d}`
}

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
      out.push(finding(this, page, {
        selector: link.selector,
        found: raw,
        expected: expectedFor(raw) || 'tel:+1XXXXXXXXXX',
      }))
    }
    return out
  },
}
