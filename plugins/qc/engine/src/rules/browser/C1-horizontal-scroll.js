export const meta = {
  id: 'C1',
  title: 'Горизонтальный скролл документа',
  severity: 'critical',
  confidence: 'high',
}

// Runs inside the page. Self-contained by contract.
export function check(ctx) {
  const doc = document.documentElement
  const overflow = doc.scrollWidth - doc.clientWidth
  if (overflow <= 1) return []          // 1px tolerance for sub-pixel rounding
  return [{
    rule: 'C1',
    title: 'Горизонтальный скролл документа',
    severity: 'critical',
    confidence: 'high',
    engine: 'browser',
    page: ctx.url,
    breakpoint: ctx.breakpoint,
    selector: 'html',
    // Page-level finding, not tied to any one element -- explicitly null
    // rather than omitted, so it can't be mistaken for "not yet computed".
    containerId: null,
    found: 'ширина документа ' + doc.scrollWidth + 'px при вьюпорте ' + doc.clientWidth + 'px',
    expected: 'документ не шире вьюпорта',
  }]
}
