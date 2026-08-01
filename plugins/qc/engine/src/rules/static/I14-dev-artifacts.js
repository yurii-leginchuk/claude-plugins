import { finding } from '../index.js'

const DEV_URL = /(^|\/\/|\.)(?:[\w-]*(?:-dev|dev)\.)?patest\.website|\/\/[\w-]*-dev\./i

export default {
  id: 'I14',
  title: 'Следы дев-окружения на проде',
  severity: 'critical',
  engine: 'static',
  check(page, site) {
    if (site?.env !== 'prod') return []
    const out = []
    for (const l of page.links || []) {
      if (l.href && DEV_URL.test(l.href)) {
        out.push(finding(this, page, {
          selector: l.selector, found: `ссылка на дев: ${l.href}`, expected: 'боевой домен',
        }))
      }
    }
    for (const i of page.images || []) {
      if (i.src && DEV_URL.test(i.src)) {
        out.push(finding(this, page, {
          selector: i.selector, found: `картинка с дева: ${i.src}`, expected: 'боевой домен',
        }))
      }
    }
    return out
  },
}
