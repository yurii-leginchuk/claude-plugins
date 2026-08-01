import { finding } from '../index.js'

export default {
  id: 'H7',
  title: 'Отсутствует alt у изображения',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.images || [])
      .filter(i => !i.hasAlt && !i.decorative)
      .map(i => finding(this, page, {
        selector: i.selector,
        found: `нет атрибута alt: ${i.src || '(без src)'}`,
        expected: 'осмысленный alt или alt="" для декоративных',
      }))
  },
}
