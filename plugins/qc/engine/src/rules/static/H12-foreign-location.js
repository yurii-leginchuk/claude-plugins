import { finding } from '../index.js'
import { ignoredByFacts } from '../../lib/facts.js'
import { US_STATES, stateOfAddress } from '../../lib/address.js'

// Taxonomy H3/H12: "Connecticut instead of another state", "content from
// another site of the network" -- copy pasted from a sister site (Florida
// Helps -> Texas Helps) keeps the other state's name.
//
// The states this page is about: from facts (`states` plus the states of
// the gbp addresses), else the states named in its title and H1. Any other
// state named in the copy is reported. Heuristic: "clients travel from
// Oklahoma" is legitimate, and a page naming many states is a list of
// service areas, not a copy-paste.
const MAX_STATES = 6
// Longest names first, so "West Virginia" is consumed before "Virginia".
const NAMES = Object.values(US_STATES).sort((a, b) => b.length - a.length)
const NAME_RE = new RegExp(`\\b(${NAMES.join('|')})\\b`, 'g')

function statesIn(text) {
  const found = new Set()
  for (const m of String(text || '').matchAll(NAME_RE)) {
    // "Washington, DC", "Washington County" and "George Washington" are not
    // the state.
    if (m[1] === 'Washington' && /^\s*(,?\s*D\.?C\b|County|Street|St\b|Ave)/.test(text.slice(m.index + m[0].length))) continue
    if (m[1] === 'Washington' && /[A-Z][a-z]+\s$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    found.add(m[1])
  }
  return found
}

export default {
  id: 'H12',
  title: 'Упоминается чужой штат',
  severity: 'minor',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    const facts = site?.facts
    if (ignoredByFacts(facts, page.url)) return []
    let own = new Set([
      ...(facts?.states || []),
      ...(facts?.gbp || []).map(g => stateOfAddress(g.address)).filter(Boolean),
    ])
    if (!own.size) {
      const h1 = (page.headings || []).filter(h => h.level === 1).map(h => h.text).join(' ')
      own = statesIn(`${page.title || ''} ${h1}`)
    }
    if (!own.size) return []
    // The header and footer list every location of a multi-state brand on
    // every page; only the page's own copy can mention the wrong state.
    let copy = String(page.text || '')
    for (const chrome of [page.headerText, page.footerText]) if (chrome) copy = copy.replace(chrome, ' ')
    const mentioned = statesIn(copy)
    if (mentioned.size > MAX_STATES) return []
    // A state that is a link ("New Jersey" -> /locations/new-jersey/) is
    // navigation to another location, not pasted copy.
    const linked = new Set((page.links || []).map(l => (l.text || '').trim()))
    const ownLabel = [...own].join(', ')
    return [...mentioned].filter(s => !own.has(s) && !linked.has(s)).map(s => finding(this, page, {
      selector: 'body',
      found: `на странице про ${ownLabel} упоминается ${s}`,
      expected: `только ${ownLabel}, если упоминание не намеренное`,
    }))
  },
}
