import { finding } from '../index.js'
import { ignoredByFacts } from '../../lib/facts.js'

// Taxonomy H11: "where is the correct email?", "we can change the rating
// from 4.6 to 4.7, as it is now in GBP", "should be 4*". Business data that
// drifted from what the client actually has. Phones are E12's; this rule
// covers emails and the review rating, and only when the facts file names
// them -- without a reference value there is nothing to disagree with.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|css|js|pdf)$/i
const JSONLD_EMAIL = /"email"\s*:\s*"(?:mailto:)?([^"]+)"/gi
// Only the business's aggregate rating: an individual Review's ratingValue
// (a 5 from one customer) is not the GBP average and must not be compared.
const JSONLD_RATING = /"aggregateRating"\s*:\s*\{[^}]*?"ratingValue"\s*:\s*"?([0-9.]+)/gi

// A rating written for people: "4.6 stars", "4.6/5", "4.6 on Google",
// "rated 4.6", "Google rating 4.6". The number must sit next to one of
// those words: a bare "4.6" in copy is as likely a price or a version.
const TEXT_RATING = [
  /(?<![\d.])([1-4]\.\d|5\.0)(?![\d.])\s*(?:\/\s*5|out of 5|stars?|★|on google|google)/gi,
  /(?:rated|rating(?: of)?|google)\s*:?\s*([1-4]\.\d|5\.0)(?![\d.])/gi,
]

export default {
  id: 'H11',
  title: 'Business data does not match the facts (email, rating)',
  severity: 'major',
  engine: 'static',
  check(page, site) {
    const facts = site?.facts
    if (!facts || ignoredByFacts(facts, page.url)) return []
    return [...emails(this, page, facts), ...rating(this, page, facts)]
  },
}

function emails(rule, page, facts) {
  if (!facts.emails.length) return []
  const allowed = new Set(facts.emails)
  const expected = facts.emails.join(', ')
  const out = []
  const seen = new Set()
  const report = (email, selector, where) => {
    const e = email.toLowerCase().split('?')[0]
    if (!e || allowed.has(e) || FILE_EXT.test(e) || seen.has(e)) return
    seen.add(e)
    out.push(finding(rule, page, { selector, found: `email not in the site facts (${where}): ${e}`, expected }))
  }
  for (const l of page.links || []) {
    if (l.protocol === 'mailto:') report(l.raw.replace(/^mailto:/i, ''), l.selector, 'mailto')
  }
  for (const m of String(page.text || '').matchAll(EMAIL)) report(m[0], 'body', 'text')
  for (const block of page.jsonLdRaw || []) {
    for (const m of block.matchAll(JSONLD_EMAIL)) report(m[1], 'script[type="application/ld+json"]', 'schema')
  }
  return out
}

function rating(rule, page, facts) {
  if (facts.rating === null) return []
  const expected = `rating ${facts.rating}`
  const differs = (v) => Math.abs(Number(v) - facts.rating) >= 0.05
  const out = []
  const seen = new Set()
  for (const block of page.jsonLdRaw || []) {
    for (const m of block.matchAll(JSONLD_RATING)) {
      if (!differs(m[1]) || seen.has(`ld${m[1]}`)) continue
      seen.add(`ld${m[1]}`)
      out.push(finding(rule, page, {
        selector: 'script[type="application/ld+json"]', found: `ratingValue in schema: ${m[1]}`, expected,
      }))
    }
  }
  // Read from text, the number's meaning is inferred from the words next to
  // it, so these stay heuristic.
  for (const re of TEXT_RATING) {
    for (const m of String(page.text || '').matchAll(re)) {
      if (!differs(m[1]) || seen.has(`tx${m[1]}`)) continue
      seen.add(`tx${m[1]}`)
      out.push(finding(rule, page, {
        selector: 'body', found: `rating in text: “${m[0].trim()}”`, expected, confidence: 'heuristic',
      }))
    }
  }
  return out
}
