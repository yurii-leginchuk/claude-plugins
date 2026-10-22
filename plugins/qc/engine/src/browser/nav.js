// `qc nav`: the navigation, every dropdown at every level, at every width.
// For each width it opens what a visitor opens -- each top item by hover and
// by keyboard focus, each nested item, the burger and every submenu inside it
// -- saves a picture of every state and measures what a script can be sure
// of: the dropdown did not open, it runs past the screen edge, a label is
// cut, the burger panel is wider than the screen or its last items cannot be
// reached. The pictures go to the agent, who judges how it looks.
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { launchBrowser, preparePage } from './launch.js'

export const NAV_WIDTHS = [360, 390, 768, 1024, 1280, 1440, 1920]

export function navDir(host) {
  return join(homedir(), '.qc-cache', host, 'nav')
}

// In the page: tag every trigger with data-qcnav and say what it controls.
function tagTriggers() {
  const header = [...document.querySelectorAll('header, [data-elementor-type="header"], .elementor-location-header')].find(h => h.getBoundingClientRect().height > 0) || document.body
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  const label = (el) => (el.querySelector(':scope .e-n-menu-title-text, :scope > a, :scope > div > a')?.textContent || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const burgers = [...header.querySelectorAll('.elementor-menu-toggle, .e-n-menu-toggle, button[aria-controls][aria-expanded], .menu-toggle, .hamburger, [class*="burger"], button[aria-label*="menu" i]')].filter(visible)
  // nested items are hidden until their parent opens: keep those whose top item is visible
  const top = (el) => { let t = el; for (let p = el.parentElement; p && p !== header; p = p.parentElement) if (p.matches('li:has(> ul), .e-n-menu-item')) t = p; return t }
  const items = [...header.querySelectorAll('li:has(> ul), .e-n-menu-item:has(.e-n-menu-content)')].filter(el => visible(top(el)))
  // levels: an item inside another item's submenu is one level deeper
  const level = (el) => { let n = 1; for (let p = el.parentElement; p && p !== header; p = p.parentElement) if (p.matches('li:has(> ul), .e-n-menu-item')) n++; return n }
  let i = 0
  const out = { burgers: [], items: [] }
  for (const b of burgers) { b.dataset.qcnav = `b${i++}`; out.burgers.push({ key: b.dataset.qcnav, label: (b.getAttribute('aria-label') || b.textContent || 'menu').trim().slice(0, 40), controls: b.getAttribute('aria-controls') || null }) }
  for (const it of items) { it.dataset.qcnav = `i${i++}`; out.items.push({ key: it.dataset.qcnav, label: label(it), level: level(it) }) }
  return out
}

// In the page: the submenu of a tagged item, and what is wrong with it once open.
function measure(key) {
  const it = document.querySelector(`[data-qcnav="${key}"]`)
  if (!it) return null
  const ctl = it.querySelector('[aria-controls]')?.getAttribute('aria-controls')
  const sub = it.querySelector(':scope > ul, :scope > .sub-menu, :scope .e-n-menu-content > *, :scope > [role="menu"]') || (ctl && document.getElementById(ctl))
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight
  const b = sub ? (() => { const cs = getComputedStyle(sub); const r = sub.getBoundingClientRect(); return { shown: r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) } })() : null
  const problems = []
  if (b?.shown) {
    if (b.right > vw + 1) problems.push(`runs ${b.right - vw}px past the right edge of the screen`)
    if (b.x < -1) problems.push(`runs ${-b.x}px past the left edge of the screen`)
    const fixed = (() => { for (let p = sub; p; p = p.parentElement) if (['fixed', 'sticky'].includes(getComputedStyle(p).position)) return true; return false })()
    if (fixed && b.bottom > vh + 1 && sub.scrollHeight <= sub.clientHeight + 1) problems.push(`its bottom ${b.bottom - vh}px is below the screen and it does not scroll`)
    const cut = [...sub.querySelectorAll('a, span')].filter(a => a.children.length === 0 && a.scrollWidth > a.clientWidth + 1 && getComputedStyle(a).overflow !== 'visible').map(a => a.textContent.trim()).filter(Boolean)
    if (cut.length) problems.push(`label cut: ${cut.slice(0, 3).map(t => `«${t}»`).join(', ')}`)
  }
  // the item itself: a copy of the menu kept for another width is never visible
  const ir = (it.querySelector(':scope > a, :scope .e-n-menu-title') || it).getBoundingClientRect()
  return { box: b, problems, itemShown: ir.width > 1 && ir.height > 1 && getComputedStyle(it).visibility !== 'hidden' }
}

