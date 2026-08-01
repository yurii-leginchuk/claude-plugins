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
  return {
    doubledPlus,
    doubledOne,
    digits,
    expected: `tel:+${digits.replace(/^11/, '1')}`,
    // doubledPlus is read straight off the markup -- two '+' characters in one
    // href is not a judgement call. doubledOne *infers* the defect from a
    // digit pattern: 12 digits starting "11" is overwhelmingly a doubled US
    // country code, but it is a legitimate shape for some international
    // numbers, so that branch is heuristic per this engine's convention.
    confidence: doubledPlus ? 'high' : 'heuristic',
  }
}
