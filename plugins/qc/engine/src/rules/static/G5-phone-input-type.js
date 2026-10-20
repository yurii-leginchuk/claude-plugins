import { finding } from '../index.js'

export default {
  id: 'G5',
  title: 'Phone field is not type=tel',
  severity: 'minor',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const form of page.forms || []) {
      if (!form.gravity) continue
      for (const f of form.fields || []) {
        // Phone fields are identified by `fieldType === 'phone'`, parsed in
        // src/parse/page.js from the `gfield--type-phone` class Gravity Forms puts on
        // the field wrapper. This is an observed fact about the field (not inferred from
        // a formatted selector string), so findings from this rule use the default
        // (high) confidence.
        if (f.fieldType === 'phone' && f.inputType !== 'tel') {
          out.push(finding(this, page, {
            selector: f.selector,
            found: `type=${f.inputType || '(none)'}`,
            expected: 'type="tel"',
          }))
        }
      }
    }
    return out
  },
}
