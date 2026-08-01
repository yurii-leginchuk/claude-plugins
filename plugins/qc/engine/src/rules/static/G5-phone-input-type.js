import { finding } from '../index.js'

export default {
  id: 'G5',
  title: 'Поле телефона не type=tel',
  severity: 'minor',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const form of page.forms || []) {
      if (!form.gravity) continue
      for (const f of form.fields || []) {
        // Phone fields are identified by matching /phone/i against the field's selector
        // (typically a Gravity Forms class like .gfield--type-phone). This infers the
        // field's purpose from a class name rather than observing it directly, so
        // findings from this rule are marked as heuristic confidence.
        const isPhone = /phone/i.test(f.selector || '')
        if (isPhone && f.inputType !== 'tel') {
          out.push(finding(this, page, {
            selector: f.selector,
            found: `type=${f.inputType || '(нет)'}`,
            expected: 'type="tel"',
            confidence: 'heuristic',
          }))
        }
      }
    }
    return out
  },
}
