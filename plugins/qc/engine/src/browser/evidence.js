// `qc evidence <host>`: a picture of the spot for every distinct defect of the
// latest run, so the reader sees where to look. The example page is opened in
// Chromium at the width the defect was found at, the spot found
// (a link by its href, an element by a precise selector, a text by the words
// around it in `where`, a quote from `found`, an image by alt or src),
// outlined with the rest of the page dimmed, and cropped with its surroundings
// (the whole screen width on a phone), so the reader recognises the place.
// The browser pass's own crops are tight to the element and replaced; one is
// kept only when the spot cannot be found again. Claude then looks at every
// crop while reviewing.
//
// Pictures live at ~/.qc-cache/<host>/evidence/<sha1(identity)>.webp with an
// index (evidence.json: identity -> {path, status, page, width}), so a later
// audit of the same site keeps them. A spot that is not on the page at all
// (title, meta description, schema) is recorded as `invisible`, one the
// locator could not find as `not-found` -- both say so instead of a picture.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchBrowser, preparePage } from './launch.js'
import { snapshotDir, latestRunDir } from '../crawl/store.js'
import { defectIdentity } from '../report/json.js'

export const EVIDENCE_WIDTH = 1440
const PAD = 160
const MAX_H = 760
const MIN_W = 1000
const MIN_H = 420
// Desktop crops are scaled down to keep the report light; phone ones stay 1:1.
const DESKTOP_SCALE = 0.72
const MOBILE = 360
const INVISIBLE = /^(head|html|title)$|^(meta|script|link)\b|script\[|meta\[/i
const GENERIC = /^(body|html|main|a|div|span|p|li|ul|section|img|svg)$/i

// Something the page lacks (no H1, no FAQ block): there is nothing to outline,
// so the picture is the page's first screen, saying so.
export const isMissing = (f) => !f.target && (!f.selector || /^(body|main)$/.test(f.selector)) && /\b(not found|missing|does not|has no|no \w+ block)\b/i.test(String(f.found || ''))
const sha = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
const indexPath = (host) => join(snapshotDir(host), 'evidence.json')

/** «footer · link “Shop now” · at 320 px»: where a person looks for the spot. */
export function spotText(spot, width) {
  if (!spot) return ''
  if (spot.note) return `no picture: ${spot.note}`
  // A name made from an icon's class («search icon») is ours, not the page's words: no quotes.
  const what = !spot.label ? (spot.kind || '') : !spot.kind && /\bicon$/.test(spot.label) ? spot.label : `${spot.kind ? spot.kind + ' ' : ''}“${spot.label}”`
  return [spot.region, what, width ? `at ${width} px` : ''].filter(Boolean).join(' · ')
}

export function loadEvidence(host) {
  const p = indexPath(host)
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}

/** Attach recorded pictures to findings that have none (used by audit and review). */
export function attachEvidence(host, findings) {
  const ev = loadEvidence(host)
  for (const f of findings) {
    const e = ev[defectIdentity(f)]
    if (!e) continue
    f.evidenceStatus = e.status
    delete f.spot
    if (e.spot) f.spot = e.spot
    else if (e.why) f.spot = { note: e.why }
    const ours = !f.shot || f.shot.includes(join(snapshotDir(host), 'evidence'))
    if (e.status === 'ok' && e.path && existsSync(e.path)) { f.shot = e.path; f.shotWidth = e.width; delete f.shotDataUri }
    else if (ours && e.status !== 'ok') { delete f.shot; delete f.shotWidth; delete f.shotDataUri }
  }
  return findings
}

// What to look for, strongest first: the words around the spot (from `where`,
// which carries the page text around it), then the link text, quotes, URLs,
// site paths and phone numbers in `found`.
// The short, exact words of a finding (a phone, a quote, a path) to outline.
export function cores(f) {
  const found = String(f.found || '')
  return [...new Set([
    ...[...found.matchAll(/\+?\d[\d\s().-]{8,}\d/g)].map(m => m[0].trim()),
    ...[...found.matchAll(/(?<![\w.:/-])\/(?:[a-z0-9-]+\/){1,4}/g)].map(m => m[0]),
    ...[...found.matchAll(/[“"«]([^”"»]{3,120})[”"»]/g)].map(m => m[1].trim()),
  ])]
}

export function needles(f) {
  const out = []
  const found = String(f.found || '')
  const quoted = [...found.matchAll(/[“"«]([^”"»]{3,120})[”"»]/g)].map(m => m[1].replace(/…$/, '').trim())
  // H14 quotes the list's heading, then the item: the item is the spot.
  if (f.rule === 'H14') quoted.reverse()
  const urls = [...found.matchAll(/https?:\/\/[^\s”"»)]+/g)].map(m => m[0].replace(/[.,;:]+$/, ''))
  const paths = [...found.matchAll(/(?<![\w.:/-])\/(?:[a-z0-9-]+\/){1,4}/g)].map(m => m[0])
  const phones = [...found.matchAll(/\+?\d[\d\s().-]{8,}\d/g)].map(m => m[0].trim())
  // a bare email in the text (E6), a tel:/mailto: href written as found (E4)
  const emails = [...found.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(m => m[0])
  const hrefs = [...found.matchAll(/\b(?:tel|mailto):[^\s”"»)]+/gi)].map(m => m[0])
  const short = [...hrefs, ...emails, ...phones, ...paths, ...quoted, ...urls]
  const where = String(f.where || '')
  const snippet = (where.split(' · ').find(s => s.startsWith('…')) || '').replace(/^…|…$/g, '').trim()
  for (const n of short) {
    const at = snippet.indexOf(n)
    if (at >= 0) out.push(snippet.slice(Math.max(0, at - 24), at + n.length + 24).trim())
  }
  if (f.locate?.text) out.push(f.locate.text)
  out.push(...short)
  return [...new Set(out.filter(n => n && n.length >= 3))]
}

// Runs in the page; self-contained. Finds the spot, outlines it, returns its
// box -- or {hidden} when the spot is there but nobody can see it.
export function locateSpot({ sel, href, linkText, needles: ns, cores = [], notInLinks = false, notInChrome = false, pastEdge = false, exact = false, marks = [] }) {
  const vis = (e) => {
    const r = e.getBoundingClientRect()
    if (r.width < 3 || r.height < 3) return false
    return !e.checkVisibility || e.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  }
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const chrome = (e) => Boolean(e.closest('header, footer, [data-elementor-type=header], [data-elementor-type=footer]'))
  const ok = (e) => vis(e) && !(notInLinks && e.closest('a')) && !(notInChrome && chrome(e))
  const byText = (list) => (linkText ? list.filter(a => norm(a.textContent) === norm(linkText)) : []).concat(list)
  const pick = (list) => list.find(a => ok(a) && !chrome(a)) || list.find(ok) || null
  const precise = sel && (exact || /#|elementor-element-[0-9a-f]{6,}|\[/.test(sel))
  let el = null
  let how = null
  if (href && href !== '#') {
    el = pick(byText([...document.querySelectorAll('a[href]')].filter(a => a.getAttribute('href') === href)))
    if (el) how = 'href'
  }
  if (!el) {
    for (const n of ns) {
      if (!/^(tel|mailto):/i.test(n)) continue
      el = pick([...document.querySelectorAll('a[href]')].filter(a => a.getAttribute('href').trim().toLowerCase() === n.toLowerCase()))
      if (el) { how = 'link href'; break }
    }
  }
  if (!el) {
    for (const n of ns) {
      if (!/^https?:\/\//.test(n)) continue
      el = pick(byText([...document.querySelectorAll('a[href]')].filter(a => a.href === n || a.href.replace(/\/$/, '') === n.replace(/\/$/, ''))))
      if (el) { how = 'link url'; break }
    }
  }
  if (!el && linkText) {
    el = pick([...document.querySelectorAll('a, button')].filter(a => norm(a.textContent) === norm(linkText) && (!href || a.getAttribute('href') === href)))
    if (el) how = 'link text'
  }
  // Past the screen edge: of all the matches, the one that sticks out.
  if (!el && sel && pastEdge) {
    try { el = [...document.querySelectorAll(sel)].find(e => ok(e) && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1) || null } catch { el = null }
    if (el) how = 'selector, past the edge'
    // Nothing sticks out on a fresh load (it showed only in the resize sweep):
    // any other match would point at the wrong thing.
    else return { hidden: 'nothing goes past the screen edge on a fresh load at this width; it showed in the resize sweep' }
  }
  if (!el && precise) {
    try { el = [...document.querySelectorAll(sel)].find(ok) || null } catch { el = null }
    if (el) how = 'selector'
  }
  if (!el) {
    const els = [...document.body.querySelectorAll('*')].filter(e => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(e.tagName))
    for (const n of ns) {
      const want = norm(n)
      const img = [...document.querySelectorAll('img')].find(i => norm(i.alt).includes(want) || String(i.currentSrc || i.src).toLowerCase().includes(want))
      if (img && want.length > 8) {
        if (!vis(img)) return { hidden: img.closest('.jet-popup, .elementor-popup-modal, [role=dialog], dialog, [class*=popup], [class*=modal]') ? 'it is inside a popup that is closed when the page loads; open the popup to see it' : 'the image is on the page but hidden at this width' }
        el = img; how = `image: ${n.slice(0, 40)}`; break
      }
      // With notInLinks, only the element's own words outside any link count.
      // The words have to be visible themselves (a box can be visible while
      // the byline inside it is hidden), and with notInLinks outside links.
      const textOf = (e) => {
        let t = ''
        const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT)
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const p = n.parentElement
          if (notInLinks && p.closest('a')) continue
          if (!vis(p)) continue
          t += ' ' + n.nodeValue
        }
        return norm(t)
      }
      let best = null
      for (const e of els) {
        if (!norm(e.textContent).includes(want) || !ok(e)) continue
        const t = textOf(e)
        if (!t.includes(want)) continue
        if (!best || t.length < textOf(best).length) best = e
      }
      if (best) { el = best; how = `text: ${n.slice(0, 40)}`; break }
    }
  }
  if (!el && sel && !precise) {
    try { el = [...document.querySelectorAll(sel)].find(ok) || null } catch { el = null }
    if (el) how = 'selector'
  }
  if (!el) {
    // There, but not visible: screen-reader text, a hidden-at-this-width block.
    let any = null
    try { any = (href && href !== '#' && document.querySelector(`a[href="${CSS.escape(href)}"]`)) || (sel && document.querySelector(sel)) } catch { any = null }
    const POPUP = '.jet-popup, .elementor-popup-modal, [role=dialog], dialog, [class*=popup], [class*=modal]'
    const inPopup = (e) => Boolean(e && e.closest(POPUP))
    const closedPopup = 'it is inside a popup that is closed when the page loads; open the popup to see it'
    if (any && !vis(any)) return { hidden: inPopup(any) ? closedPopup : 'the element is on the page but not visible at this width' }
    // the words are in the page but nobody sees them now: a closed popup, tab, slider or menu
    for (const n of ns.filter(n => n.length > 8)) {
      const want = norm(n)
      const holder = [...document.body.querySelectorAll('*')].reverse().find(e => norm(e.textContent).includes(want))
      if (holder) return { hidden: inPopup(holder) ? closedPopup : 'the text is on the page but hidden (a closed tab, slide or menu); open it to see it' }
    }
    return null
  }
  // Several mistakes in one block (typos, a repeated phrase): the block is the
  // spot and each mistake is marked inside it.
  let target = el
  if (marks.length) {
    for (const m of marks) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.nodeValue.toLowerCase().indexOf(String(m).toLowerCase())
        if (i < 0 || node.parentElement.closest('[data-qc-mark]')) continue
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + m.length)
        const span = document.createElement('span')
        span.setAttribute('data-qc-mark', '')
        span.style.cssText = 'background:rgba(224,36,94,.22);outline:2px solid #e0245e;border-radius:2px'
        try { range.surroundContents(span) } catch { /* across tags: the block stays the spot */ }
        break
      }
    }
  } else if (norm(el.textContent).length > 80) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    outer: for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const c of cores) {
        const i = node.nodeValue.toLowerCase().indexOf(String(c).toLowerCase())
        if (i < 0) continue
        if (notInLinks && node.parentElement.closest('a')) continue
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + c.length)
        const span = document.createElement('span')
        span.setAttribute('data-qc-mark', '')
        try { range.surroundContents(span); target = span } catch { /* keep the block */ }
        break outer
      }
    }
  }
  // A pinned header is photographed at the top of the page, where it belongs;
  // other pinned bars are hidden so they do not land in the middle of a crop.
  const pinned = (e) => { for (let p = e; p && p !== document.body; p = p.parentElement) { if (/fixed|sticky/.test(getComputedStyle(p).position)) return p } return null }
  const own = pinned(target)
  if (own) window.scrollTo(0, 0)
  else target.scrollIntoView({ block: 'center', inline: 'nearest' })
  for (const e of document.body.querySelectorAll('*')) {
    if (e === own || e.contains(target) || !/fixed|sticky/.test(getComputedStyle(e).position)) continue
    e.setAttribute('data-qc-hid', e.style.visibility || '')
    e.style.visibility = 'hidden'
  }
  const r = target.getBoundingClientRect()
  target.setAttribute('data-qc-ev', target.getAttribute('style') || '')
  target.style.outline = '4px solid #e0245e'
  target.style.outlineOffset = '4px'
  // A spotlight: everything around the spot is dimmed.
  const veil = document.createElement('div')
  veil.setAttribute('data-qc-veil', '')
  const top = r.top + window.scrollY - 8
  const left = r.left + window.scrollX - 8
  Object.assign(veil.style, {
    position: 'absolute', zIndex: 2147483647, pointerEvents: 'none', borderRadius: '6px',
    top: top + 'px', left: left + 'px', width: (r.width + 16) + 'px', height: (r.height + 16) + 'px',
    boxShadow: '0 0 0 4px #e0245e, 0 0 0 99999px rgba(15, 20, 30, .45)',
  })
  document.body.appendChild(veil)
  // What a person would call it, and where on the page it is.
  const named = el.closest('a, button, [role=button], img, input, select, textarea, label, h1, h2, h3, h4, h5, h6, li, p') || el
  // The visible words first; an aria-label like «Opens in a new tab» is a hint, not a name.
  const hint = /^(opens?|open) in a new (tab|window)\.?$/i
  const words = (e) => [e.innerText, e.getAttribute('alt'), e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')]
    .map(v => String(v || '').replace(/\s+/g, ' ').trim()).find(v => v && !hint.test(v)) || ''
  let label = words(target) || words(named)
  if (!label) {
    const svg = named.querySelector && named.querySelector('svg, i[class*=icon], [class*=icon]')
    const cls = String((svg && svg.getAttribute('class')) || named.getAttribute('class') || '').match(/(?:fa|eicon|icon)-([a-z-]+)/)
    label = cls && !/^(wrapper|box|list|container|inner)$/.test(cls[1]) ? `${cls[1].replace(/-/g, ' ')} icon` : (svg ? 'icon' : '')
  }
  const kind = { A: 'link', BUTTON: 'button', IMG: 'image', INPUT: 'field', SELECT: 'field', TEXTAREA: 'field', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' }[named.tagName] || (named.getAttribute('role') === 'button' ? 'button' : '')
  const region = el.closest('header, [data-elementor-type=header]') ? 'header'
    : el.closest('footer, [data-elementor-type=footer]') ? 'footer'
      : el.closest('[role=dialog], .elementor-popup-modal, .jet-popup, [class*=popup], [class*=modal]') ? 'popup'
        : el.closest('nav') ? 'menu' : 'page content'
  const spot = { region, kind, label: label.slice(0, 70) }
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height, how, spot, docW: document.documentElement.scrollWidth }
}

function clearSpot() {
  const el = document.querySelector('[data-qc-ev]')
  if (el) {
    const prev = el.getAttribute('data-qc-ev')
    if (prev) el.setAttribute('style', prev)
    else el.removeAttribute('style')
    el.removeAttribute('data-qc-ev')
  }
  document.querySelectorAll('[data-qc-mark]').forEach(mark => mark.replaceWith(...mark.childNodes))
  document.querySelectorAll('[data-qc-veil]').forEach(v => v.remove())
  document.querySelectorAll('[data-qc-hid]').forEach(e => { e.style.visibility = e.getAttribute('data-qc-hid'); e.removeAttribute('data-qc-hid') })
}

async function crop(page, box, width, path) {
  // On a phone or tablet the whole screen width, so the place is recognisable.
  const phone = width < 1024
  // Past the right edge (a horizontal-scroll defect): widen to show how far.
  const w = phone ? Math.min(box.docW, Math.max(width, Math.ceil(box.x + box.w + 24))) : Math.min(width, Math.max(MIN_W, Math.ceil(box.w + PAD * 2)))
  const x = phone ? 0 : Math.max(0, Math.min(Math.floor(box.x + box.w / 2 - w / 2), Math.max(0, box.docW - w)))
  const h = Math.min(MAX_H, Math.max(phone ? 560 : MIN_H, Math.ceil(box.h + PAD * 2)))
  const y = Math.max(0, Math.floor(box.y + box.h / 2 - h / 2))
  const scale = phone ? 1 : DESKTOP_SCALE
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'webp', quality: 70, captureBeyondViewport: true, clip: { x, y, width: Math.max(1, w), height: Math.max(1, h), scale },
    })
    writeFileSync(path, Buffer.from(data, 'base64'))
  } finally {
    await cdp.detach().catch(() => {})
  }
}

export async function captureEvidence(host, { force = false, launchBrowserImpl = launchBrowser, onProgress = null } = {}) {
  const dir = latestRunDir(host)
  if (!dir || !existsSync(join(dir, 'findings.json'))) throw new Error(`no run for ${host}: run qc audit first`)
  const findings = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8'))
  const index = force ? {} : loadEvidence(host)
  const byIdentity = new Map()
  for (const f of findings) {
    const id = defectIdentity(f)
    if (!byIdentity.has(id)) byIdentity.set(id, f)
  }
  // Claude's own defects (the review file) get their spot outlined the same way,
  // found by their selector or the words they quote; a picture marked by the
  // agent itself (box) is kept as it is.
  if (existsSync(join(dir, 'review.json'))) {
    const { reviewedRun, evidenceKey } = await import('../review.js')
    for (const f of reviewedRun(host).kept) {
      if (f.engine !== 'claude' || f.marked || !/^https?:/.test(String(f.page))) continue
      const id = evidenceKey(f)
      if (!byIdentity.has(id)) byIdentity.set(id, { ...f, shot: undefined, shotWidth: undefined })
    }
  }
  const todo = []
  const summary = { defects: byIdentity.size, captured: 0, already: 0, browserShots: 0, invisible: 0, notFound: [] }
  for (const [identity, f] of byIdentity) {
    // Ours are redone with --force; a browser-pass crop stays only as a fallback.
    const ours = f.shot && f.shot.includes(`${join(snapshotDir(host), 'evidence')}`)
    if (f.shot && !ours) summary.browserShots++
    if (ours && force) { delete f.shot; delete f.shotWidth; delete f.shotDataUri }
    if (index[identity]?.status === 'ok' && existsSync(index[identity].path)) { summary.already++; continue }
    if (INVISIBLE.test(String(f.selector || '')) || f.zone === 'head' || ['X1', 'J1'].includes(f.rule) || /screen-reader|screen-only|skip-link/.test(String(f.selector || ''))) {
      index[identity] = { status: 'invisible', page: f.page }
      summary.invisible++
      continue
    }
    // At the width it was found at: a 320 px overflow does not exist at 1440.
    todo.push({ identity, f, width: f.shotWidth || f.breakpoint || EVIDENCE_WIDTH, missing: isMissing(f) })
  }
  const groups = new Map()
  for (const t of todo) {
    const k = `${t.f.page}|${t.width}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(t)
  }
  mkdirSync(join(snapshotDir(host), 'evidence'), { recursive: true })
  const { browser, newPage } = await launchBrowserImpl({})
  let done = 0
  try {
    for (const items of groups.values()) {
      const { f: f0, width } = items[0]
      const page = await newPage()
      try {
        await preparePage(page, { width, url: f0.page })
        for (const { identity, f, missing } of items) {
          if (missing) {
            const path = join(snapshotDir(host), 'evidence', sha(identity) + '.webp')
            await page.evaluate(() => window.scrollTo(0, 0))
            await crop(page, { x: 0, y: 0, w: width, h: 700, docW: width }, width, path)
            index[identity] = { status: 'ok', path, page: f.page, width, how: 'first screen', spot: { region: 'the page’s first screen', label: null, kind: 'nothing to outline: it is missing' } }
            summary.captured++
            done++
            continue
          }
          // A defect that names its target is looked for by that only.
          const t = f.target
          const sel = t ? (t.selector || null) : f.selector && !GENERIC.test(f.selector) ? f.selector : null
          const args = {
            sel, href: f.locate?.href || null, linkText: f.locate?.text || null,
            needles: t ? (t.text ? [t.text] : []) : needles(f), cores: t ? (t.text ? [t.text] : []) : cores(f), exact: Boolean(t?.selector), marks: t?.marks || [],
            notInLinks: f.rule === 'E13', notInChrome: f.zone === 'main' || f.selector === 'main', pastEdge: ['C1', 'C8'].includes(f.rule),
          }
          let box = null
          try { box = await page.evaluate(locateSpot, args) } catch { box = null }
          // Hidden on desktop (a mobile-only byline): try the phone width.
          if ((!box || box.hidden) && width !== MOBILE) {
            try {
              await preparePage(page, { width: MOBILE, url: f.page })
              const again = await page.evaluate(locateSpot, args)
              if (again && !again.hidden) { box = again; box.width = MOBILE }
            } catch { /* keep the first answer */ }
            await preparePage(page, { width, url: f0.page }).catch(() => {})
          }
          if (box?.hidden) {
            index[identity] = { status: 'invisible', page: f.page, width, why: box.hidden }
            summary.invisible++
          } else if (!box) {
            index[identity] = { status: 'not-found', page: f.page, width }
            summary.notFound.push(identity)
          } else {
            const path = join(snapshotDir(host), 'evidence', sha(identity) + '.webp')
            const w = box.width || width
            if (box.width) {
              // Re-locate at the phone width: the page was reloaded at desktop.
              await preparePage(page, { width: w, url: f.page })
              const at = await page.evaluate(locateSpot, args)
              if (at && !at.hidden) await crop(page, at, w, path)
              await preparePage(page, { width, url: f0.page }).catch(() => {})
            } else {
              await crop(page, box, w, path)
              await page.evaluate(clearSpot).catch(() => {})
            }
            index[identity] = { status: 'ok', path, page: f.page, width: w, how: box.how, spot: box.spot }
            summary.captured++
          }
          done++
          if (onProgress) onProgress({ done, total: todo.length })
        }
      } catch (e) {
        for (const { identity, f } of items) {
          if (!index[identity]) {
            index[identity] = { status: 'not-found', page: f.page, width, error: String(e.message || e).slice(0, 160) }
            summary.notFound.push(identity)
          }
        }
      } finally {
        await page.close().catch(() => {})
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }
  writeFileSync(indexPath(host), JSON.stringify(index, null, 1))
  // The run itself carries the pictures now, for `qc review` and `qc push`.
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(attachEvidence(host, findings), null, 2))
  return { host, runDir: dir, ...summary, notFound: summary.notFound.length, notFoundIdentities: summary.notFound }
}
