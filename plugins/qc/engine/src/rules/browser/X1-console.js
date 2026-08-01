export const meta = {
  id: 'X1',
  title: 'Ошибки консоли и упавшие запросы',
  severity: 'major',
  confidence: 'high',
}

// Runs inside the page. Self-contained by contract.
//
// window.__qcConsole is populated by launch.js's preparePage(), which tags
// every entry 'same-origin: ' or 'third-party: ' by comparing the offending
// resource's host to the page's own host. Third-party noise (analytics, chat
// widgets, ad blockers) is not the client's defect, but it is never dropped
// -- it is reported at 'minor' severity instead of 'major' so nothing goes
// silently missing from the findings.
export function check(ctx) {
  const log = window.__qcConsole || []
  const seen = {}
  const out = []
  for (let i = 0; i < log.length; i++) {
    const raw = String(log[i])
    const thirdParty = raw.indexOf('third-party: ') === 0
    const rest = thirdParty ? raw.slice('third-party: '.length) : raw.replace(/^same-origin: /, '')
    const line = rest.slice(0, 200)
    const key = (thirdParty ? '3p:' : '1p:') + line
    if (seen[key]) continue
    seen[key] = 1
    out.push({
      rule: 'X1', title: 'Ошибки консоли и упавшие запросы',
      severity: thirdParty ? 'minor' : 'major',
      confidence: 'high', engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
      selector: null,
      found: (thirdParty ? '[стороннее] ' : '') + line,
      expected: 'консоль без ошибок',
    })
  }
  return out
}
