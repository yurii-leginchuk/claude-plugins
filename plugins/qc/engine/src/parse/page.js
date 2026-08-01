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

function parseForms(root) {
  return root.querySelectorAll('form').map((form) => {
    const wrapper = form.closest?.('.gform_wrapper') || null
    const scope = wrapper || form
    const gravity = Boolean(wrapper) || /^gform_/.test(form.getAttribute('id') || '')

    const fields = scope.querySelectorAll('.gfield').map((f) => {
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
        selector: selectorOf(f),
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
  for (const el of root.querySelectorAll('.elementor')) {
    for (const c of (el.getAttribute('class') || '').split(/\s+/)) {
      const id = /^elementor-(\d+)$/.exec(c)
      if (id) containerIds.add(id[1])
      const loc = /^elementor-location-(.+)$/.exec(c)
      if (loc) locations.add(loc[1])
    }
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
  }
}

export function parsePage({ url, html, status = 200, headers = {} }) {
  const root = parse(html, { blockTextElements: { script: true, style: true } })

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
    jsonLd,
    favicons,
    elementor: parseElementor(root),
    landmarks: {
      header: root.querySelectorAll('header').length,
      main: root.querySelectorAll('main').length,
      nav: root.querySelectorAll('nav').length,
    },
    text: squash(root.querySelector('body')?.text || ''),
    contentType: headers['content-type'] || null,
  }
}
