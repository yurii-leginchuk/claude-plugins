import { finding } from '../index.js'

export default {
  id: 'G1',
  title: 'Form has no Privacy Policy checkbox',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    return (page.forms || [])
      .filter(f => f.gravity && !f.hasPrivacyCheckbox)
      .map(f => finding(this, page, {
        selector: `form#${f.id || '(no id)'}`,
        found: 'no checkbox with a link to the Privacy Policy',
        expected: 'a required checkbox with a link to the policy',
      }))
  },
}
