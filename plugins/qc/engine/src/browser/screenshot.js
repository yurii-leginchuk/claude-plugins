// Crops a screenshot of the element that caused a defect, so a human reading
// the report can see it instead of reconstructing it from a selector string.
//
// Files live at ~/.qc-cache/<host>/shots/<sha1(identity)>.png, named by
// defectIdentity() (src/report/json.js) rather than by page or selector. A
// defect in a shared region (header/footer) renders on every page of the
// site; naming the crop by identity means a rerun of the same defect reuses
// the existing file instead of writing thirty near-identical PNGs, and an
// unchanged defect keeps its evidence across runs (existsSync short-circuits
// before touching the page at all).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { snapshotDir } from '../crawl/store.js'
import { defectIdentity } from '../report/json.js'

const PADDING = 24
const HIGHLIGHT_COLOR = '#e0245e'

export function shotPath(host, identity) {
  const name = createHash('sha1').update(String(identity)).digest('hex').slice(0, 16) + '.png'
  return join(snapshotDir(host), 'shots', name)
}

// Self-contained: passed straight to page.evaluate(), so it must not close
// over anything outside its own arguments -- including this module's own
// top-level consts, which are NOT visible inside the serialised function
// (page.evaluate() stringifies the function body and runs it in the page's
// own isolated context). HIGHLIGHT_COLOR is threaded through as an argument
// for exactly that reason. Re-implements the same elementor-<id> ancestor
// walk as helpers.containerId() (src/rules/browser/_helpers.js) -- it cannot
// import that module either, for the same reason.
function locateAndHighlight({ sel, wantContainerId, highlightColor }) {
  function containerIdOf(el) {
    let cur = el
    while (cur && cur.nodeType === 1) {
      const classes = cur.classList ? Array.prototype.slice.call(cur.classList) : []
      for (let i = 0; i < classes.length; i++) {
        const m = /^elementor-(\d+)$/.exec(classes[i])
        if (m) return m[1]
      }
      cur = cur.parentElement
    }
    return null
  }

  let candidates
  try {
    candidates = Array.prototype.slice.call(document.querySelectorAll(sel))
  } catch (e) {
    return { error: 'bad-selector' }
  }
  if (candidates.length === 0) return { error: 'not-found' }

  // The lossy-selector problem (see run.js's module comment and
  // src/browser/regions.js): helpers.selector() truncates class lists and
  // only climbs one ancestor level, so more than one element on the page can
  // legitimately produce the identical selector string. Re-querying with
  // that string and grabbing the first DOM match (what an earlier draft of
  // this file did) would silently crop the WRONG element whenever that
  // happens -- no error, no signal, just a misleading picture in the report.
  //
  // Findings already carry containerId (set by the rule itself while it
  // still held the real element -- Task 7). That narrows, but does not by
  // itself uniquely identify: two elements can share both a selector string
  // AND a container (e.g. two links in the same nav). So the rule here is
  // conservative rather than best-effort: a single selector match is used
  // directly; more than one is resolved only if containerId narrows it to
  // EXACTLY one candidate; any remaining ambiguity returns an error instead
  // of guessing. A crop that might be showing the wrong element is worse
  // than no crop at all.
  let el
  if (candidates.length === 1) {
    el = candidates[0]
  } else if (wantContainerId != null) {
    const matches = candidates.filter((c) => containerIdOf(c) === wantContainerId)
    if (matches.length !== 1) return { error: 'ambiguous' }
    el = matches[0]
  } else {
    return { error: 'ambiguous' }
  }

  const fixed = getComputedStyle(el).position === 'fixed'
  // Fixed-position elements are positioned relative to the viewport, not the
  // document -- scrolling never moves them, so scrollIntoView() would either
  // no-op or (worse) scroll the page for no benefit. Everything else may
  // live below the fold after preparePage() reset scroll to (0,0), so it is
  // brought into view before measuring.
  if (!fixed) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' })
  }

  const r = el.getBoundingClientRect()
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight

  // Entirely outside the viewport on any axis: a deliberately off-canvas
  // element (a menu parked at left:-9999px, a slide-in panel at left:100%)
  // or a fixed overlay that never intersects the current viewport at all.
  // Scrolling cannot help a fixed element, and scrollIntoView() already gave
  // a non-fixed one its best shot -- clip math on a fully non-intersecting
  // box would just produce a blank or nonsensical image, which is worse
  // than no image.
  if (r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh) {
    return { error: 'offscreen' }
  }
  if (r.width < 1 || r.height < 1) {
    return { error: 'zero-size' }
  }

  // Highlight via inline style, not a global stylesheet: outline is
  // layout-neutral (it never affects getBoundingClientRect or scrollWidth,
  // unlike border), and scoping the change to this one element's own style
  // attribute -- saved here, restored by clearHighlight() below -- means
  // there is no shared stylesheet rule that could linger and affect any
  // other element or any later measurement on this same page/width.
  //
  // Applied via setAttribute('style', ...) on a plain string, deliberately
  // NOT via the `el.style.outline = ...` CSSOM setters: writing through the
  // CSSOM here and then removing the attribute in a LATER, separate
  // page.evaluate() call (clearHighlight, after page.screenshot() has run)
  // reproducibly left a stray `style=""` behind instead of no attribute at
  // all -- confirmed in isolation, with no screenshot involved, so it is a
  // Playwright/CDP round-trip quirk in how a CSSOM mutation's attribute
  // serialisation is flushed across separate evaluate() calls, not a bug in
  // this file's own logic. Going through setAttribute() on both the apply
  // and the restore side (a plain string operation, no CSSOM object
  // involved) does not exhibit it.
  const prevStyle = el.getAttribute('style')
  if (prevStyle !== null) el.setAttribute('data-qc-orig-style', prevStyle)
  el.setAttribute('data-qc-highlight', '1')
  const highlightCss = 'outline:3px solid ' + highlightColor + ';outline-offset:2px;'
  el.setAttribute('style', (prevStyle ? prevStyle.replace(/;?\s*$/, ';') : '') + highlightCss)

  return {
    box: { x: r.left, y: r.top, w: r.width, h: r.height },
    viewport: { w: vw, h: vh },
  }
}

