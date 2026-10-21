// A big block with nothing in it: 200px+ tall, half the screen wide or more,
// no text, no image, video, frame, form field or background picture inside.
// A heuristic: a coloured band can be the design, so it is a hint for the
// visual review of the piece it is on (y).
export const meta = {
  id: 'B3',
  title: 'Empty block',
  severity: 'minor',
  confidence: 'heuristic',
}

export function check(ctx) {
  const vw = document.documentElement.clientWidth
  const MEDIA = 'img, svg, video, iframe, canvas, picture, input, select, textarea, object, embed'
  const empty = (el) => {
    if (el.innerText && el.innerText.trim()) return false
    if (el.querySelector(MEDIA)) return false
    for (const e of [el, ...el.querySelectorAll('*')]) if (getComputedStyle(e).backgroundImage !== 'none') return false
    return true
  }
  const out = []
  const all = document.querySelectorAll('body *')
  for (let i = 0; i < all.length && out.length < 10; i++) {
    const el = all[i]
    const r = el.getBoundingClientRect()
    if (r.height < 200 || r.width < vw / 2 || !ctx.helpers.visible(el)) continue
    if (['fixed', 'absolute'].includes(getComputedStyle(el).position) || el.closest('[aria-hidden="true"], [hidden]')) continue
    if (!empty(el)) continue
    // the outermost empty block only
    const p = el.parentElement
    if (p && p !== document.body && p.getBoundingClientRect().height >= 200 && empty(p)) continue
    out.push({
      rule: 'B3', title: 'Empty block', severity: 'minor', confidence: 'heuristic',
      engine: 'browser', page: ctx.url, breakpoint: ctx.breakpoint, selector: ctx.helpers.selector(el),
      containerId: ctx.helpers.containerId(el), y: Math.round(r.top + window.scrollY),
      found: 'a ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px block with no text, image or background picture',
      expected: 'content in the block, or no block',
    })
  }
  return out
}
