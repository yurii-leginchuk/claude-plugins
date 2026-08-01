import { finding } from '../index.js'
import { hostOf } from '../../lib/url.js'
import { isDevHost } from '../../lib/env.js'

export default {
  id: 'I14',
  title: 'Следы дев-окружения на проде',
  severity: 'critical',
  engine: 'static',
  check(page, site) {
    if (site?.env !== 'prod') return []
    const out = []
    for (const l of page.links || []) {
      if (l.href) {
        const host = hostOf(l.href)
        if (host && isDevHost(host)) {
          out.push(finding(this, page, {
            selector: l.selector, found: `ссылка на дев: ${l.href}`, expected: 'боевой домен',
          }))
        }
      }
    }
    for (const i of page.images || []) {
      if (i.src) {
        const host = hostOf(i.src)
        if (host && isDevHost(host)) {
          out.push(finding(this, page, {
            selector: i.selector, found: `картинка с дева: ${i.src}`, expected: 'боевой домен',
          }))
        }
      }
    }
    return out
  },
}
