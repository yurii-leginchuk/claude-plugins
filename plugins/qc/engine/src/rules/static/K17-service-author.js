import { finding } from '../index.js'

// A post signed by the account that built the site («PA Dev», «admin»,
// «test») rather than by a person: the byline, the author archive it links
// to and the schema's author all tell readers and Google nobody wrote it.
const SERVICE = /^(?:pa[-_ ]?dev|admin(?:istrator)?|test(?:er|ing)?|dev(?:eloper)?|demo|staging|wordpress|webmaster|editor|user\d*|wp[-_ ]?admin)$/i
const LEAD = /^(?:author|by|posted by|written by)\s*:?\s*/i

export default {
  id: 'K17',
  title: 'Автор поста — служебный аккаунт',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    const names = new Map()
    for (const l of page.links || []) {
      const m = /\/author\/([^/?#]+)/.exec(l.href || '')
      if (!m) continue
      const name = String(l.text || '').replace(LEAD, '').trim()
      if (SERVICE.test(m[1]) || SERVICE.test(name)) names.set((name || m[1]).toLowerCase(), { name: name || m[1], link: l })
    }
    for (const raw of page.jsonLdRaw || []) {
      for (const m of String(raw).matchAll(/"author"\s*:\s*\[?\s*\{[^{}]*?"name"\s*:\s*"([^"]+)"/g)) {
        if (SERVICE.test(m[1].trim()) && !names.has(m[1].trim().toLowerCase())) names.set(m[1].trim().toLowerCase(), { name: m[1].trim(), schema: true })
      }
    }
    return [...names.values()].map(({ name, link, schema }) => finding(this, page, {
      ...(link ? { link } : { selector: 'script[type="application/ld+json"]' }),
      found: `автор «${name}»${schema && !link ? ' в schema' : ''} — служебный аккаунт, а не человек`,
      expected: 'настоящий автор (Users → профиль: имя и отображаемое имя) или бренд',
    }))
  },
}
