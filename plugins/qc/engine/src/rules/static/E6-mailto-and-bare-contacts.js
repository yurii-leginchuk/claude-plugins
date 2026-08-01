import { finding } from '../index.js'

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

export default {
  id: 'E6',
  title: 'mailto в новой вкладке и некликабельные контакты',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    const linked = new Set()

    for (const l of page.links || []) {
      if (l.protocol !== 'mailto:') continue
      linked.add((l.raw || '').replace(/^mailto:/i, '').split('?')[0].toLowerCase())
      if ((l.target || '').toLowerCase() === '_blank') {
        out.push(finding(this, page, {
          selector: l.selector,
          found: `mailto с target=_blank: ${l.raw}`,
          expected: 'без target',
        }))
      }
    }

    for (const m of new Set((page.text || '').match(EMAIL) || [])) {
      if (!linked.has(m.toLowerCase())) {
        out.push(finding(this, page, {
          selector: 'body', found: m, expected: 'обернуть в mailto:',
        }))
      }
    }
    return out
  },
}