// In the page: the burger's panel once open.
function measurePanel(key) {
  const b = document.querySelector(`[data-qcnav="${key}"]`)
  const ctl = b?.getAttribute('aria-controls')
  // the burger's own panel: its aria-controls target, else the menu in its widget; the open one wins
  const all = [ctl && document.getElementById(ctl), ...(b?.closest('.elementor-widget, header')?.querySelectorAll('nav.elementor-nav-menu--dropdown, .e-n-menu-wrapper, [role="dialog"], nav') || [])].filter(Boolean)
  const open = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 }
  const panel = all.find(open) || all[0]
  if (!panel) return { box: null, problems: ['no menu panel found for the burger'] }
  const cs = getComputedStyle(panel)
  const r = panel.getBoundingClientRect()
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight
  const box = { shown: r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }
  const problems = []
  if (!box.shown) problems.push('the burger does not open a menu')
  else {
    if (box.right > vw + 1 || box.x < -1) problems.push(`the open menu is wider than the screen (${box.x}…${box.right} of ${vw}px)`)
    const links = [...panel.querySelectorAll('a')].filter(a => a.getBoundingClientRect().height > 0)
    const last = links[links.length - 1]?.getBoundingClientRect()
    const scrolls = (el) => { for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) return true } return false }
    const bodyScrolls = getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden'
    if (last && last.bottom > vh + 1 && !scrolls(panel) && !(bodyScrolls && !['fixed'].includes(getComputedStyle(panel).position))) problems.push(`its last item is ${Math.round(last.bottom - vh)}px below the screen and the menu does not scroll`)
  }
  return { box, problems }
}

// In the page: the visible things inside the open burger menu that open a
// submenu, one per menu item, tagged data-qcnavt. `skip` are labels already
// tried, so a level lists only what the last tap revealed.
function burgerTriggers({ key, skip }) {
  const b = document.querySelector(`[data-qcnav="${key}"]`)
  const ctl = b?.getAttribute('aria-controls')
  const all = [ctl && document.getElementById(ctl), ...(b?.closest('.elementor-widget, header')?.querySelectorAll('nav.elementor-nav-menu--dropdown, .e-n-menu-wrapper, [role="dialog"], nav') || [])].filter(Boolean)
  const panel = all.find(el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 }) || document.body
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
  const done = new Set(skip)
  const out = []
  const seen = new Set()
  for (const el of panel.querySelectorAll('a.has-submenu, li:has(> ul) > a, .sub-arrow, .e-n-menu-dropdown-icon, [aria-haspopup="true"], [aria-expanded]')) {
    const li = el.closest('li, .e-n-menu-item') || el
    if (seen.has(li) || !vis(el) || el === b) continue
    // the arrow when it is big enough to tap, else the item's own link
    const arrow = li.querySelector('.sub-arrow, .e-n-menu-dropdown-icon')
    const r = arrow?.getBoundingClientRect()
    const target = arrow && r.width >= 10 && r.height >= 10 ? arrow : (li.querySelector(':scope > a, :scope .e-n-menu-title') || el)
    const label = (li.querySelector('.e-n-menu-title-text, a')?.textContent || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!label || done.has(label)) continue
    seen.add(li)
    target.dataset.qcnavt = `t${out.length}`
    out.push({ key: target.dataset.qcnavt, label })
  }
  return out
}

