import { finding } from '../index.js'

export default {
  id: 'I5',
  title: 'Canonical страницы',
  severity: 'critical',
  engine: 'static',
  check(page, _site) {
    if (!page.canonical) {
      return [finding(this, page, {
        selector: 'head', found: 'canonical отсутствует', expected: page.url,
      })]
    }
    if (page.canonical !== page.url) {
      // Check if they differ only by trailing slash
      const withoutTrailingSlash = (url) => url.endsWith('/') ? url.slice(0, -1) : url
      const urlWithoutSlash = withoutTrailingSlash(page.url)
      const canonicalWithoutSlash = withoutTrailingSlash(page.canonical)

      if (urlWithoutSlash === canonicalWithoutSlash) {
        // They differ only by trailing slash - make it explicit
        const slashMsg = page.canonical.endsWith('/') ? 'canonical с лишним слешем' : 'canonical без слеша'
        return [finding(this, page, {
          selector: 'link[rel=canonical]',
          found: `${slashMsg}: ${page.canonical}`,
          expected: page.url,
        })]
      }

      const httpDowngrade = page.url.startsWith('https://') && page.canonical.startsWith('http://')
      return [finding(this, page, {
        selector: 'link[rel=canonical]',
        found: httpDowngrade ? `canonical на http: ${page.canonical}` : page.canonical,
        expected: page.url,
      })]
    }
    return []
  },
}
