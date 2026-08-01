import { finding } from '../index.js'

export default {
  id: 'I13',
  title: 'Favicon страницы',
  severity: 'minor',
  engine: 'static',
  check(page, site) {
    const icons = page.favicons || []
    if (!icons.length) {
      // We only observe the absence of a <link rel="icon"> declaration, not
      // whether the browser's implicit /favicon.ico convention happens to be
      // serving one anyway -- checkLinks never fetches that implicit path
      // because it isn't a PageDoc field. So "no favicon" here is an
      // inference from missing markup, not a confirmed missing/broken icon.
      return [finding(this, page, {
        selector: 'head', found: 'favicon не объявлен', expected: '<link rel="icon">',
        confidence: 'heuristic',
      })]
    }
    const status = site?.linkStatus
    if (!status) return []
    const broken = icons.filter(i => i.href && status.get(i.href) && !status.get(i.href).ok)
    if (!broken.length) return []
    // A page commonly declares several icon variants (icon, apple-touch-icon,
    // shortcut icon). When they are all served from the same broken origin,
    // reporting one finding per <link> is noise that overstates the problem
    // -- collapse to a single finding per page. Several `rel` values can
    // point at the very same broken URL (e.g. `icon` and `shortcut icon`
    // both set to /favicon.ico); dedupe by href first so that URL is not
    // listed twice, merging the rel names that reference it.
    const byHref = new Map()
    for (const i of broken) {
      if (!byHref.has(i.href)) byHref.set(i.href, new Set())
      byHref.get(i.href).add(i.rel || 'icon')
    }
    const list = [...byHref.entries()]
      .map(([href, rels]) => `${[...rels].join('/')} ${href} (HTTP ${status.get(href).status || 'нет ответа'})`)
      .join(', ')
    return [finding(this, page, {
      selector: 'link[rel~=icon]',
      found: `favicon не отдаёт 200: ${list}`,
      expected: 'все объявленные favicon отдают 200',
    })]
  },
}