// In the page: the link texts a visitor sees now, to tell that a tap opened something.
function seenLinks() {
  const vw = document.documentElement.clientWidth
  return [...document.querySelectorAll('a')].filter(a => { const r = a.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.top < innerHeight && r.bottom > 0 && getComputedStyle(a).visibility !== 'hidden' })
    .map(a => ({ t: a.textContent.replace(/\s+/g, ' ').trim(), off: Math.round(a.getBoundingClientRect().right - vw) })).filter(x => x.t)
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x'

async function shot(page, file, box) {
  const vw = page.viewportSize()
  const clip = box?.shown
    ? { x: 0, y: 0, width: vw.width, height: Math.min(Math.max(box.bottom + 24, 200), vw.height) }
    : undefined
  await page.screenshot({ path: file, clip, animations: 'disabled' }).catch(() => page.screenshot({ path: file }))
  return file
}

async function reset(page) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.mouse.move(2, (page.viewportSize()?.height || 900) - 2)
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.waitForTimeout(250)
}

export async function navSweep(host, { pages, widths = NAV_WIDTHS, launchBrowserImpl = launchBrowser, onProgress = null } = {}) {
  const dir = navDir(host)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const { browser, newPage } = await launchBrowserImpl()
  const rows = []
  try {
    for (const url of pages) {
      for (const width of widths) {
        const page = await newPage()
        try {
          await preparePage(page, { width, url })
          await page.evaluate(() => window.scrollTo(0, 0))
          // a click or Enter on a menu link must not leave the page
          let ownNav = false
          await page.route('**/*', route => (!ownNav && route.request().isNavigationRequest() && route.request().frame() === page.mainFrame() ? route.abort() : route.fallback()))
          const tags = await page.evaluate(tagTriggers)
          const base = `${slug(new URL(url).pathname)}-${width}`
          const burger = tags.burgers.find(Boolean)
          const desktop = tags.items.filter(it => it.level === 1)
          if (burger && !(await page.locator(`[data-qcnav="${desktop[0]?.key}"]`).isVisible().catch(() => false))) {
            // phone and tablet: the burger, then every submenu toggle inside it
            await page.click(`[data-qcnav="${burger.key}"]`)
            await page.waitForTimeout(500)
            const panel = await page.evaluate(measurePanel, burger.key)
            rows.push({ page: url, width, mode: 'burger', item: burger.label, level: 0, opened: Boolean(panel.box?.shown), problems: panel.problems, shot: await shot(page, join(dir, `${base}-burger.png`)) })
            // a drill-down menu replaces the list with the submenu, so every path starts from a fresh menu
            const open = async () => {
              ownNav = true
              await page.goto(url, { waitUntil: 'load' }).catch(() => {})
              ownNav = false
              await page.waitForTimeout(700)
              await page.evaluate(tagTriggers)
              await page.click(`[data-qcnav="${burger.key}"]`).catch(() => {})
              await page.waitForTimeout(500)
            }
            const tried = new Set()
            const queue = (await page.evaluate(burgerTriggers, { key: burger.key, skip: [] })).map(t => [t.label])
            queue.forEach(([l]) => tried.add(l))
            while (queue.length) {
              const path = queue.shift()
              await open()
              let before = []
              let after = []
              for (const label of path) {
                const t = (await page.evaluate(burgerTriggers, { key: burger.key, skip: [] })).find(x => x.label === label)
                before = await page.evaluate(seenLinks)
                if (!t) { after = before; break }
                const loc = page.locator(`[data-qcnavt="${t.key}"]`)
                await loc.click({ timeout: 3000 }).catch(() => loc.click({ timeout: 2000, force: true }).catch(() => {}))
                await page.waitForTimeout(450)
                after = await page.evaluate(seenLinks)
              }
              const was = new Set(before.map(x => x.t))
              const fresh = after.filter(x => !was.has(x.t))
              const opened = fresh.length > 0
              const problems = opened ? [] : ['tapping it does not open the submenu']
              const off = fresh.filter(x => x.off > 1)
              if (off.length) problems.push(`${off.length} items run past the right edge of the screen (${off.slice(0, 3).map(x => `«${x.t}»`).join(', ')})`)
              const panelNow = await page.evaluate(measurePanel, burger.key)
              for (const p of panelNow.problems) if (!panel.problems.includes(p)) problems.push(p)
              const name = path.join(' › ')
              rows.push({ page: url, width, mode: 'burger', item: name, level: path.length, opened, items: fresh.length, problems, shot: await shot(page, join(dir, `${base}-burger-${slug(name)}.png`)) })
              if (opened && path.length < 3) {
                for (const c of await page.evaluate(burgerTriggers, { key: burger.key, skip: [...tried] })) { tried.add(c.label); queue.push([...path, c.label]) }
              }
            }
            await open()
            await page.click(`[data-qcnav="${burger.key}"]`).catch(() => {})
            await page.waitForTimeout(400)
            const closed = await page.evaluate(measurePanel, burger.key)
            if (closed.box?.shown) rows.push({ page: url, width, mode: 'burger', item: `${burger.label} (close)`, level: 0, opened: true, problems: ['the burger does not close the menu'], shot: await shot(page, join(dir, `${base}-burger-close.png`)) })
          } else {
            // desktop: hover each item at every level, then the same by keyboard focus
            for (const it of tags.items) {
              await reset(page)
              // a nested item is reached through its parents
              const chain = await page.evaluate((key) => { const out = []; for (let p = document.querySelector(`[data-qcnav="${key}"]`); p; p = p.parentElement?.closest('[data-qcnav]')) out.unshift(p.dataset.qcnav); return out }, it.key)
              for (const k of chain) await page.hover(`[data-qcnav="${k}"] > a, [data-qcnav="${k}"] > .e-n-menu-title, [data-qcnav="${k}"] > div > a`, { timeout: 3000 }).catch(() => page.hover(`[data-qcnav="${k}"]`, { timeout: 3000 }).catch(() => {}))
              await page.waitForTimeout(450)
              const m = await page.evaluate(measure, it.key)
              if (it.level > 1 && !m?.itemShown) continue
              const name = chain.length > 1 ? `${'› '.repeat(chain.length - 1)}${it.label}` : it.label
              rows.push({ page: url, width, mode: 'hover', item: name, level: it.level, opened: Boolean(m?.box?.shown), problems: m?.box?.shown ? m.problems : ['does not open on hover'], shot: await shot(page, join(dir, `${base}-hover-${it.key}-${slug(it.label)}.png`), m?.box) })
              if (it.level === 1) {
                await reset(page)
                // focus on its link opens most dropdowns; else Enter on its own button (Elementor's dropdown icon)
                await page.focus(`[data-qcnav="${it.key}"] a`).catch(() => {})
                await page.waitForTimeout(300)
                if (!(await page.evaluate(measure, it.key))?.box?.shown) {
                  await page.focus(`[data-qcnav="${it.key}"] button, [data-qcnav="${it.key}"] [role="button"]`).catch(() => {})
                  await page.keyboard.press('Enter').catch(() => {})
                }
                await page.waitForTimeout(350)
                const k = await page.evaluate(measure, it.key)
                if (!k?.box?.shown) rows.push({ page: url, width, mode: 'keyboard', item: it.label, level: 1, opened: false, problems: ['does not open from the keyboard (focus, Enter)'], shot: null })
              }
            }
          }
        } catch (err) {
          rows.push({ page: url, width, mode: 'error', item: '', level: 0, opened: false, problems: [`could not check: ${String(err.message || err).split('\n')[0]}`], shot: null })
        } finally {
          await page.context().close().catch(() => {})
        }
        onProgress?.({ url, width })
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }
  const out = { host, at: Date.now(), widths, pages, rows }
  writeFileSync(join(dir, 'nav.json'), JSON.stringify(out, null, 2))
  return out
}
