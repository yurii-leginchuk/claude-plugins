import { finding, whereInText } from '../index.js'
import { buildProfile } from '../../lib/profile.js'

// The site disagreeing with itself on facts a visitor reads: "15 years of
// experience" on one page and "since 2005" on another, "12 services" with 14
// service pages, "24/7" next to "Mon–Fri 8am–6pm", two prices for one
// service, one person with two job titles.
//
// Each fact is collected site-wide once; the finding goes to the pages that
// carry the minority value, so one contradiction is one distinct defect.
// Heuristic throughout: "24/7 emergency line" next to office hours, or a
// "starting at" price next to a full price, can both be right.

const YEARS = [
  /\b(\d{1,3})\+?\s+years?\s+(?:of\s+experience|in\s+business|of\s+service|serving)/gi,
  /\bover\s+(\d{1,3})\s+years\b/gi,
]
const SINCE = /\b(?:since|founded in|established in|est\.)\s+((?:19|20)\d{2})\b/gi
const COUNT = /\b(\d{1,3})\+?\s+(services|locations|offices)\b/gi
// Availability, not care: "24/7 support" in a residential program is clinical.
const ALWAYS_OPEN = /\b(?:we(?:'re| are)?|call(?: us)?|reach us|our (?:team|phones?|lines?|admissions(?: team)?)(?: is| are)?)\s+(?:open\s+|available\s+)?24\/7\b|\bopen 24\/7\b|\b24\/7\s+(?:admissions?|hotline|helpline|phone line)\b|\bopen 24 hours\b|\bwe(?:'re| are) (?:open|available) 24 hours a day/i
const DAY = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?'
const TIME = '\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)'
const LIMITED_HOURS = new RegExp(`\\b${DAY}\\s*(?:[-–—]|to|through)\\s*${DAY}[:,]?\\s*${TIME}\\s*(?:[-–—]|to)\\s*${TIME}|\\b${TIME}\\s*[-–—]\\s*${TIME}`, 'i')
const LD_HOURS = /"openingHours"\s*:\s*"([^"]+)"|"opens"\s*:\s*"([^"]+)"[^}]*"closes"\s*:\s*"([^"]+)"/gi
const PRICE = /\$\s?(\d[\d,]*(?:\.\d{2})?)/
const ROLE = 'Director|Manager|CEO|Founder|Owner|President|Therapist|Counselor|Coordinator|Nurse|Physician|Clinician|Psychiatrist|Specialist|Supervisor'
const PERSON = new RegExp(`\\b((?:Dr\\.\\s+)?[A-Z][a-z]+(?:\\s+[A-Z]\\.)?(?:\\s+[A-Z][a-z'-]+){1,2})(?:,\\s*[A-Z][A-Z.]{1,7}\\b)*\\s*[,–—-]?\\s*((?:[A-Z][a-z]+\\s+){0,3}(?:${ROLE}))\\b`, 'g')
// Capitalised words that start a phrase, not a name ("Our Clinical Director").
const NOT_A_NAME = /^(Our|The|Your|Meet|Contact|Call|Clinical|Medical|Program|Executive|Admissions|Call|About|Ask|Head|Lead|Senior|Assistant|Associate|Director|Manager)\b/

