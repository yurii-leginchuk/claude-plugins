import { parse } from 'node-html-parser'
import { normalizeUrl, sameHost } from '../lib/url.js'
import { squash } from '../lib/text.js'

// A short, human-readable path to an element. Not a guaranteed-unique CSS selector —
// it exists so a human can find the element in devtools.
function selectorOf(el) {
  const tag = el.rawTagName || 'node'
  const id = el.getAttribute('id')
  if (id) return `${tag}#${id}`
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2)
  return cls.length ? `${tag}.${cls.join('.')}` : tag
}

function protocolOf(raw) {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec((raw || '').trim())
  return m ? m[1].toLowerCase() : null
}

function parseRobots(root) {
  const el = root.querySelector('meta[name="robots" i]')
  const raw = el ? (el.getAttribute('content') || '') : null
  // Split on commas into individual directive tokens rather than substring-matching the
  // raw string: `content="none"` is the single-token shorthand for `noindex, nofollow`,
  // and token matching avoids false positives from directives like `max-image-preview`.
  const tokens = (raw || '').toLowerCase().split(',').map((t) => t.trim())
  const none = tokens.includes('none')
  return {
    raw,
    index: !none && !tokens.includes('noindex'),
    follow: !none && !tokens.includes('nofollow'),
  }
}

// The choices a visitor can pick in a field: <option> texts (minus the
// empty "Select…" placeholder) and the labels of radio/checkbox inputs. G13
// compares them with the site's services and locations.
function optionsOf(scope) {
  const opts = scope.querySelectorAll('option')
    .filter(o => (o.getAttribute('value') ?? squash(o.text)) !== '')
    .map(o => squash(o.text))
  const choices = scope.querySelectorAll('input[type="radio"], input[type="checkbox"]').map((i) => {
    const id = i.getAttribute('id')
    const label = (id && scope.querySelector(`label[for="${id}"]`)) || i.parentNode
    return squash(label?.text || i.getAttribute('value') || '')
  })
  return [...opts, ...choices].filter(Boolean).slice(0, 200)
}

// What hides content until a visitor opens it -- popups, tabs, accordions,
// sliders -- keyed so the same one on many pages is one part: a popup by its
// id, a widget by its Elementor data-id. The agent opens each by hand.
const PART_KINDS = [
  ['tabs', '.e-n-tabs, .elementor-tabs, .jet-tabs, [role="tablist"]'],
  ['accordion', '.e-n-accordion, .elementor-accordion, .elementor-toggle, .jet-accordion, details'],
  ['slider', '.swiper, .elementor-image-carousel-wrapper, .slick-slider, .splide'],
]
function parseParts(root) {
  const out = []
  const seen = new Set()
  const add = (kind, key, label) => { if (key && !seen.has(`${kind}:${key}`)) { seen.add(`${kind}:${key}`); out.push({ kind, key: `${kind}:${key}`, label: squash(label || '').slice(0, 80) }) } }
  for (const el of root.querySelectorAll('[data-jet-popup], a[href*="elementor-action"][href*="popup"]')) {
    const raw = el.getAttribute('data-jet-popup') || decodeURIComponent(el.getAttribute('href') || '')
    const id = /jet-popup-(\d+)/.exec(raw)?.[1] || /popup[^0-9]{0,20}(\d+)/.exec(raw)?.[1]
    add('popup', id, el.text)
  }
  for (const [kind, sel] of PART_KINDS) {
    for (const el of root.querySelectorAll(sel)) {
      // the outermost match only: a slider inside a tab is the tab's content
      if (el.parentNode?.closest?.(sel)) continue
      const holder = el.closest?.('[data-id]')
      add(kind, holder?.getAttribute('data-id') || selectorOf(el), el.querySelector('h1, h2, h3, h4, summary, .e-n-accordion-item-title-text, .e-n-tab-title-text')?.text || el.text.slice(0, 60))
    }
  }
  return out
}

