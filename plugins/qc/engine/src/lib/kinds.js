// Page kinds several rules must agree on.

// A post: the WordPress `single-post` body class, or the og article date.
// Not JSON-LD datePublished -- Yoast puts that on the WebPage node of every
// page, which made E14 and H5 treat each service page as a post.
export const isPost = (p) => /\bsingle-post\b/.test(p.bodyClass || '') || Boolean(p.isArticle)

// A PPC landing page: /lp/…, /landing/…, /ppc/….
const LANDING = /^\/(lp|landing|ppc)(\/|$)/i
export const isLandingPath = (path) => LANDING.test(path || '')

// A form's confirmation page ("/thank-you/", "/contact/thank-you/"): sites
// keep several on purpose, with one title and H1, no crumbs and no inbound
// links -- none of that is a defect there.
export const isThankYouUrl = (url) => { try { return /thank/i.test(new URL(url).pathname) } catch { return false } }

// The pages the browser pass and Claude look at closely: every page that is
// not a post, plus the newest `posts` posts of each section (Infinity: all).
// Posts share a template per section, so the newest ten of each show how it
// renders; the static audit still reads every post. `postSections` names
// sections of custom post types (news, white-paper) the WordPress body class
// does not mark as posts; `skipSections` are left out (popup bodies published
// as pages).
export const BROWSE_POSTS = 10
const sectionOf = (url) => { try { return new URL(url).pathname.split('/').filter(Boolean)[0] || '' } catch { return '' } }
export function browsePages(pages, posts = BROWSE_POSTS, { postSections = [], skipSections = [] } = {}) {
  const isEntry = (p) => isPost(p) || (postSections.includes(sectionOf(p.url)) && new URL(p.url).pathname.split('/').filter(Boolean).length > 1)
  const bySection = new Map()
  for (const p of pages.filter(isEntry)) {
    const k = sectionOf(p.url)
    if (!bySection.has(k)) bySection.set(k, [])
    bySection.get(k).push(p)
  }
  const keep = new Set()
  for (const list of bySection.values()) {
    for (const p of list.sort((a, b) => String(b.published || '').localeCompare(String(a.published || ''))).slice(0, posts)) keep.add(p.url)
  }
  return pages.filter(p => !skipSections.includes(sectionOf(p.url)) && (!isEntry(p) || keep.has(p.url))).map(p => p.url)
}
