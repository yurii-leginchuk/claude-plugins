import { digitsOnly } from './text.js'

// The single definition of "this tel: value carries its country code twice".
//
// E4 (tel: formatting) and E5 (doubled country code) both look at the same
// hrefs, and they used to disagree about this shape: for `tel:+1+17189690845`
// E4 proposed `tel:+117189690845` (still doubled -- wrong) while E5 proposed
// `tel:+17189690845` (correct), both at major severity. A report that hands a
// human two different "expected" values for one href is worse than a report
// that says nothing, so the predicate lives here and both rules import it:
// E5 owns the shape and proposes the correction, E4 stays out of it entirely.
//
// Returns null when the value is not doubled, so callers can branch on it
// directly.
export function doubledCountryCode(raw) {
  const value = String(raw ?? '')
  const digits = digitsOnly(value)
  // Literal duplication in the markup: `tel:+1+1718...`.
  const doubledPlus = (value.match(/\+/g) || []).length > 1
  // A US number written with its leading 1 twice: 12 digits starting "11".
  const doubledOne = digits.length === 12 && digits.startsWith('11')
  if (!doubledPlus && !doubledOne) return null

  // Whether the value carries a SECOND defect beyond the doubling itself: any
  // character other than a digit or '+' -- a hyphen, space, dot, parenthesis
  // -- surviving in the raw markup. Separator characters are untouched by
  // undoing the doubling (`expected` below is built straight off
  // `digitsOnly`, which strips them regardless), so their presence in the
  // ORIGINAL value already answers "is the non-doubled form still not
  // clean?" without needing to construct that corrected string first.
  const body = value.replace(/^tel:/, '')
  const stillMalformed = /[^\d+]/.test(body)

  return {
    doubledPlus,
    doubledOne,
    digits,
    stillMalformed,
    expected: `tel:+${digits.replace(/^11/, '1')}`,
    // doubledPlus is read straight off the markup -- two '+' characters in one
    // href is not a judgement call. doubledOne *infers* the defect from a
    // digit pattern: 12 digits starting "11" is overwhelmingly a doubled US
    // country code, but it is a legitimate shape for some international
    // numbers, so that branch is heuristic per this engine's convention.
    confidence: doubledPlus ? 'high' : 'heuristic',
  }
}

// One comparable key per phone number, so `tel:+1 (718) 969-0845`,
// `tel:17189690845` and a typed `(718) 969-0845` all collapse to the same
// value. A bare 10-digit number is treated as North American and given its
// leading 1 -- every site this engine audits is US/CA-first, and comparing
// `7189690845` against `17189690845` as different numbers would report one
// phone as two. Anything else is kept as its digits.
//
// The href is percent-decoded first: `tel:(855)%20607-8758` is a real shape
// on WordPress sites, and reading `%20` as the digits "20" turned one number
// into a different one (seen live on libertybayrecovery.com).
export function phoneKey(raw) {
  let value = String(raw ?? '').replace(/^tel:/i, '')
  try { value = decodeURIComponent(value) } catch { value = value.replace(/%[0-9a-f]{2}/gi, ' ') }
  const d = digitsOnly(value)
  if (!d) return null
  if (d.length === 10) return `1${d}`
  return d
}

// Visible North American numbers in running text. Each group must be
// separated (space, dot, hyphen, or parentheses round the area code): an
// unbroken run of 10 digits is far more often an order id, a timestamp or a
// licence number than a phone written for people.
const TEXT_PHONE = /(?<![\d-])(?:\+?1[\s.-]?)?(?:\((\d{3})\)\s?|(\d{3})[\s.-])(\d{3})[\s.-](\d{4})(?![\d-])/g

export function textPhones(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(TEXT_PHONE)) {
    out.push({ raw: m[0].trim(), key: `1${m[1] || m[2]}${m[3]}${m[4]}` })
  }
  return out
}
