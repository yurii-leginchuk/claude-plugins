export const meta = {
  id: 'X2',
  title: 'Картинка не загрузилась',
  severity: 'major',
  confidence: 'high',
}

// Runs inside the page. Self-contained by contract.
export function check(ctx) {
  const out = []
  const imgs = document.querySelectorAll('img')
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i]
    if (!ctx.helpers.visible(img)) continue
    const src = img.currentSrc || img.getAttribute('src') || ''
    const loadingAttr = (img.getAttribute('loading') || '').toLowerCase()
    const swapTarget = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-original') || img.getAttribute('data-srcset')
    // A data:-URI image with loading=lazy is a defect only when the markup
    // also shows evidence a real image was meant to replace it (a lazy-load
    // swap-target attribute) and never did. Some themes legitimately inline
    // a tiny transparent GIF/SVG as a permanent spacer with no swap ever
    // intended -- that must not be flagged just because it happens to carry
    // a loading attribute.
    const placeholder = loadingAttr === 'lazy' &&
      /^data:image\/(gif|svg\+xml);/.test(src) && !!swapTarget
    const broken = img.complete && img.naturalWidth === 0
    if (!broken && !placeholder) continue
    out.push({
      rule: 'X2', title: 'Картинка не загрузилась', severity: 'major', confidence: 'high',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
      selector: ctx.helpers.selector(img),
      found: broken
        ? 'не загрузилась: ' + src.slice(0, 120)
        : 'осталась data:-заглушкой (ожидался ' + swapTarget.slice(0, 60) + '): ' + src.slice(0, 60),
      expected: 'изображение загружено',
    })
  }
  return out
}
