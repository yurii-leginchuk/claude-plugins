// `qc evidence <host>`: a picture of the spot for every distinct defect of the
// latest run, so the reader sees where to look. The browser rules already crop
// theirs; for the rest, the example page is opened in Chromium, the spot found
// (a link by its href, an element by a precise selector, a text by the words
// around it in `where`, a quote from `found`, an image by alt or src),
// outlined, and cropped. Claude then looks at every crop while reviewing.
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
const PAD = 48
const MAX_H = 720
const MIN_W = 640
const MIN_H = 240
const MOBILE = 360
const INVISIBLE = /^(head|html|title)$|^(meta|script|link)\b|script\[|meta\[/i
const GENERIC = /^(body|html|main|a|div|span|p|li|ul|section|img|svg)$/i

const sha = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
const indexPath = (host) => join(snapshotDir(host), 'evidence.json')

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
    const ours = !f.shot || f.shot.includes(join(snapshotDir(host), 'evidence'))
    if (ours && e.status === 'ok' && e.path && existsSync(e.path)) { f.shot = e.path; f.shotWidth = e.width }
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
  const urls = [...found.matchAll(/https?:\/\/[^\s”"»)]+/g)].map(m => m[0].replace(/[.,;:]+$/, ''))
  const paths = [...found.matchAll(/(?<![\w.:/-])\/(?:[a-z0-9-]+\/){1,4}/g)].map(m => m[0])
  const phones = [...found.matchAll(/\+?\d[\d\s().-]{8,}\d/g)].map(m => m[0].trim())
  const short = [...phones, ...paths, ...quoted, ...urls]
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
export function locateSpot({ sel, href, linkText, needles: ns, cores = [], notInLinks = false, notInChrome = false }) {
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
  const precise = sel && /#|elementor-element-[0-9a-f]{6,}|\[/.test(sel)
  let el = null
  let how = null
  if (href && href !== '#') {
    el = pick(byText([...document.querySelectorAll('a[href]')].filter(a => a.getAttribute('href') === href)))
    if (el) how = 'href'
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
        if (!vis(img)) return { hidden: 'the image is on the page but hidden at this width' }
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
    if (any && !vis(any)) return { hidden: 'the element is on the page but not visible at this width' }
    return null
  }
  // Inside a long block, outline the words themselves.
  let target = el
  if (norm(el.textContent).length > 80) {
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
  target.scrollIntoView({ block: 'center', inline: 'nearest' })
  const r = target.getBoundingClientRect()
  target.setAttribute('data-qc-ev', target.getAttribute('style') || '')
  target.style.outline = '3px solid #e0245e'
  target.style.outlineOffset = '3px'
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height, how, docW: document.documentElement.scrollWidth }
}

function clearSpot() {
  const el = document.querySelector('[data-qc-ev]')
  if (el) {
    const prev = el.getAttribute('data-qc-ev')
    if (prev) el.setAttribute('style', prev)
    else el.removeAttribute('style')
    el.removeAttribute('data-qc-ev')
  }
  const mark = document.querySelector('[data-qc-mark]')
  if (mark) mark.replaceWith(...mark.childNodes)
}

async function crop(page, box, width, path) {
  const w = Math.min(width, Math.max(MIN_W, Math.ceil(box.w + PAD * 2)))
  const x = Math.max(0, Math.min(Math.floor(box.x + box.w / 2 - w / 2), Math.max(0, box.docW - w)))
  const h = Math.min(MAX_H, Math.max(MIN_H, Math.ceil(box.h + PAD * 2)))
  const y = Math.max(0, Math.floor(box.y + box.h / 2 - h / 2))
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'webp', quality: 70, captureBeyondViewport: true, clip: { x, y, width: Math.max(1, w), height: Math.max(1, h), scale: 1 },
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
  const todo = []
  const summary = { defects: byIdentity.size, captured: 0, already: 0, browserShots: 0, invisible: 0, notFound: [] }
  for (const [identity, f] of byIdentity) {
    // A crop the browser pass took stays; one of ours is redone with --force.
    const ours = f.shot && f.shot.includes(`${join(snapshotDir(host), 'evidence')}`)
    if (f.shot && !ours) { summary.browserShots++; continue }
    if (ours && force) { delete f.shot; delete f.shotWidth; delete f.shotDataUri }
    if (index[identity]?.status === 'ok' && existsSync(index[identity].path)) { summary.already++; continue }
    if (INVISIBLE.test(String(f.selector || '')) || f.zone === 'head' || f.rule === 'X1' || /screen-reader|screen-only|skip-link/.test(String(f.selector || ''))) {
      index[identity] = { status: 'invisible', page: f.page }
      summary.invisible++
      continue
    }
    todo.push({ identity, f, width: f.breakpoint || EVIDENCE_WIDTH })
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
        for (const { identity, f } of items) {
          const sel = f.selector && !GENERIC.test(f.selector) ? f.selector : null
          const args = {
            sel, href: f.locate?.href || null, linkText: f.locate?.text || null, needles: needles(f), cores: cores(f),
            notInLinks: f.rule === 'E13', notInChrome: f.zone === 'main' || f.selector === 'main',
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
            index[identity] = { status: 'ok', path, page: f.page, width: w, how: box.how }
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
