// A "region" is an Elementor container proved to appear on enough of the
// site's pages to be part of the template rather than a one-off. Header and
// footer containers are shared everywhere in an Elementor theme; content
// containers are per-page. This is measured from the snapshot, never
// assumed from naming.
//
// Measured basis: on a real 31-page client site, elementor-3374 (header) and
// elementor-3381 (footer) appeared on all 31 pages while every content
// container appeared once. A strict page-level template fingerprint found
// 27 distinct groups across those 31 pages -- almost nothing repeats at the
// page level -- but the header and footer containers repeated on literally
// every page, and that is exactly where the duplicated defects lived.
//
// Judgement call (threshold): "seen on more than one page" is the right bar
// for a handful of pages -- on a 2-page site that's the only bar available,
// and it's what distinguishes the fixtures below. But on a large site a
// container hit on 2 of 300 pages is almost certainly coincidence, not a
// template region. The threshold here scales with site size: a container
// must appear on at least half the pages (rounded up), with an absolute
// floor of 2. On a tiny site that coincides with "more than one page" (2 of
// 2 pages, still both required); on the real 31-page site header/footer hit
// 100%, comfortably over the bar; on a 300-page site a container needs 150+
// pages, so 2-of-300 correctly does not qualify. A single-page snapshot can
// never produce a region, because no container can reach the floor of 2.
const MIN_PAGES_FOR_REGION = 2

function sharedThreshold(pageCount) {
  return Math.max(MIN_PAGES_FOR_REGION, Math.ceil(pageCount / 2))
}

// pages: the array of PageDoc-shaped snapshots (or anything close enough --
// see the defensive handling below). Returns Map<containerId, { name, pageCount }>.
export function proveRegions(pages) {
  const list = Array.isArray(pages) ? pages : []

  const counts = new Map()
  // Preferred: id -> location pulled from locationsById, which pairs a
  // container with its own location class (see src/parse/page.js). Falls
  // back to the single-location heuristic only when a page has exactly one
  // location class and no pairing was supplied -- see judgement call 1: a
  // page carrying both header and footer must not fall back to bare ids for
  // either just because it has two location classes, not one.
  const names = new Map()
  const fallbackNames = new Map()

  for (const p of list) {
    const e = (p && typeof p === 'object' && p.elementor) || {}
    const containerIds = Array.isArray(e.containerIds) ? e.containerIds : []
    const locations = Array.isArray(e.locations) ? e.locations : []
    const locationsById = (e.locationsById && typeof e.locationsById === 'object') ? e.locationsById : {}

    for (const rawId of containerIds) {
      if (typeof rawId !== 'string' && typeof rawId !== 'number') continue
      const id = String(rawId)
      counts.set(id, (counts.get(id) || 0) + 1)

      if (!names.has(id) && locationsById[id]) names.set(id, locationsById[id])
      if (!fallbackNames.has(id) && locations.length === 1) fallbackNames.set(id, locations[0])
    }
  }

  const need = sharedThreshold(list.length)
  const out = new Map()
  for (const [id, pageCount] of counts) {
    if (pageCount < need) continue
    out.set(id, { name: names.get(id) || fallbackNames.get(id) || id, pageCount })
  }
  return out
}

// Judgement call 3 (how a finding gets its region): proveRegions proves
// which *container ids* are shared, but a browser finding carries a CSS
// selector (from selectorOf() in src/parse/page.js), not a container id --
// there is no DOM here to walk from one to the other. This module is pure
// functions over snapshot data (no playwright dependency, per the browser
// pass's budget), so discovering which container an element lives inside
// requires a live DOM walk that only the browser run loop can do.
//
// The interface this defines for that run loop (Task 7): for each finding,
// before calling regionOf, walk up from the found element to the nearest
// ancestor carrying an `elementor-<id>` class and attach that id as
// `finding.containerId`. regionOf then does only the lookup -- is this
// already-identified container one proveRegions proved shared -- and
// returns its name, or undefined if the finding should stay page-scoped
// (no containerId, or a containerId that was never proved shared). Setting
// `finding.region = regionOf(finding, regions)` is what defectIdentity()
// then keys on. The DOM walk itself remains Task 7's responsibility.
export function regionOf(finding, regions) {
  if (!finding || typeof finding !== 'object') return undefined
  if (!regions || typeof regions.get !== 'function') return undefined
  const id = finding.containerId
  if (id == null) return undefined
  const region = regions.get(String(id))
  return region ? region.name : undefined
}
