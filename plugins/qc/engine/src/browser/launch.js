import { chromium } from 'playwright'

export const PAGE_TIMEOUT_MS = 45_000

export async function launchBrowser({ headed = false } = {}) {
  const browser = await chromium.launch({ headless: !headed })
  const newPage = async () => {
    const context = await browser.newContext({ deviceScaleFactor: 1 })
    return context.newPage()
  }
  return { browser, newPage }
}

// Judgement call (X1): real sites load third-party scripts (analytics, chat
// widgets, ad blockers) whose console errors are not the client's defect.
// We do NOT drop them -- a swallowed finding is exactly the silent-failure
// mode the QC engine must avoid. Instead every collected line is tagged
// 'same-origin: ' or 'third-party: ' by comparing the offending resource's
// host against the page's own host; X1 (running in-page, with no access to
// this Node-side comparison) reads the tag back out and downgrades
// third-party noise to 'minor' while still reporting it in full.
function hostOf(candidate) {
  try {
    return new URL(candidate).host
  } catch {
    return null
  }
}

// Bring the page to a state where measuring is meaningful and repeatable.
export async function preparePage(page, { width, url, timeout = PAGE_TIMEOUT_MS }) {
  await page.setViewportSize({ width, height: 900 })

  const pageHost = hostOf(url)
  const originTag = (candidate) => {
    const h = hostOf(candidate)
    return h && pageHost && h !== pageHost ? 'third-party' : 'same-origin'
  }
  const push = (text) => {
    page.evaluate((t) => window.__qcConsole && window.__qcConsole.push(t), text).catch(() => {})
  }

  // X1 needs errors that happen during load, so the sink must exist first.
  await page.addInitScript(() => { window.__qcConsole = [] })
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const loc = msg.location() && msg.location().url
    push(`${originTag(loc)}: console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    // Error objects don't carry a URL directly; the offending script's URL
    // is the first http(s) reference in the stack trace.
    const m = /https?:\/\/[^\s)]+/.exec(String(err.stack || ''))
    push(`${originTag(m && m[0])}: error: ${err.message}`)
  })
  page.on('requestfailed', (req) => {
    push(`${originTag(req.url())}: failed: ${req.url()} — ${req.failure() && req.failure().errorText}`)
  })
  page.on('response', (res) => {
    if (res.status() < 400) return
    push(`${originTag(res.url())}: failed: HTTP ${res.status()} ${res.url()}`)
  })

  await page.goto(url, { waitUntil: 'load', timeout })
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 })
  } catch {
    // A page that never goes idle (polling, chat widget) is still measurable.
  }

  // Lazy images only load once they approach the viewport. Without this walk
  // X2 reports every lazy image on the site as broken.
  await page.evaluate(async () => {
    const step = 300
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise(r => setTimeout(r, 60))
    }
    window.scrollTo(0, 0)
    await new Promise(r => setTimeout(r, 250))
  })
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 })
  } catch { /* as above */ }

  // Measuring mid-animation makes C2 and B6 differ between identical runs.
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;
      scroll-behavior:auto!important}`,
  })
  await page.evaluate(() => document.fonts && document.fonts.ready)
}