// Self-contained cleanup: undoes exactly what locateAndHighlight() did,
// looked up via the marker attribute rather than by re-resolving the
// selector (which would re-run into the same ambiguity this file exists to
// avoid). Safe to call even if the element was removed from the DOM in the
// meantime -- querySelectorAll then simply finds nothing to clean up.
function clearHighlight() {
  const els = document.querySelectorAll('[data-qc-highlight]')
  for (let i = 0; i < els.length; i++) {
    const el = els[i]
    el.removeAttribute('data-qc-highlight')
    if (el.hasAttribute('data-qc-orig-style')) {
      el.setAttribute('style', el.getAttribute('data-qc-orig-style'))
      el.removeAttribute('data-qc-orig-style')
    } else {
      el.removeAttribute('style')
    }
  }
}

// Crops the element named by finding.selector, with a highlight outline,
// and returns the saved file path -- or null when the element cannot be
// located, cannot be disambiguated, or cannot be meaningfully captured
// (zero-size, off-screen, removed from the DOM). A missing crop is never
// fatal to the caller: run.js simply leaves `shot` unset on that finding.
export async function captureDefect(page, finding, host) {
  if (!finding || typeof finding !== 'object') return null
  const sel = finding.selector
  if (!sel || typeof sel !== 'string' || sel === 'html' || sel === 'body') return null

  let out
  try {
    out = shotPath(host, defectIdentity(finding))
  } catch {
    return null
  }
  if (existsSync(out)) return out

  const wantContainerId = finding.containerId == null ? null : String(finding.containerId)

  let located
  try {
    located = await page.evaluate(locateAndHighlight, { sel, wantContainerId, highlightColor: HIGHLIGHT_COLOR })
  } catch {
    return null
  }
  if (!located || located.error) return null

  const { box, viewport } = located
  try {
    const x = Math.max(0, box.x - PADDING)
    const y = Math.max(0, box.y - PADDING)
    const right = Math.min(viewport.w, box.x + box.w + PADDING)
    const bottom = Math.min(viewport.h, box.y + box.h + PADDING)
    const clip = { x, y, width: right - x, height: bottom - y }
    if (clip.width < 1 || clip.height < 1) return null

    mkdirSync(join(snapshotDir(host), 'shots'), { recursive: true })
    await page.screenshot({ path: out, clip })
    return out
  } catch {
    return null
  } finally {
    // Always run, on every exit path (success, clip failure, screenshot
    // error): a crop attempt must never leave the highlight behind for a
    // later rule at this same width to measure against.
    await page.evaluate(clearHighlight).catch(() => {})
  }
}
