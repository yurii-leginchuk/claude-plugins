import { finding } from '../index.js'

export default {
  id: 'I3',
  title: 'H1 картинкой, а не текстом',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.headings || [])
      .filter(h => h.level === 1 && h.imageOnly)
      .map(h => finding(this, page, {
        selector: h.selector,
        found: 'H1 не содержит текста, только изображение',
        expected: 'текстовый H1',
      }))
  },
}
