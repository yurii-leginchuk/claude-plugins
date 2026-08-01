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
      let host = ''
      try {
        const u = new URL(l.href)
        path = u.pathname
        host = u.host
      } catch { /* path/host stay empty; malformed URL is not this branch's concern */ }
      if (path.includes('//')) {
        out.push(finding(this, page, {
          selector: l.selector, found: `двойной слэш в URL: ${l.href}`, expected: 'корректный путь',
        }))
      }
      if (!status) continue
      const s = status.get(l.href)
      if (!s || s.ok) continue
      if (!l.internal) {
        // External link: status 0 (no response at all -- timeout, DNS
        // failure, connection refused) is ambiguous, since it could equally
        // mean our own checker got blocked, not that their site is down. It
        // stays unreported. But a received HTTP status, 4xx OR 5xx, is the
        // remote server itself telling us something is wrong, and by the
        // time it reaches here it has already survived fetchOne's own
        // retries with backoff -- so this is not a transient blip we're
        // catching mid-flight, it's a failure that persisted across several
        // seconds of retrying. That is durable breakage (a decommissioned
        // endpoint, a deleted page), not noise, and staying silent about it
        // would hide a permanently dead link for the life of the site.
        // Reported at a lower severity than an internal failure only
        // because the client cannot always fix someone else's site.
        if (s.status === 0) continue
      }
      out.push(finding(this, page, {
        selector: l.selector,
        found: l.internal
          ? `HTTP ${s.status || 'нет ответа'}: ${l.href}`
          : `внешний хост${host ? ` ${host}` : ''} вернул HTTP ${s.status}, это не ошибка на стороне клиента: ${l.href}`,
        expected: 'рабочая ссылка',
        severity: l.internal ? 'critical' : 'major',
      }))
    }
    return out
  },
}
