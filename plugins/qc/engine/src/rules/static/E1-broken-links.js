import { finding } from '../index.js'

export default {
  id: 'E1',
  title: 'Битые ссылки',
  severity: 'critical',
  engine: 'static',
  check(page, site) {
    const status = site?.linkStatus
    const out = []
    for (const l of page.links || []) {
      if (!l.href) continue
      let path = ''
      try { path = new URL(l.href).pathname } catch { path = '' }
      if (path.includes('//')) {
        out.push(finding(this, page, {
          selector: l.selector, found: `двойной слэш в URL: ${l.href}`, expected: 'корректный путь',
        }))
      }
      if (!status) continue
      const s = status.get(l.href)
      if (!s || s.ok) continue
      if (!l.internal) {
        // External link: only a genuine 4xx (the remote page confirms it is
        // gone) is worth reporting, at a lower severity than an internal
        // failure since the client cannot always fix someone else's site.
        // Status 0 (timeout, DNS failure, connection refused) and 5xx
        // (a transient error on their server) are not confirmed dead links
        // -- they are just as likely to be our checker being blocked or a
        // momentary blip on a host we don't control, so they are not
        // reported to avoid accusing the client's site of a defect that is
        // not theirs.
        if (!(s.status >= 400 && s.status < 500)) continue
      }
      out.push(finding(this, page, {
        selector: l.selector,
        found: `HTTP ${s.status || 'нет ответа'}: ${l.href}`,
        expected: 'рабочая ссылка',
        severity: l.internal ? 'critical' : 'major',
      }))
    }
    return out
  },
}
