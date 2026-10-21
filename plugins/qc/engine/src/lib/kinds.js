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
// not a post, plus the newest `posts` posts (Infinity: all of them). Posts
// share one template, so the newest ten show how it renders; the static audit
// still reads every post.
export const BROWSE_POSTS = 10
export function browsePages(pages, posts = BROWSE_POSTS) {
  const newest = pages.filter(isPost).sort((a, b) => String(b.published || '').localeCompare(String(a.published || ''))).slice(0, posts)
  const keep = new Set(newest.map(p => p.url))
  return pages.filter(p => !isPost(p) || keep.has(p.url)).map(p => p.url)
}