function parseForms(root) {
  return root.querySelectorAll('form').map((form) => {
    const wrapper = form.closest?.('.gform_wrapper') || null
    const scope = wrapper || form
    const gravity = Boolean(wrapper) || /^gform_/.test(form.getAttribute('id') || '')

    const gfields = scope.querySelectorAll('.gfield').map((f) => {
      const cls = f.getAttribute('class') || ''
      const input = f.querySelector('input, textarea, select')
      // Gravity Forms marks the field's semantic type on the wrapper as `gfield--type-<x>`
      // (e.g. `gfield--type-phone`, `gfield--type-email`). This is an observed fact about
      // the field, unlike inferring purpose from a formatted selector string.
      const typeMatch = /\bgfield--type-([a-z0-9-]+)\b/i.exec(cls)
      return {
        inputType: input ? (input.getAttribute('type') || input.rawTagName) : null,
        fieldType: typeMatch ? typeMatch[1].toLowerCase() : null,
        required: cls.includes('gfield_contains_required'),
        markedRequired: Boolean(f.querySelector('.gfield_required')),
        label: squash(f.querySelector('.gfield_label, legend, label')?.text || '').slice(0, 120),
        options: optionsOf(f),
        selector: selectorOf(f),
      }
    })
    // Other form plugins (Elementor, WPForms, CF7): one field per control,
    // labelled by its <label for>, aria-label, placeholder or name.
    const fields = gfields.length ? gfields : form.querySelectorAll('select, input:not([type="hidden"]):not([type="submit"]), textarea')
      .filter(el => !['radio', 'checkbox'].includes(el.getAttribute('type')) || el.rawTagName === 'select')
      .map((el) => {
        const id = el.getAttribute('id')
        const label = (id && form.querySelector(`label[for="${id}"]`)?.text) ||
          el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || ''
        return {
          inputType: el.getAttribute('type') || el.rawTagName, fieldType: null,
          required: el.hasAttribute('required'), markedRequired: false,
          label: squash(label).slice(0, 120),
          options: el.rawTagName === 'select' ? optionsOf(el) : [],
          selector: selectorOf(el),
        }
      })

    const hasPrivacyCheckbox = scope.querySelectorAll('.gfield').some((f) => {
      const hasCheckbox = Boolean(f.querySelector('input[type="checkbox"]'))
      const label = (f.text || '').toLowerCase()
      const linksPrivacy = f.querySelectorAll('a').some((a) =>
        /privacy/i.test(a.getAttribute('href') || '') || /privacy policy/i.test(a.text || ''))
      return hasCheckbox && (linksPrivacy || label.includes('privacy policy'))
    })

    return { id: form.getAttribute('id') || null, gravity, hasPrivacyCheckbox, fields }
  })
}

function parseElementor(root) {
  const containerIds = new Set()
  const locations = new Set()
  // Elementor puts the id class and the location class on the same element
  // (class="elementor elementor-3374 elementor-location-header"), so this is
  // the only place the id-to-name pairing can be recovered. Once
  // containerIds/locations are flattened per page, a page carrying more than
  // one named location (header AND footer, which real Elementor pages
  // always do) contributes two ids and two names with no way to tell which
  // is which -- see src/browser/regions.js's proveRegions, which prefers
  // this pairing over the single-location fallback for exactly that reason.
  const locationsById = {}
  for (const el of root.querySelectorAll('.elementor')) {
    let elId = null
    let elLocation = null
    for (const c of (el.getAttribute('class') || '').split(/\s+/)) {
      const id = /^elementor-(\d+)$/.exec(c)
      if (id) { containerIds.add(id[1]); elId = id[1] }
      const loc = /^elementor-location-(.+)$/.exec(c)
      if (loc) { locations.add(loc[1]); elLocation = loc[1] }
    }
    if (elId && elLocation) locationsById[elId] = elLocation
  }
  const postCssIds = [...new Set(
    root.querySelectorAll('link[rel="stylesheet"]')
      .map(l => /elementor\/css\/post-(\d+)\.css/.exec(l.getAttribute('href') || ''))
      .filter(Boolean).map(m => m[1])
  )]
  const skeleton = root.querySelectorAll('[data-widget_type]')
    .map(el => el.getAttribute('data-widget_type'))
    .join('>')
  return {
    containerIds: [...containerIds],
    locations: [...locations],
    postCssIds,
    skeleton,
    locationsById,
  }
}

