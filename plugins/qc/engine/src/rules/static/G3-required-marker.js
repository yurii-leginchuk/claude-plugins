import { finding } from '../index.js'

export default {
  id: 'G3',
  title: 'Обязательное поле без пометки',
  severity: 'minor',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const form of page.forms || []) {
      if (!form.gravity) continue
      for (const f of form.fields || []) {
        if (f.required && !f.markedRequired) {
          out.push(finding(this, page, {
            selector: f.selector, found: 'поле обязательное, но без звёздочки', expected: '* в подписи поля',
          }))
        }
      }
    }
    return out
  },
}
