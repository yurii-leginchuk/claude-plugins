---
name: qc-figma
description: Compare site pages with their Figma frames (and, when given, their copy docs) inside a qc run — sections and their order, layout of each section, images, counts of cards and items, text word-for-word against the copy doc, and fonts and colours of every element by their computed values against the Figma node properties — and add the defects to the qc review so the QC report and QC Reports carry them. Use when the user gives a Figma link with a qc run ("сравни с фигмой", "вот макет", "check against the design"), or `/qc-site` finds pages with a Figma column in the strategy sheet (`design.json` in the run).
argument-hint: <host> [<page-url> <figma-url> [<copy-doc-url>]]…
---

# /qc-figma — the site against its design

Brought over from the stand-alone `/qc-page` skill and fitted to qc: the same comparisons, but
the results go into the qc review (`manual`, `check: "design"`) instead of a report of their
own, and the technical checks (links, meta, alt, console, mobile overflow, GBP) are left to the
engine, which already makes them for every page.

Sources of truth:
- **Figma frame** — the layout: which sections, in what order, how each is laid out, which
  images, how many cards or items, and the type and colour values. **Text in Figma is
  placeholder: never flag a text difference against Figma.**
- **Copy doc** (Google Doc, optional) — the words. Without one, text is not compared and the
  summary says so.

Read `references/design-rubric.md` (what to compare, severity, what not to flag) and
`references/style-checks.md` (fonts and colours by values) before comparing. Reports and every
field you write are English.

## When it runs

- The user gives Figma links: pair each with its page (by the page named next to it, or ask —
  one question listing the pairs you guessed).
- `/qc-site` with a strategy sheet: `qc audit` writes `<runDir>/design.json` —
  `[{page, name, figma, copyDoc}]` for every row with a Figma link — and prints `design.pages`.
- Several pages share one template (all service pages from one frame): compare the frame with
  every page of the template that has one in the sheet, or with up to 3 of them if not, and
  write a template-wide defect once with every page in `pages`.

No Figma given and no `design.json` → this skill does not run; the report has no design check
and does not pretend to.

## 1. The Figma side

File key: `figma.com/(design|file|proto)/<KEY>/…`; node: `node-id=12-345` → `12:345`. Get the
frame and its sections in this order of preference:

1. **REST API** with `FIGMA_TOKEN` in the environment (never print it or write it anywhere):
   - the node tree: `curl -s -H "X-Figma-Token: $FIGMA_TOKEN" "https://api.figma.com/v1/files/<KEY>/nodes?ids=<NODE>"`
     → `figma/nodes-<width>.json`; without a node id, `…/files/<KEY>?depth=2` lists the frames:
     the desktop frame is the widest, the mobile frame the one ≤ 500 wide;
   - pictures: `…/v1/images/<KEY>?ids=<NODE>,<child1>,<child2>…&format=png&scale=1` returns a URL
     per node — the whole frame and each top-level child (the sections) — download each into
     `figma/`. A section picture straight from Figma beats a crop of a screenshot.
2. **Figma MCP** (`mcp__plugin_figma_figma__*`, after its `authenticate`): the frame's design
   context and a screenshot of the frame and of each section node.
3. **The user's Chrome** (claude-in-chrome, which holds their Figma session) — the old /qc-page
   way: open the link, wait 15–20 s for the canvas, screenshot the fit-to-screen view (the
   overview: the source of truth for section order); in a view-only file the hand tool is on, so
   zoom with the zoom field (type 50, Enter, Esc) and tile through the frame with scroll ticks,
   a screenshot per tile; copy the pictures from the temp dir into `figma/`. Read the margin
   notes next to the frame — section names and limits written there are authoritative.

A login wall or a blank canvas → ask the user once to log in; still nothing → sections and
layout are not compared, and the summary says so. Fonts and colours need node properties (1 or
2); from pictures alone they are **not checked** — never read a hex or a size off a raster.

Write `figma/sections.json`: the sections in order, each with its name and picture.

