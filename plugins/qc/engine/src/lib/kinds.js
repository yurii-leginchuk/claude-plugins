// Page kinds several rules must agree on.

// A post: the WordPress `single-post` body class, or the og article date.
// Not JSON-LD datePublished -- Yoast puts that on the WebPage node of every
// page, which made E14 and H5 treat each service page as a post.
export const isPost = (p) => /\bsingle-post\b/.test(p.bodyClass || '') || Boolean(p.isArticle)

// A PPC landing page: /lp/…, /landing/…, /ppc/….
const LANDING = /^\/(lp|landing|ppc)(\/|$)/i
export const isLandingPath = (path) => LANDING.test(path || '')