// The main parse keeps <script>/<style> bodies as raw text so S1 can read
// JSON-LD out of them (and so a `<` inside inline JS is never mis-parsed as
// markup). That is the right shape for structured extraction and the wrong
// shape for `page.text`, which content rules (H1's Lorem ipsum scan, E6's
// bare-email scan) read as if it were human copy: a theme's demo payload in a
// JS config yields a Critical on clean copy, and an address in Yoast/RankMath
// Organization JSON-LD yields an E6 major on every page of the site.
const PARSE_OPTIONS = { blockTextElements: { script: true, style: true } }

// Elements whose text is machine payload, never page copy.
const NON_COPY_ELEMENTS = 'script,style,noscript,template'

// `page.text` is built from a *separate* parse of the same HTML with those
// elements removed, so the raw parse above stays intact for jsonLd. Removing
// them from `root` in place would be cheaper, but would leave every later
// reader of `root` silently dependent on running before the removal.
function copyRoot(html) {
  const copy = parse(html, PARSE_OPTIONS)
  for (const el of copy.querySelectorAll(NON_COPY_ELEMENTS)) el.remove()
  return copy
}

// The site-wide header and footer. Elementor's theme builder marks them with
// data-elementor-type; otherwise the first <header> and the last <footer>
// (a page can carry several, e.g. an article's own footer).
const HEADER_SEL = '[data-elementor-type="header"], .elementor-location-header'
const FOOTER_SEL = '[data-elementor-type="footer"], .elementor-location-footer'
const headerOf = (root) => root.querySelector(HEADER_SEL) || root.querySelector('header')
const footerOf = (root) => root.querySelector(FOOTER_SEL) || root.querySelectorAll('footer').pop() || null

const BREADCRUMB_SEL = 'nav[aria-label*="breadcrumb" i], [class*="breadcrumb"], #breadcrumbs'

// Where a link sits, for rules that compare menus (K13), skip site chrome
// (E2, E14, E15) or read breadcrumbs (I10). Footer and header win over nav:
// a footer menu is a <nav> inside the footer, and it is the footer's.
function regionOf(el) {
  let crumb = false, footer = false, header = false, nav = false
  for (let n = el.parentNode; n && n.rawTagName; n = n.parentNode) {
    const tag = n.rawTagName.toLowerCase()
    const cls = n.getAttribute?.('class') || ''
    const type = n.getAttribute?.('data-elementor-type') || ''
    if (/breadcrumb/i.test(cls) || /breadcrumb/i.test(n.getAttribute?.('aria-label') || '') || n.getAttribute?.('id') === 'breadcrumbs') crumb = true
    if (tag === 'footer' || type === 'footer' || /\belementor-location-footer\b/.test(cls)) footer = true
    if (tag === 'header' || type === 'header' || /\belementor-location-header\b/.test(cls)) header = true
    if (tag === 'nav') nav = true
  }
  if (crumb) return 'breadcrumbs'
  if (footer) return 'footer'
  if (header) return 'header'
  if (nav) return 'nav'
  return 'main'
}

// The dropdown a menu link sits in: the parent item of the nearest
// sub-menu (`li > a "Services"` + `ul.sub-menu`). The profile reads a site's
// services and locations from it, whatever their URLs look like.
function menuParentOf(a, url) {
  for (let n = a.parentNode; n && n.rawTagName; n = n.parentNode) {
    if (!/^(ul|ol)$/i.test(n.rawTagName)) continue
    const li = n.parentNode
    if (!li || li.rawTagName?.toLowerCase() !== 'li') continue
    const head = li.querySelector('a, span')
    if (!head || head === a) return null
    return { text: squash(head.text).slice(0, 60), href: head.getAttribute?.('href') ? normalizeUrl(head.getAttribute('href'), url) : null }
  }
  return null
}

