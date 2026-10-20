import { finding, whereInText } from '../index.js'

// Taxonomy H6: a placeholder that reached the page -- the grey stand-in
// image, «[LINK PLACEHOLDER]» from the copy doc, «Insert Street Address Here»
// left in the schema. Each is copy-paste from a template, so the same
// marker is reported once per page.
const IMAGE = /placeholder|dummy[-_ ]?image|sample[-_ ]image|image[-_ ]coming[-_ ]soon|no[-_ ]image[-_ ]available|insert[-_ ](?:an? )?image/i
const TEXT = /\[[^\]]{0,30}placeholder[^\]]{0,30}\]|\blink placeholder\b|\binsert (?:[a-z]+ ){1,4}here\b|\b(?:your|company) business name\b|\(xxx\) ?xxx-xxxx|\bxxx-xxx-xxxx\b|\{\{[a-z_ ]{2,30}\}\}/gi

export default {
  id: 'H6',
  title: 'Заглушка вместо контента',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    const seen = new Set()
    const push = (key, props) => { if (!seen.has(key)) { seen.add(key); out.push(finding(this, page, props)) } }

    for (const i of page.images || []) {
      const file = String(i.src || '').split('/').pop().split('?')[0]
      if (IMAGE.test(file)) {
        push(`img|${file}`, {
          selector: i.selector, found: `картинка-заглушка: файл ${file}`,
          expected: 'настоящее изображение или убрать блок',
        })
      } else if (IMAGE.test(i.alt || '')) {
        // Only the alt says so: often a generated alt describing a decorative
        // shape («Ellipse-1.svg» → «gray circular placeholder icon»).
        push(`alt|${i.alt}`, {
          selector: i.selector, severity: 'minor', confidence: 'heuristic',
          found: `alt описывает заглушку: «${i.alt}»`,
          expected: 'если это настоящая заглушка — заменить картинку; если декоративная фигура — alt=""',
        })
      }
    }
    const text = String(page.text || '')
    for (const m of text.matchAll(TEXT)) {
      push(`text|${m[0].toLowerCase()}`, {
        selector: 'body', severity: 'critical', where: whereInText(page, m[0]),
        found: `заглушка в тексте: «${m[0]}»`, expected: 'настоящий текст или ссылка',
      })
    }
    for (const field of ['title', 'metaDescription']) {
      const m = String(page[field] || '').match(new RegExp(TEXT.source, 'i'))
      if (m) push(`${field}|${m[0]}`, { selector: 'head', found: `заглушка в ${field === 'title' ? 'title' : 'meta description'}: «${m[0]}»`, expected: 'настоящий текст' })
    }
    for (const raw of page.jsonLdRaw || []) {
      for (const m of String(raw).matchAll(new RegExp(TEXT.source, 'gi'))) {
        push(`schema|${m[0].toLowerCase()}`, {
          selector: 'script[type="application/ld+json"]', found: `заглушка в schema: «${m[0]}»`,
          expected: 'настоящее значение (адрес, телефон, название) или убрать поле',
        })
      }
    }
    return out
  },
}
