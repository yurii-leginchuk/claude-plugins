import { finding } from '../index.js'

// Taxonomy I18 (and a good share of E1's "wrong link"): an internal link that
// only works through a redirect -- a permalink without its trailing slash, a
// page renamed during a restructure with the old URL left in the menu. The
// visitor still lands, so nobody notices, but every click costs a hop and
// crawlers keep seeing the old URL.
//
// Reads the redirect target checkLinks recorded (`finalUrl`). Pages cached
// before that field existed have none, and this rule then stays silent.
const SKIP_PATH = /^\/(wp-admin|wp-login\.php|my-account|cart|checkout)\b/

export default {
  id: 'I18',
  title: 'Внутренняя ссылка через редирект',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    const status = site?.linkStatus
    if (!status) return []
    const out = []
    const seen = new Set()
    for (const l of page.links || []) {
      if (!l.internal || !l.href || seen.has(l.href)) continue
      const s = status.get(l.href)
      if (!s?.ok || !s.finalUrl) continue
      let path
      try { path = new URL(l.href).pathname } catch { continue }
      if (SKIP_PATH.test(path)) continue
      seen.add(l.href)
      out.push(finding(this, page, {
        link: l,
        found: `${l.href} → ${s.finalUrl}`,
        expected: `ссылка сразу на ${s.finalUrl}`,
      }))
    }
    return out
  },
}
