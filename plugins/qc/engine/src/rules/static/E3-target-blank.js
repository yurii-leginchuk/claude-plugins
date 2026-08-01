import { finding } from '../index.js'

export default {
  id: 'E3',
  title: 'Правила target=_blank для внутренних и внешних ссылок',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const out = []
    for (const l of page.links || []) {
      if (!l.href) continue
      const blank = (l.target || '').toLowerCase() === '_blank'
      if (l.internal && blank) {
        // Explicit agency house rule: internal navigation must never force a
        // new tab. This is a real, actionable defect -- stays at the rule's
        // default major/high.
        out.push(finding(this, page, {
          selector: l.selector, found: `внутренняя ссылка с target=_blank: ${l.raw}`,
          expected: 'без target',
        }))
      }
      if (!l.internal && !blank) {
        // Whether an external link opens in a new tab is a per-client style
        // preference, not a defect -- demoted to minor and marked heuristic
        // so it never moves the verdict.
        out.push(finding(this, page, {
          selector: l.selector, found: `внешняя ссылка без target: ${l.raw}`,
          expected: 'target=_blank rel="noopener"',
          severity: 'minor',
          confidence: 'heuristic',
        }))
      }
      if (!l.internal && blank && !/noopener/i.test(l.rel || '')) {
        // Browsers have implied rel="noopener" for target="_blank" since
        // 2021 (Chrome 88, Firefox 79, Safari 12.1). A missing explicit
        // noopener is therefore no longer a live reverse-tabnabbing
        // vulnerability in any supported browser -- it is markup hygiene,
        // not a security defect. Demoted to minor; confidence stays high
        // because the absence is directly observed from markup, not
        // inferred. Do NOT re-escalate this back to major/critical.
        out.push(finding(this, page, {
          selector: l.selector, found: `внешняя ссылка без rel=noopener: ${l.raw}`,
          expected: 'rel="noopener"',
          severity: 'minor',
        }))
      }
    }
    return out
  },
}