// A claim about the business, not a staff bio ("Matt has worked in the field
// since 2009"): its sentence has a we/our/serving cue and no he/she/his/her.
const aboutBusiness = (text, at) => {
  // The sentence the claim is in, up to the claim and a little after it.
  const start = Math.max(text.lastIndexOf('. ', at), text.lastIndexOf('? ', at), text.lastIndexOf('! ', at), at - 160, 0)
  const sentence = text.slice(start, at + 30)
  return !/\b(he|she|his|her|him)\b/i.test(sentence) && /\b([Ww]e|[Ww]e've|[Oo]ur|[Ss]erving(?! as)|in business|[Pp]roudly)\b/.test(sentence)
}

const chromeless = (p) => {
  let t = String(p.text || '')
  for (const c of [p.headerText, p.footerText]) if (c) t = t.replace(c, ' ')
  return t
}

const index = new WeakMap()

function collect(site, now) {
  if (index.has(site)) return index.get(site)
  const years = [] // { url, years, raw }
  const counts = [] // { url, n, what, raw }
  const always = [] // { url, raw }
  const limited = [] // { url, raw }
  const prices = new Map() // service -> Map(price -> [{url, raw}])
  const roles = new Map() // name -> Map(role -> [url])
  const services = buildProfile(site).services.items.map(s => s.name).filter(n => n && n.length >= 4)

  for (const p of site.pages || []) {
    const text = chromeless(p)
    for (const re of YEARS) for (const m of text.matchAll(re)) if (aboutBusiness(text, m.index)) years.push({ url: p.url, years: Number(m[1]), raw: m[0] })
    for (const m of text.matchAll(SINCE)) if (aboutBusiness(text, m.index)) years.push({ url: p.url, years: now - Number(m[1]), raw: m[0] })
    for (const m of text.matchAll(COUNT)) counts.push({ url: p.url, n: Number(m[1]), what: m[2].toLowerCase(), raw: m[0] })

    const a = ALWAYS_OPEN.exec(text)
    if (a) always.push({ url: p.url, raw: a[0] })
    const l = LIMITED_HOURS.exec(text)
    if (l) limited.push({ url: p.url, raw: l[0] })
    for (const block of p.jsonLdRaw || []) {
      for (const m of block.matchAll(LD_HOURS)) {
        const spec = m[1] || `${m[2]}-${m[3]}`
        if (!/00:00\s*-\s*(23:59|24:00)/.test(spec)) limited.push({ url: p.url, raw: `schema: ${spec}` })
      }
    }

    const lower = text.toLowerCase()
    for (const s of services) {
      for (let i = lower.indexOf(s.toLowerCase()); i >= 0; i = lower.indexOf(s.toLowerCase(), i + 1)) {
        const m = PRICE.exec(text.slice(i + s.length, i + s.length + 60))
        if (!m) continue
        const price = m[1].replace(/,/g, '')
        if (!prices.has(s)) prices.set(s, new Map())
        const byPrice = prices.get(s)
        if (!byPrice.has(price)) byPrice.set(price, [])
        byPrice.get(price).push({ url: p.url, raw: `$${m[1]}` })
      }
    }

    for (const m of text.matchAll(PERSON)) {
      const name = m[1].trim()
      if (NOT_A_NAME.test(name)) continue
      const role = m[2].trim()
      if (!roles.has(name)) roles.set(name, new Map())
      const byRole = roles.get(name)
      if (!byRole.has(role)) byRole.set(role, new Set())
      byRole.get(role).add(p.url)
    }
  }
  const out = { years, counts, always, limited, prices, roles }
  index.set(site, out)
  return out
}

// The value most pages carry; ties keep the first seen.
const majority = (groups) => [...groups].sort((a, b) => b[1].length - a[1].length)[0]

export default {
  id: 'H16',
  title: 'Facts on the site contradict each other',
  severity: 'minor',
  engine: 'static',
  confidence: 'heuristic',
  check(page, site) {
    if (!site?.pages) return []
    const now = new Date(site.now || Date.now()).getFullYear()
    const c = collect(site, now)
    const out = []
    const push = (props) => out.push(finding(this, page, props))

    // Years in business: clusters within one year of each other agree.
    const clusters = []
    for (const y of c.years) {
      const cl = clusters.find(k => Math.abs(k.years - y.years) <= 1)
      if (cl) cl.items.push(y)
      else clusters.push({ years: y.years, items: [y] })
    }
    if (clusters.length > 1) {
      const top = clusters.sort((a, b) => b.items.length - a.items.length)[0]
      for (const y of c.years.filter(y => y.url === page.url && Math.abs(y.years - top.years) > 1)) {
        push({
          selector: 'body', where: whereInText(page, y.raw),
          found: `“${y.raw}” (≈${y.years} years), while other pages say “${top.items[0].raw}” (≈${top.years} years)`,
          expected: `one years-of-experience figure across the whole site, e.g. “${top.items[0].raw}”`,
        })
      }
    }

    // "N services/locations" against the pages the site actually has.
    const profile = buildProfile(site)
    const actual = { services: profile.services.items.length, locations: profile.locations.items.length, offices: profile.locations.items.length }
    for (const k of c.counts.filter(k => k.url === page.url)) {
      const n = actual[k.what]
      if (n < 3 || k.n === n) continue
      push({
        selector: 'body', where: whereInText(page, k.raw),
        found: `text says “${k.raw}”, but the ${k.what} section has ${n} pages`,
        expected: `“${n} ${k.what}” or remove the number`,
      })
    }

    // 24/7 against limited hours: reported on whichever side is rarer.
    if (c.always.length && c.limited.length) {
      const alwaysRarer = new Set(c.always.map(a => a.url)).size <= new Set(c.limited.map(l => l.url)).size
      const mine = (alwaysRarer ? c.always : c.limited).find(x => x.url === page.url)
      const other = (alwaysRarer ? c.limited : c.always)[0]
      if (mine) {
        push({
          selector: 'body', where: whereInText(page, mine.raw.replace(/^schema: /, '')),
          found: `opening hours: “${mine.raw}” here, but “${other.raw}” on ${other.url}`,
          expected: 'the same opening hours across the whole site (or clarify that 24/7 is only the emergency line)',
        })
      }
    }

    // One service, two prices.
    for (const [service, byPrice] of c.prices) {
      if (byPrice.size < 2) continue
      const [topPrice, topItems] = majority(byPrice)
      for (const [price, items] of byPrice) {
        if (price === topPrice) continue
        const mine = items.find(i => i.url === page.url)
        if (!mine) continue
        push({
          selector: 'body', where: whereInText(page, mine.raw),
          found: `price of “${service}”: ${mine.raw} here, but $${topPrice} on ${topItems[0].url}`,
          expected: 'one price per service across the whole site',
        })
      }
    }

    // One person, two titles.
    for (const [name, byRole] of c.roles) {
      if (byRole.size < 2) continue
      const [topRole, topPages] = [...byRole].sort((a, b) => b[1].size - a[1].size)[0]
      for (const [role, pages] of byRole) {
        if (role === topRole || !pages.has(page.url)) continue
        push({
          selector: 'body', where: whereInText(page, name),
          found: `${name} is “${role}” here, but “${topRole}” on ${[...topPages][0]}`,
          expected: 'one job title per person across the whole site',
        })
      }
    }
    return out
  },
}
