import { finding } from '../index.js'

// Statuses an external host returns when it is refusing an automated,
// non-browser request rather than actually lacking the resource. Facebook,
// chamber-of-commerce directories, and similar third parties routinely 400
// or 403 a headless fetch while the same link works fine for a real visitor
// with a real browser/session/cookies. Treated as "needs a human to click
// it," not as confirmed breakage.
const BOT_BLOCKED_STATUSES = new Set([400, 401, 403, 405, 429])

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
      // Cloudflare email obfuscation: a script turns it into mailto: in the
      // browser, while a plain request gets 404.
      if (l.href.includes('/cdn-cgi/l/email-protection')) continue
      let path = ''
      let host = ''
      try {
        const u = new URL(l.href)
        path = u.pathname
        host = u.host
      } catch { /* path/host stay empty; malformed URL is not this branch's concern */ }
      if (path.includes('//')) {
        out.push(finding(this, page, {
          link: l, found: `двойной слэш в URL: ${l.href}`,
          // A pasted absolute URL after a relative one ("/a/https://x/a/"):
          // the second URL is the one meant.
          expected: /^https?:\/\/.+https?:\/\//.test(l.href) ? l.href.slice(l.href.lastIndexOf('http')) : 'корректный путь',
        }))
      }
      if (!status) continue
      const s = status.get(l.href)
      if (!s || s.ok) continue

      if (l.internal) {
        // Internal failure: our own infrastructure, always our bug,
        // regardless of status code (including status 0 -- a timeout on our
        // own site is still our problem).
        out.push(finding(this, page, {
          link: l,
          found: `HTTP ${s.status || 'нет ответа'}: ${l.href}`,
          expected: 'рабочая ссылка',
          severity: 'critical',
        }))
        continue
      }

      // External link: status 0 (no response at all -- timeout, DNS
      // failure, connection refused) is ambiguous, since it could equally
      // mean our own checker got blocked, not that their site is down. It
      // stays unreported.
      if (s.status === 0) continue

      if (BOT_BLOCKED_STATUSES.has(s.status)) {
        // A received 400/401/403/405/429 from a third-party host is far
        // more likely that host refusing our non-browser request than a
        // genuinely dead link -- see BOT_BLOCKED_STATUSES above. Reported at
        // `note` and marked heuristic so it is set aside for a human to
        // manually confirm by opening the link, rather than counted as a
        // confirmed defect.
        out.push(finding(this, page, {
          link: l,
          found: `внешний хост${host ? ` ${host}` : ''} вернул HTTP ${s.status} -- похоже на блокировку автоматического запроса (бот-защита), а не битую ссылку; требуется ручная проверка перехода по ссылке: ${l.href}`,
          expected: 'подтвердить вручную переходом по ссылке в браузере',
          severity: 'note',
          confidence: 'heuristic',
        }))
        continue
      }

      // Any other received HTTP status (404/410 -- the resource is
      // genuinely gone, or a 5xx) is the remote server itself telling us
      // something is wrong, and by the time it reaches here it has already
      // survived fetchOne's own retries with backoff -- so this is not a
      // transient blip we're catching mid-flight, it's a failure that
      // persisted across several seconds of retrying. That is durable
      // breakage (a decommissioned endpoint, a deleted page, a crashed
      // origin), not noise, and staying silent about it would hide a
      // permanently dead link for the life of the site. Reported at a lower
      // severity than an internal failure only because the client cannot
      // always fix someone else's site.
      out.push(finding(this, page, {
        link: l,
        found: `внешний хост${host ? ` ${host}` : ''} вернул HTTP ${s.status}, это не ошибка на стороне клиента: ${l.href}`,
        expected: 'рабочая ссылка',
        severity: 'major',
      }))
    }
    return out
  },
}
