const DEV_HOST = /(^|\.)patest\.website$|(^|[-.])(?:dev|stage|staging|test)\./i

export function isDevHost(host) {
  return host && DEV_HOST.test(host)
}

export function detectEnv({ host, pages = [], pairedAsDev = false, pairedAsDevReason = null, override = null }) {
  if (override === 'dev' || override === 'prod') {
    return { env: override, reason: 'задано флагом --env' }
  }
  if (pairedAsDev) {
    // Callers that know exactly where the dev/prod pairing signal came from
    // (a strategy sheet's Dev Link column vs. a manual --prod flag) can pass
    // a specific reason; this generic wording is only a fallback for callers
    // that don't distinguish the source.
    return { env: 'dev', reason: pairedAsDevReason || 'хост стоит в колонке Dev Link' }
  }
  if (isDevHost(host)) {
    return { env: 'dev', reason: `имя хоста указывает на дев: ${host}` }
  }
  if (pages.length === 0) {
    return { env: 'unknown', reason: 'нет страниц для оценки' }
  }
  const noindex = pages.filter(p => p.robots && p.robots.index === false).length
  if (pages.length >= 5 && noindex / pages.length > 0.8) {
    return { env: 'dev', reason: `noindex на ${noindex} из ${pages.length} страниц` }
  }
  if (pages.length < 5 && noindex > 0) {
    return { env: 'unknown', reason: 'недостаточно страниц для вывода о среде' }
  }
  return { env: 'prod', reason: 'боевой хост, страницы индексируются' }
}