function parseBreadcrumbs(root, url) {
  const box = root.querySelector(BREADCRUMB_SEL)
  if (!box) return null
  const items = box.querySelectorAll('a[href]').map(a => ({
    text: squash(a.text), href: normalizeUrl(a.getAttribute('href') || '', url),
  }))
  return { text: squash(box.text).slice(0, 300), items }
}

const JSONLD_PUBLISHED = /"datePublished"\s*:\s*"([^"]+)"/i

// Bumped whenever PageDoc gains or changes a field rules read. A snapshot
// parsed by another version is re-crawled rather than reused: an old PageDoc
// without `region` made K13 see an empty dev menu and report every live menu
// item as lost.
export const PARSE_VERSION = 7

export function parsePage({ url, html, status = 200, headers = {} }) {
  const root = parse(html, PARSE_OPTIONS)

  const canonicalEl = root.querySelector('link[rel="canonical" i]')
  const descEl = root.querySelector('meta[name="description" i]')
  const titleEl = root.querySelector('title')
  const htmlEl = root.querySelector('html')

  const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6').map((h) => ({
    level: Number(h.rawTagName.slice(1)),
    text: squash(h.text),
    imageOnly: squash(h.text) === '' && Boolean(h.querySelector('img,svg')),
    selector: selectorOf(h),
  }))

  // The heading each link sits under, for the report's "where": a selector
  // like `a` is useless for finding the one link among two hundred.
  const sectionOf = new Map()
  let lastHeading = null
  for (const el of root.querySelectorAll('h1,h2,h3,h4,h5,h6,a[href],ul,ol')) {
    if (/^(a|ul|ol)$/i.test(el.rawTagName)) sectionOf.set(el, lastHeading)
    else if (squash(el.text)) lastHeading = squash(el.text).slice(0, 80)
  }

  // Short lists under a heading ("Insurances we accept", "Areas we serve"),
  // for rules that compare the same list across pages (H14).
  const lists = root.querySelectorAll('ul,ol').map((ul) => {
    const items = ul.childNodes.filter(n => n.rawTagName?.toLowerCase() === 'li').map(li => squash(li.text))
    return { heading: sectionOf.get(ul) || null, region: regionOf(ul), items }
  }).filter(l => l.items.length >= 3 && l.items.every(t => t && t.length <= 80)).slice(0, 60)

  const links = root.querySelectorAll('a[href]').map((a) => {
    const raw = (a.getAttribute('href') || '').trim()
    const href = normalizeUrl(raw, url)
    return {
      raw,
      href,
      protocol: protocolOf(raw),
      rel: a.getAttribute('rel') || null,
      target: a.getAttribute('target') || null,
      text: squash(a.text),
      internal: href ? sameHost(href, url) : false,
      region: regionOf(a),
      menuParent: menuParentOf(a, url),
      // Inside a form (a consent checkbox's Privacy Policy link): E3 wants
      // those in a new tab so the filled-in form is not lost.
      inForm: Boolean(a.closest?.('form, .gform_wrapper')),
      section: sectionOf.get(a) || null,
      imageOnly: squash(a.text) === '' && Boolean(a.querySelector('img,svg')),
      selector: selectorOf(a),
    }
  })

  const images = root.querySelectorAll('img').map((img) => {
    const alt = img.getAttribute('alt')
    return {
      src: normalizeUrl(img.getAttribute('src') || img.getAttribute('data-src') || '', url),
      alt: alt == null ? null : alt,
      hasAlt: alt != null,
      decorative: alt === '' || ['presentation', 'none'].includes(img.getAttribute('role') || ''),
      selector: selectorOf(img),
    }
  })

  const jsonLd = root.querySelectorAll('script[type="application/ld+json" i]').map((s) => {
    try {
      const data = JSON.parse(s.text)
      const arr = Array.isArray(data) ? data : [data]
      return { ok: true, error: null, types: arr.map(d => d?.['@type']).filter(Boolean) }
    } catch (e) {
      return { ok: false, error: e.message, types: [] }
    }
  })

  // Raw JSON-LD bodies, for rules that compare business data (phones,
  // emails, rating) and retired terms against the schema as well as the
  // copy -- an old number left only in Organization JSON-LD is exactly what
  // QA keeps finding by hand. Capped per block so one oversized payload
  // cannot bloat every cached PageDoc.
  const jsonLdRaw = root.querySelectorAll('script[type="application/ld+json" i]')
    .map(s => s.text.slice(0, 20000))

  // Google Maps iframes, for E9: QA checks that the map shows the right
  // location, and the embed's src is the only place that is recorded.
  const mapEmbeds = root.querySelectorAll('iframe')
    .map(f => f.getAttribute('src') || f.getAttribute('data-src') || '')
    .filter(src => /google\.[a-z.]+\/maps|maps\.google\./i.test(src))
    .map(src => src.slice(0, 4000))

  // Element ids (and legacy <a name>) a `#fragment` link can land on (F12).
  const ids = [...new Set([
    ...root.querySelectorAll('[id]').map(e => e.getAttribute('id')),
    ...root.querySelectorAll('a[name]').map(e => e.getAttribute('name')),
  ].filter(Boolean))].slice(0, 5000)

  const publishedEl = root.querySelector('meta[property="article:published_time" i]')
  const published = publishedEl?.getAttribute('content')
    || jsonLdRaw.map(b => JSONLD_PUBLISHED.exec(b)?.[1]).find(Boolean) || null

  const headerEl = headerOf(root)
  const logoEl = headerEl?.querySelector('img')
  const copy = copyRoot(html)

  const favicons = root.querySelectorAll('link[rel]')
    .filter(l => /icon/i.test(l.getAttribute('rel') || ''))
    .map(l => ({ href: normalizeUrl(l.getAttribute('href') || '', url), rel: l.getAttribute('rel') }))

  return {
    url,
    status,
    env: null,
    title: titleEl ? squash(titleEl.text) : null,
    metaDescription: descEl ? squash(descEl.getAttribute('content') || '') : null,
    canonical: canonicalEl ? normalizeUrl(canonicalEl.getAttribute('href') || '', url) : null,
    lang: htmlEl ? htmlEl.getAttribute('lang') || null : null,
    robots: parseRobots(root),
    headings,
    links,
    images,
    forms: parseForms(root),
    parts: parseParts(root),
    jsonLd,
    jsonLdRaw,
    mapEmbeds,
    favicons,
    elementor: parseElementor(root),
    landmarks: {
      header: root.querySelectorAll('header').length,
      main: root.querySelectorAll('main').length,
      nav: root.querySelectorAll('nav').length,
    },
    text: squash(copy.querySelector('body')?.text || ''),
    // Site chrome as text, for H10's "this page's footer differs from the
    // rest of the site".
    headerText: squash(headerOf(copy)?.text || '').slice(0, 4000),
    footerText: squash(footerOf(copy)?.text || '').slice(0, 4000),
    logo: logoEl ? normalizeUrl(logoEl.getAttribute('src') || logoEl.getAttribute('data-src') || '', url) : null,
    breadcrumbs: parseBreadcrumbs(root, url),
    bodyClass: root.querySelector('body')?.getAttribute('class') || '',
    siteName: root.querySelector('meta[property="og:site_name" i]')?.getAttribute('content') || null,
    lists,
    published,
    // Only the og article date says "this is a post"; see lib/kinds.js.
    isArticle: Boolean(publishedEl),
    ids,
    contentType: headers['content-type'] || null,
  }
}
