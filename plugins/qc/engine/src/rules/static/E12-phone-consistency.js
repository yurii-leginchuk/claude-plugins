import { finding, whereInText } from '../index.js'
import { phoneKey, textPhones } from '../../lib/phone.js'
import { ignoredByFacts } from '../../lib/facts.js'

// Taxonomy E12 + H11: "old number here", "old number in schema", "wrong phone
// number in href (all new pages)" -- 20 QA remarks in a year, every one found
// by hand.
//
// Two modes, because the engine only knows what "right" is when someone
// told it:
//
//   with facts.phones: any tel: link, visible number or JSON-LD telephone
//     that is not one of the site's numbers is a confirmed defect.
//   without facts: the site is compared against itself. A number dialled
//     from one or two pages while another number is on most of the site is
//     very often a leftover -- but a multi-location site legitimately puts a
//     different number on every location page, so this stays heuristic and
//     never moves the verdict.
//
// Visible text and schema are only scanned in facts mode: without a
// reference, a number in body copy (a partner's, a hotline's) is not
// evidence of anything.
const JSONLD_PHONE = /"telephone"\s*:\s*"([^"]+)"/gi

// Below this many pages a "most of the site" majority is noise.
const MIN_MAJORITY_PAGES = 3

export default {
  id: 'E12',
  title: 'Телефон не совпадает с остальным сайтом или с фактами',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const facts = site?.facts
    if (facts?.phones?.length) return againstFacts(this, page, facts)
    return againstSite(this, page, site?.index?.phones)
  },
}

function againstFacts(rule, page, facts) {
  if (ignoredByFacts(facts, page.url)) return []
  const allowed = new Set(facts.phones.map(p => p.key))
  const expected = facts.phones.map(p => p.raw).join(', ')
  const out = []
  const seen = new Set()
  const report = (key, selector, found, extra = {}) => {
    if (!key || allowed.has(key) || seen.has(`${selector}|${key}`)) return
    seen.add(`${selector}|${key}`)
    out.push(finding(rule, page, { selector, found, expected, ...extra }))
  }
  for (const l of page.links || []) {
    if (l.protocol === 'tel:') report(phoneKey(l.raw), l.selector, `номер не из фактов сайта: ${l.raw}`, { link: l })
  }
  // A number in the copy may be someone else's on purpose (the SAMHSA
  // helpline on every rehab site), so only tel: links and schema are certain.
  for (const p of textPhones(page.text)) {
    report(p.key, 'body', `номер в тексте не из фактов сайта: ${p.raw}`, { confidence: 'heuristic', where: whereInText(page, p.raw) })
  }
  for (const block of page.jsonLdRaw || []) {
    for (const m of block.matchAll(JSONLD_PHONE)) {
      report(phoneKey(m[1]), 'script[type="application/ld+json"]', `telephone в schema не из фактов сайта: ${m[1]}`)
    }
  }
  return out
}

function againstSite(rule, page, phones) {
  if (!phones || phones.size < 2) return []
  let majorityKey = null
  let majorityPages = 0
  for (const [key, urls] of phones) {
    if (urls.size > majorityPages) { majorityKey = key; majorityPages = urls.size }
  }
  if (majorityPages < MIN_MAJORITY_PAGES) return []
  const rare = Math.max(1, Math.floor(majorityPages * 0.2))

  const out = []
  const seen = new Set()
  for (const l of page.links || []) {
    if (l.protocol !== 'tel:') continue
    const key = phoneKey(l.raw)
    if (!key || key === majorityKey || seen.has(key)) continue
    const urls = phones.get(key)
    if (!urls || urls.size > rare) continue
    seen.add(key)
    out.push(finding(rule, page, {
      link: l,
      found: `${l.raw} встречается на ${urls.size} стр., а +${majorityKey} — на ${majorityPages}`,
      expected: `+${majorityKey}, если это не номер отдельной локации`,
      confidence: 'heuristic',
    }))
  }
  return out
}
