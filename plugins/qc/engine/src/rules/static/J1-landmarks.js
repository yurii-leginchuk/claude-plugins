import { finding } from '../index.js'

export default {
  id: 'J1',
  title: 'Семантические лендмарки',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    const l = page.landmarks || { header: 0, main: 0 }
    if (!l.header) {
      out.push(finding(this, page, { selector: 'body', found: 'нет тега <header>', expected: 'шапка в <header>' }))
    }
    if (!l.main) {
      out.push(finding(this, page, { selector: 'body', found: 'нет тега <main>', expected: 'контент в <main>' }))
    } else if (l.main > 1) {
      // More than one <main> is invalid HTML: only one landmark main is allowed per document.
      // Multiple <header> elements are not flagged — a nested <header> inside <article> is
      // valid and common in WordPress themes, so it is not a defect.
      out.push(finding(this, page, {
        selector: 'body',
        found: `найдено ${l.main} тегов <main>`,
        expected: 'ровно один <main> на странице',
      }))
    }
    return out
  },
}
