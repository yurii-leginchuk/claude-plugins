// Street-address comparison: "5806 Culebra Rd." and "5806 Culebra Road"
// are one street. Lowercased, punctuation dropped, suffixes and directions
// abbreviated, padded with spaces so `includes(' 12 main st ')` cannot match
// inside "112 main st".
const SUFFIX = {
  street: 'st', road: 'rd', avenue: 'ave', boulevard: 'blvd', drive: 'dr', lane: 'ln',
  highway: 'hwy', parkway: 'pkwy', court: 'ct', place: 'pl', circle: 'cir', suite: 'ste',
  terrace: 'ter', trail: 'trl', square: 'sq', north: 'n', south: 's', east: 'e', west: 'w',
}

export const addressNorm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').map(w => SUFFIX[w] || w).join(' ')} `

// "5806 Culebra Road, San Antonio, TX 78228" -> "5806 Culebra Road".
export const streetOf = (address) => String(address || '').split(',')[0].trim()

export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
}

// The state an address is in: ", TX 78228" or a spelled-out name.
export function stateOfAddress(address) {
  const abbr = /,\s*([A-Z]{2})\s+\d{5}\b/.exec(address || '')
  if (abbr && US_STATES[abbr[1]]) return US_STATES[abbr[1]]
  // After the street line only: "100 Georgia Ave, Silver Spring, Maryland".
  const rest = String(address || '').split(',').slice(1).join(',')
  return Object.values(US_STATES).find(n => new RegExp(`\\b${n}\\b`).test(rest)) || null
}
