import { finding } from '../index.js'

export default {
  id: 'H7',
  title: 'Image has no alt',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.images || [])
      .filter(i => !i.hasAlt && !i.decorative)
      .map(i => finding(this, page, {
        selector: i.selector,
        found: `no alt attribute: ${i.src || '(no src)'}`,
        expected: 'a meaningful alt, or alt="" for decorative images',
      }))
  },
}
