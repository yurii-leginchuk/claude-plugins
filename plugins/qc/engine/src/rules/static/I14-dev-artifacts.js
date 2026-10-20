import { finding } from '../index.js'
import { hostOf, sameHost } from '../../lib/url.js'
import { isDevHost } from '../../lib/env.js'

// I14 is symmetric, because the mistake is symmetric: a URL left pointing at
// the environment the page is NOT in.
//
//   on prod: a link or image still pointing at the dev/staging host -- copy
//            that went live before the URLs were swapped back.
//   on dev:  a link or image still pointing at the production host --
//            unreplaced absolute paths, which make a dev site quietly serve
//            and link production content, so the thing under test is not the
//            thing that was built. Dev is the primary target environment for
//            this engine, so this is the direction that matters daily.
//
// The dev direction needs to know what "production" IS. That is only known
// when the run carries a dev<->prod pairing: an explicit `--prod <url>`, or a
// strategy sheet whose Dev Link column pairs each dev URL with its live one.
// Without that, this rule emits nothing rather than guessing which of a page's
// outbound hosts is "the" production domain -- a wrong guess there would flag
// every external link on the site.
export default {
  id: 'I14',
  title: 'Links to the other environment (dev on prod, prod on dev)',
  severity: 'critical',
  engine: 'static',
  check(page, site) {
    if (site?.env === 'prod') return checkTargets(this, page, isDevHost, 'dev')
    if (site?.env === 'dev') {
      const prodHost = site?.prodHost
      if (!prodHost) return []
      return checkTargets(this, page, (host) => sameHost(`https://${host}`, `https://${prodHost}`), 'prod')
    }
    return []
  },
}

// `isForeign` is applied to the *hostname*, never to the raw URL string: a
// production URL carrying a dev address in a query parameter
// (/redirect?next=https://x.patest.website/) is not a dev artifact, and a
// hostname that merely starts with the dev domain
// (foo.patest.website.evil.com) is a different host entirely.
function checkTargets(rule, page, isForeign, label) {
  const out = []
  const expected = label === 'dev' ? 'the production domain' : 'the dev domain or a relative path'

  for (const l of page.links || []) {
    if (!l.href) continue
    const host = hostOf(l.href)
    if (host && isForeign(host)) {
      out.push(finding(rule, page, {
        link: l, found: `link to ${label}: ${l.href}`, expected,
      }))
    }
  }
  for (const i of page.images || []) {
    if (!i.src) continue
    const host = hostOf(i.src)
    if (host && isForeign(host)) {
      out.push(finding(rule, page, {
        selector: i.selector, found: `image from ${label}: ${i.src}`, expected,
      }))
    }
  }
  return out
}
