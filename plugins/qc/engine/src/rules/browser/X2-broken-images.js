export const meta = {
  id: 'X2',
  title: 'Картинка не загрузилась',
  severity: 'major',
  confidence: 'high',
}

// Runs inside the page. Self-contained by contract -- everything the
// function needs (including the small swap-attribute allow-list below) must
// live inside check(), since only check.toString() gets serialised into the
// page; a module-scope constant referenced from inside would throw
// "not defined" the moment the bundle actually runs.
export function check(ctx) {
  // A handful of well-known lazy-load swap attributes don't fit the
  // data-*src/data-*srcset shape (the pattern check below), so they need an
  // explicit name here instead of a broader pattern. Keep this list small
  // and deliberate: widening the pattern itself (e.g. matching any data-*
  // at all) would start flagging ordinary framework/analytics attributes
  // like data-testid or data-gtm on decorative data: images.
  // - data-original: the jQuery Lazy Load plugin's convention, still common
  //   on older WordPress sites this tool audits.
  const KNOWN_SWAP_ATTR_NAMES = ['data-original']

  const out = []
  const imgs = document.querySelectorAll('img')
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i]
    if (!ctx.helpers.visible(img)) continue
    const src = img.currentSrc || img.getAttribute('src') || ''
    const isDataPixel = /^data:image\/(gif|svg\+xml);/.test(src)

    // A data:-URI image is a suspected unresolved placeholder when it shows
    // ANY sign of being lazy-managed -- a data-*src/data-*srcset style
    // attribute (a pattern, not an enumerated list: it covers data-src,
    // data-lazy-src, data-srcset and every other same-shaped convention a
    // lazy-load library might use) or one of the few known conventions that
    // don't fit that shape (KNOWN_SWAP_ATTR_NAMES), a class naming it as
    // lazy, or a native loading attribute. A data: pixel with NONE of these
    // signals is a deliberate permanent spacer, not a defect -- that's what
    // keeps a theme's legitimate inline transparent GIF from being flagged.
    let swapAttr = null
    const attrs = img.attributes
    for (let j = 0; j < attrs.length; j++) {
      const name = attrs[j].name.toLowerCase()
      if (!attrs[j].value) continue
      if (/^data-.*(src|srcset)$/i.test(name) || KNOWN_SWAP_ATTR_NAMES.includes(name)) {
        swapAttr = attrs[j]
        break
      }
    }
    const hasLazyClass = /lazy/i.test(img.getAttribute('class') || '')
    const hasLoadingAttr = (img.getAttribute('loading') || '').toLowerCase() === 'lazy'
    const placeholder = isDataPixel && (!!swapAttr || hasLazyClass || hasLoadingAttr)

    const broken = img.complete && img.naturalWidth === 0
    if (!broken && !placeholder) continue

    let reason
    if (swapAttr) reason = 'ожидался ' + swapAttr.value.slice(0, 60)
    else if (hasLazyClass) reason = 'класс "' + (img.getAttribute('class') || '').slice(0, 40) + '" указывает на ленивую загрузку'
    else reason = 'есть атрибут loading="lazy", но реальный источник не подгрузился'

    out.push({
      rule: 'X2', title: 'Картинка не загрузилась', severity: 'major', confidence: 'high',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint,
      selector: ctx.helpers.selector(img),
      found: broken
        ? 'не загрузилась: ' + src.slice(0, 120)
        : 'осталась data:-заглушкой (' + reason + '): ' + src.slice(0, 60),
      expected: 'изображение загружено',
    })
  }
  return out
}
