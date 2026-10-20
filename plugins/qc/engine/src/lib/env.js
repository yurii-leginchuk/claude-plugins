// Misclassifying a production site as dev is not a cosmetic mistake: it makes
// I4 (noindex, Critical) silent on every page and disables I14 entirely, so a
// production site shipped with `noindex` would pass QC without a word. The old
// `(^|[-.])` prefix accepted a hyphen before every keyword, which classified
// plausible production domains -- quest-test.com, intelli-test.com, pro-dev.com,
// best-dev.io -- as dev.
//
// Each alternative below, and why it is shaped the way it is:
//
//   (^|\.)patest\.website$   the agency's own staging domain, exact match.
//   (^|\.)(dev|stage|...)\.  the keyword as a whole label: dev.acme.com,
//                            staging.acme.com. A label boundary on both sides,
//                            so `contest.com` and `devonshire.com` cannot match.
//   -staging\.               a hyphenated staging suffix is unambiguous in
//                            practice: acme-staging.com is a staging site, and
//                            no production brand is named "<x>-staging".
//   -dev\.(?=[^.]+\.)        "-dev" is NOT unambiguous -- it is a common brand
//                            word (pro-dev.com, best-dev.io, web-dev.io). So it
//                            only counts in subdomain position, where at least
//                            one more label follows the one it ends
//                            (starshep-dev.example.com matches; pro-dev.com
//                            does not). This is the one place the review's
//                            suggested pattern had to be tightened: a bare
//                            `-dev\.` re-admits exactly the false positives it
//                            was meant to remove.
//
// Bare `-test.` is dropped entirely: "test" is far too common a brand word
// (quest-test, intelli-test, a-b-test) to carry the cost of a wrong answer.
const DEV_HOST = /(^|\.)patest\.website$|(^|\.)(?:dev|stage|staging|test)\.|-staging\.|-dev\.(?=[^.]+\.)/i

export function isDevHost(host) {
  return host && DEV_HOST.test(host)
}

export function detectEnv({ host, pages = [], pairedAsDev = false, pairedAsDevReason = null, override = null }) {
  if (override === 'dev' || override === 'prod') {
    return { env: override, reason: 'set by the --env flag' }
  }
  if (pairedAsDev) {
    // Callers that know exactly where the dev/prod pairing signal came from
    // (a strategy sheet's Dev Link column vs. a manual --prod flag) can pass
    // a specific reason; this generic wording is only a fallback for callers
    // that don't distinguish the source.
    return { env: 'dev', reason: pairedAsDevReason || 'the host is in the Dev Link column' }
  }
  if (isDevHost(host)) {
    return { env: 'dev', reason: `the host name points to dev: ${host}` }
  }
  if (pages.length === 0) {
    return { env: 'unknown', reason: 'no pages to judge by' }
  }
  const noindex = pages.filter(p => p.robots && p.robots.index === false).length
  if (pages.length >= 5 && noindex / pages.length > 0.8) {
    return { env: 'dev', reason: `noindex on ${noindex} of ${pages.length} pages` }
  }
  if (pages.length < 5 && noindex > 0) {
    return { env: 'unknown', reason: 'not enough pages to tell the environment' }
  }
  return { env: 'prod', reason: 'live host, pages are indexed' }
}
