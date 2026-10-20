import { finding } from '../index.js'
import { ignoredByFacts } from '../../lib/facts.js'

// Taxonomy H9: a dropped service, a closed location, a renamed brand or an
// old email still mentioned somewhere -- "mentions of Equine therapy in
// Google schemas", "these 3 blogs are about Equine Therapy", "Boston". 39
// QA remarks in a year, each one a manual search across the whole site.
//
// The terms come only from the site's facts file (`banned`). There is no
// built-in list: whether "Boston" is a defect depends entirely on whether
// the client still operates there.
//
// Matched as a whole word, case-insensitively, in the copy, the title, the
// meta description and the JSON-LD. `\p{L}`/`\p{N}` lookarounds instead of
// `\b` so a term next to a non-ASCII letter still has a word boundary.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function snippet(text, index, length) {
  const from = Math.max(0, index - 50)
  const to = Math.min(text.length, index + length + 50)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`
}

export default {
  id: 'H9',
  title: 'Mention of a removed service, location or old data',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const facts = site?.facts
    if (!facts?.banned?.length || ignoredByFacts(facts, page.url)) return []

    const places = [
      ['text', 'body', page.text],
      ['title', 'title', page.title],
      ['description', 'meta[name=description]', page.metaDescription],
      ['schema', 'script[type="application/ld+json"]', (page.jsonLdRaw || []).join('\n')],
    ]
    const out = []
    for (const { term, note } of facts.banned) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'giu')
      for (const [where, selector, text] of places) {
        if (!text) continue
        const hits = [...String(text).matchAll(re)]
        if (!hits.length) continue
        const first = hits[0]
        out.push(finding(this, page, {
          selector,
          // The hit count stays out of `found`: distinct-defect identity is
          // rule + selector + found, and a term in the shared menu appears a
          // different number of times on every page -- with the count inside
          // `found`, one menu item became one "distinct" defect per page.
          found: `“${term}” in ${where}: ${snippet(String(text), first.index, first[0].length)}`,
          expected: note ? `remove: ${note}` : 'remove the mention',
          occurrences: hits.length,
        }))
      }
    }
    return out
  },
}
