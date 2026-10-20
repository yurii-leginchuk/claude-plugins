import { pathKey } from './url.js'

// The page's kind, for grouping the report's screenshots: the facts file's
// `pages` map when Claude confirmed one, else the site profile (services,
// locations) and the URL. Same names as the facts file's PAGE_TYPES.
export const TYPE_ORDER = ['home', 'service-hub', 'service', 'location-hub', 'location', 'blog', 'post', 'about',
  'team', 'contact', 'admissions', 'landing', 'careers', 'legal', 'thank-you', 'other']
export const TYPE_LABEL = {
  home: 'Home', 'service-hub': 'Services hub', service: 'Services', 'location-hub': 'Locations hub', location: 'Locations',
  blog: 'Blog and categories', post: 'Posts', about: 'About', team: 'Team', contact: 'Contact',
  admissions: 'Insurance and admissions', landing: 'Landing pages (PPC)', careers: 'Careers', legal: 'Legal',
  'thank-you': 'Thank-you pages', other: 'Other',
}
const BLOG = /^\/(?:blog|news|articles|resources|insights)(\/|$)/

export function pageType(page, profile = null, facts = null) {
  const key = pathKey(page.url)
  if (!key) return 'other'
  if (facts?.pages?.[key]) return facts.pages[key]
  if (key === '/') return 'home'
  const same = (u) => Boolean(u) && pathKey(u) === key
  if (same(profile?.services?.hub)) return 'service-hub'
  if (profile?.services?.items?.some(i => same(i.url))) return 'service'
  if (same(profile?.locations?.hub)) return 'location-hub'
  if (profile?.locations?.items?.some(i => same(i.url))) return 'location'
  const p = key.toLowerCase()
  if (/thank/.test(p)) return 'thank-you'
  if (/privacy|terms|cookie|disclaimer|accessibility|legal/.test(p)) return 'legal'
  if (/^\/(?:category|tag|author)\//.test(p)) return 'blog'
  if (page.isArticle || page.published || (BLOG.test(p) && p.split('/').filter(Boolean).length > 1)) return 'post'
  if (BLOG.test(p)) return 'blog'
  if (/^\/about/.test(p)) return 'about'
  if (/team|staff|doctors|providers/.test(p)) return 'team'
  if (/contact/.test(p)) return 'contact'
  if (/insurance|admission|intake|verify/.test(p)) return 'admissions'
  if (/^\/lp\//.test(p)) return 'landing'
  if (/career|jobs/.test(p)) return 'careers'
  return 'other'
}
