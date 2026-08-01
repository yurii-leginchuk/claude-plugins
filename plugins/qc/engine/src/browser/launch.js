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

// Bring the page to a state where measuring is meaningful and repeatable.
export async function preparePage(page, { width, url, timeout = PAGE_TIMEOUT_MS }) {
  await page.setViewportSize({ width, height: 900 })
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
