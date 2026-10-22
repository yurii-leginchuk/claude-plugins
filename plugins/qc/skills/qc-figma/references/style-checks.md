# Fonts and colours vs Figma, by properties

The section comparison looks at screenshots. This dimension compares **numbers**: the property values of every Figma text/fill node against `getComputedStyle` of every visible text-bearing and interactive element on the page. A finding here always carries both values (Figma → page) and, for colours, the ΔE2000 between them. Eyeballing does not count as a check: if the properties cannot be read from Figma, this part is **not checked**, and the summary says so.

## 1. Figma properties (source of truth)

Get them in this order:

1. **REST API** (needs `FIGMA_TOKEN` in the environment — a personal access token with file read scope; never print it or write it to the run dir):
   - file key: `figma.com/(design|file|proto)/<KEY>/…`; node id: `node-id=12-345` → `12:345`.
   - `curl -s -H "X-Figma-Token: $FIGMA_TOKEN" "https://api.figma.com/v1/files/<KEY>/nodes?ids=<NODE>" -o figma/nodes-desktop.json`
   - URL without node-id, or you also need the mobile frame: `curl … "https://api.figma.com/v1/files/<KEY>?depth=2"` lists the top-level frames per page; pick the desktop frame (the one the link opens / widest) and the mobile frame (width ≤ 500) by name and width.
   - `python3 -I <this skill>/scripts/figma_styles.py figma/nodes-desktop.json <NODE> figma/styles-desktop.json` (same for mobile).
2. **Figma MCP** (`mcp__plugin_figma_figma__*`, needs its own auth): `get_design_context` / `get_variable_defs` for the frame node. Transcribe the values into `figma/styles-desktop.json` by hand in the same schema `figma_styles.py` produces (`frame`, `texts[].runs[]` with fontFamily/fontWeight/fontSize/lineHeightPx/letterSpacing/textCase/italic/color, `fills[]`, `palette[]`, `typeScale[]`). Mark `"source": "figma-mcp"`.
3. Neither available → ask the user once for a token (or to authenticate the Figma plugin). Declined → fonts and colours are **not checked**; say why in the summary.

Never derive font sizes or hex values from screenshots — anti-aliasing and JPEG shift colours by several ΔE, and a size read off a raster is a guess.

## 2. Page properties

Capture at the **Figma frame width**, not a fixed 1440: fluid type (`clamp()`, vw, Elementor responsive values) gives different px at different widths, and only the frame width is comparable.

1. Playwright `browser_resize` to `frame.width` × 900 (desktop frame); reload; slow-scroll the whole page (300 px steps, ~300 ms) so lazy sections render; wait 3 s; strip `.elementor-invisible` and animations (`*{animation:none!important;transition:none!important}`) so nothing is captured mid-fade.
2. Run `scripts/extract_styles.js` via `browser_evaluate` (pass the file's function) → `page/styles-desktop.json`.
3. Mobile frame exists → resize to its width, same prep, → `page/styles-mobile.json`.

## 3. Compare

```
python3 -I <this skill>/scripts/compare_styles.py figma/styles-desktop.json page/styles-desktop.json analysis/styles-desktop.json --label desktop
python3 -I <this skill>/scripts/compare_styles.py figma/styles-mobile.json  page/styles-mobile.json  analysis/styles-mobile.json  --label mobile
```

The script does three passes:

- **Pairs** — a page element is paired with a Figma text node when the texts match (exact for short strings, ≥ 0.88 similarity or containment for long ones; ties broken by relative vertical position). Each property of the pair is compared directly.
- **Tokens** — every page element that has no pair is checked against the design system: its font family, its family+weight combination and its size must exist in the Figma type scale, and its text colour must be in the Figma palette.
- **Font loading** — every family+weight used on the page must be served by a loaded `@font-face` (`document.fonts`). A family set in CSS but not loaded renders in the fallback; a weight not loaded is synthesised by the browser (faux bold) — both look "close" in a screenshot and are wrong.

Findings are grouped by (property, Figma value, page value), with a count and up to six example selectors, so one wrong global style is one finding, not forty.

## 4. Thresholds and severity

| Property | Pass | Minor | Major |
|---|---|---|---|
| font-family (pair or not in design) | same family (case/space/hyphen-insensitive) | — | different family |
| Font not served / not loaded / weight synthesised | — | — | always |
| font-weight | equal | ±100 | ≥ 200 off, or weight absent from the design |
| font-size | ≤ 1 px | ≤ 3 px and ≤ 10 % | larger; on h1/h2/buttons anything > 2 px |
| line-height | ≤ 2 px (`normal` taken as 1.2 × size) | ≤ max(6 px, 25 %) | larger |
| letter-spacing | ≤ 0.3 px | larger | — |
| text-case (UPPER/lower/Title) | same rendered case | differs | — |
| font-style (italic) | same | differs | — |
| text colour (pair) | ΔE2000 ≤ 2.3 | ≤ 5 | > 5 |
| text colour off palette (no pair) | nearest palette ΔE ≤ 2.3 | ≤ 5 | > 5 |
| button background | ΔE ≤ 2.3 | ≤ 5 | > 5 |
| button border-radius | ≤ 2 px | larger | — |
| font-size off the type scale (no pair) | within 1 px of a design size | otherwise | — |

Colours are composited over the element's effective background before ΔE, so a Figma `#000 @ 70 %` and a page `rgba(0,0,0,.7)` compare as equal. ΔE 2.3 is the just-noticeable difference.

Escalate to **Critical** by hand only when a brand colour is replaced on the primary CTA, or the whole page renders in a fallback font.

## 5. Do NOT flag

- **Text content** — Figma text is placeholder; the copy doc owns text.
- Results captured at a viewport ≠ Figma frame width (`widthMismatch: true` in the output) — recapture instead.
- Colours where `bgUncertain` is true (text over an image or gradient) and the only difference is ΔE ≤ 5 — the effective background is a guess there.
- Gradient fills (`colorKind: gradient`) — reported as Note only.
- Third-party widgets (cookie banners, chat, maps, embedded forms in iframes, reCAPTCHA) — not in the design.
- Browser-default form controls the design does not draw (native select arrows, autofill colours).
- Header/footer elements when the Figma frame does not contain a header/footer — check the frame overview first; if absent, drop `region: header|footer` findings.
- Hover/focus colours — this pass reads the resting state only.

## 6. Into the qc review

- Each grouped finding is one `manual` defect under `check: "design"`: `rule` A6 (type) or A3
  (colour), `found` with the property, the Figma value (and its style name, e.g. `Brand/Blue`,
  `H1 Desktop`), the page value, ΔE, the count and example selectors; `expected` is the fix, as
  concrete as the rest of the report wants it ("set the Elementor global colour Primary to
  #1A66E6", "load Poppins 600 — only 400/700 are served"); `target` is one example element.
- The passes go into the page's `ok` design entry: "N elements matched, all fonts and colours
  within tolerance", the Figma palette and type scale next to what the page uses.
