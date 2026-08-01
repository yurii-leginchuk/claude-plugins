import { finding } from '../index.js'

const PAGED = /\/page\/(\d+)\/?$|[?&]paged?=(\d+)/i

export default {
  id: 'I8',
  title: 'Пагинация: canonical и индексация',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    if (!PAGED.test(page.url)) return []
    const out = []
    if (page.canonical && page.canonical !== page.url) {
      out.push(finding(this, page, {
        selector: 'link[rel=canonical]',
        found: `canonical страницы пагинации ведёт на ${page.canonical}`,
        expected: page.url,
      }))
    }
    return out
  },
}
