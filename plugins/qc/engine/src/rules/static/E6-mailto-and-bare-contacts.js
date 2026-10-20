import { finding, whereInText } from '../index.js'

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico',
  'css', 'js', 'mjs', 'json', 'xml', 'pdf', 'zip', 'gz',
  'mp4', 'webm', 'mp3', 'woff', 'woff2', 'ttf', 'eot',
])

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
          link: l,
          found: `mailto с target=_blank: ${l.raw}`,
          expected: 'без target',
        }))
      }
    }

    for (const m of new Set((page.text || '').match(EMAIL) || [])) {
      if (!linked.has(m.toLowerCase())) {
        const ext = m.split('.').pop().toLowerCase()
        if (!FILE_EXTENSIONS.has(ext)) {
          out.push(finding(this, page, {
            selector: 'body', found: m, where: whereInText(page, m), expected: `<a href="mailto:${m}">${m}</a>`,
          }))
        }
      }
    }
    return out
  },
}
