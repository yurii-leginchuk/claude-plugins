const HTTP = new Set(['http:', 'https:'])

export function normalizeUrl(input, base) {
  if (!input || typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.startsWith('#')) return null
  let u
  try {
    u = base ? new URL(raw, base) : new URL(raw)
  } catch {
    return null
  }
  if (!HTTP.has(u.protocol)) return null
  u.hash = ''
  u.hostname = u.hostname.toLowerCase()
  if ((u.protocol === 'https:' && u.port === '443') ||
      (u.protocol === 'http:' && u.port === '80')) {
    u.port = ''
  }
  return u.toString()
}

export function isHttpUrl(input) {
  try {
    return HTTP.has(new URL(input).protocol)
  } catch {
    return false
  }
}

export function hostOf(input) {
  try {
    return new URL(input).hostname.toLowerCase()
  } catch {
    return null
  }
}

const bare = (h) => (h || '').replace(/^www\./, '')

export function sameHost(a, b) {
  const ha = hostOf(a)
  const hb = hostOf(b)
  return Boolean(ha && hb && bare(ha) === bare(hb))
}