## 2. The page side (Playwright)

At **the Figma frame's width** (and the mobile frame's, if there is one) — not 1440: fluid type
and Elementor's responsive values differ by width, and only the frame width compares.

- Resize, open the page, scroll it through so lazy sections load, strip
  `.elementor-invisible` and animations, wait for fonts.
- A full-page screenshot, then **one screenshot per section** (the element screenshot of the
  section's container, aligned with `figma/sections.json` by heading and look).
- `scripts/extract_styles.js` via `browser_evaluate` → `page/styles-<width>.json`, then
  `python3 -I <this skill>/scripts/compare_styles.py figma/styles-<width>.json page/styles-<width>.json analysis/styles-<width>.json --label <width>`
  (Figma side made by `scripts/figma_styles.py` from the node tree, `references/style-checks.md` §1).
- The copy doc: `curl -sL "https://docs.google.com/document/d/<ID>/export?format=md"`; a login
  page back means it is private — try `format=txt`, then the user's Chrome, then ask for link
  sharing. Normalise it into ordered blocks (h1/h2/h3/p/cta/faq).

Work in `<runDir>/design/<page-slug>/` (`figma/ page/ analysis/`).

## 3. Compare and record

In this order, per page (`references/design-rubric.md`):
1. **Sections** — Figma list, page list, copy-doc headings aligned: missing or extra (A1),
   merged, split or reordered (A2).
2. **Each section pair** — layout (A2: columns, image side, order inside the block), image (A4),
   counts of cards, items, checkboxes, articles (A5), buttons, gross spacing; colour and type only
   as a sanity look here.
3. **Text** against the copy doc — missing, extra or changed blocks, FAQ count and wording (H2),
   typos (H3).
4. **Fonts and colours** by value (A6, A3) from `compare_styles.py`'s grouped findings.

Every defect is a `manual` entry's defect under `check: "design"`, one entry per page × width:

```json
{ "check": "design", "page": "https://site/services/x/", "width": 1440, "status": "defect",
  "checked": "Figma frame «Service — Desktop» (node 12:345) vs the page at 1440; 9 sections aligned",
  "shots": ["…/design/services-x/figma/s04-why-us.png", "…/design/services-x/page/s04-why-us.png"],
  "defects": [{ "rule": "A5", "impact": "wrong", "verified": "reproduced", "category": "dev",
    "figma": "https://www.figma.com/design/KEY/Site?node-id=12-401",
    "title": "«Why us» has 3 cards, the design has 4",
    "found": "3 cards in «Why us»: Licensed, Insured, Local", "expected": "4 cards as in Figma: add «24/7 response» (the copy doc has its text)",
    "target": {"text": "Why choose us"}, "design": 0, "shot": 1 }] }
```

- `shots` holds the pair — Figma first, the page second; `design` points at the Figma picture and
  `shot` at the page one, and the report shows them side by side («Figma design» / the site, with
  the spot outlined).
- `figma` on the defect: the link to its frame or section node
  (`https://www.figma.com/design/<KEY>/…?node-id=12-345`); the report shows «Open this frame in
  Figma» on the card. Put it on every design defect.
- `title` says the difference in a few words (««Why us» has 3 cards, the design has 4»).
- `impact` from the playbook's table, `verified` from the second check (`qa-playbook.md`),
  `category`: `dev` for layout, images, counts, fonts and colours; `copy` for text against the
  doc; `seo` only for meta the doc prescribes.
- What matched goes into one `ok` entry per page × width: the section alignment table, "N
  elements matched by fonts and colours", the sections that look as designed.
- Not flagged (the rubric's «Do NOT flag»): text against Figma, third-party widgets, header and
  footer when the frame has none, hover states, browser-default controls, anything at a width
  other than the frame's.

Then `qc review` as usual (`/qc-site` step 5): the design defects reach the report and QC Reports
with the rest. In the chat summary, per page: Figma frame, widths compared, sections matched,
defects by code, and what was not compared and why (no copy doc, no Figma API access, a login
wall).
