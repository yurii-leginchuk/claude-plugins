import { finding } from '../index.js'

export default {
  id: 'G3',
  title: 'Required field without a marker',
  severity: 'minor',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const form of page.forms || []) {
      if (!form.gravity) continue
      for (const f of form.fields || []) {
        if (f.required && !f.markedRequired) {
          out.push(finding(this, page, {
            selector: f.selector, found: 'field is required but has no asterisk', expected: '* in the field label',
          }))
        }
      }
    }
    return out
  },
}
