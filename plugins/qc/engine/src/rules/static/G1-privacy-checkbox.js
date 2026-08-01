import { finding } from '../index.js'

export default {
  id: 'G1',
  title: 'В форме нет чекбокса Privacy Policy',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.forms || [])
      .filter(f => f.gravity && !f.hasPrivacyCheckbox)
      .map(f => finding(this, page, {
        selector: `form#${f.id || '(без id)'}`,
        found: 'нет чекбокса со ссылкой на Privacy Policy',
        expected: 'обязательный чекбокс со ссылкой на политику',
      }))
  },
}
