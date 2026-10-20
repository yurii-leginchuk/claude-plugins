import { finding, whereInText } from '../index.js'

// Taxonomy H6: a placeholder that reached the page -- «[LINK PLACEHOLDER]»
// from the copy doc, «Insert Street Address Here» left in the schema. Each is
// copy-paste from a template, so the same marker is reported once per page.
// Images are not checked: an image on the page came from the design, even one
// named "placeholder", and is not replaced by the team.
const TEXT = /\[[^\]]{0,30}placeholder[^\]]{0,30}\]|\blink placeholder\b|\binsert (?:[a-z]+ ){1,4}here\b|\b(?:your|company) business name\b|\(xxx\) ?xxx-xxxx|\bxxx-xxx-xxxx\b|\{\{[a-z_ ]{2,30}\}\}/gi

export default {
  id: 'H6',
  title: 'Placeholder instead of content',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    const seen = new Set()
    const push = (key, props) => { if (!seen.has(key)) { seen.add(key); out.push(finding(this, page, props)) } }

    const text = String(page.text || '')
    for (const m of text.matchAll(TEXT)) {
      push(`text|${m[0].toLowerCase()}`, {
        selector: 'body', severity: 'critical', where: whereInText(page, m[0]),
        found: `placeholder in text: “${m[0]}”`, expected: 'real text or a link',
      })
    }
    for (const field of ['title', 'metaDescription']) {
      const m = String(page[field] || '').match(new RegExp(TEXT.source, 'i'))
      if (m) push(`${field}|${m[0]}`, { selector: 'head', found: `placeholder in ${field === 'title' ? 'title' : 'meta description'}: “${m[0]}”`, expected: 'real text' })
    }
    for (const raw of page.jsonLdRaw || []) {
      for (const m of String(raw).matchAll(new RegExp(TEXT.source, 'gi'))) {
        push(`schema|${m[0].toLowerCase()}`, {
          selector: 'script[type="application/ld+json"]', found: `placeholder in schema: “${m[0]}”`,
          expected: 'a real value (address, phone, name) or remove the field',
        })
      }
    }
    return out
  },
}
