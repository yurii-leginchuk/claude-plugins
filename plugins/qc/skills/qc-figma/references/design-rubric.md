# Design rubric — a page against its Figma frame and its copy doc

Severity here is the qc `impact` (the playbook's table sets the severity from it): what the
original /qc-page rubric called Critical is `broken` or `blocks`, Major is `wrong`, Minor is
`polish`, Note is `note`. Map each case below the same way.

## 1. Text vs the copy doc (word-for-word) — code H2 (typos H3)

Normalize BOTH sides before comparing:
- collapse whitespace; unify quotes/apostrophes (`’ ‘ “ ” → ' "`), dashes (`– — → -`), ellipsis
- strip nav/header/footer/cookie-banner text from the page side (everything before the first h1 and after the last content section)

Per copy block, find the best match on the page: exact → case-insensitive → fuzzy. Classify:

| Case | Severity |
|---|---|
| Block in doc, missing on page | Major; **Critical** if a whole section or a CTA |
| Block on page, not in doc | Minor (may be boilerplate) unless it contradicts the doc → Major |
| Altered wording, meaning changes | Major — show word-level diff (`<del>`/`<ins>`) |
| Punctuation/casing-only difference | Minor |
| Typo/spelling error on page side | Minor; Major if in H1 or a CTA |
| Doc H2 rendered as h3, skipped heading levels | Minor |
| Multiple h1 on page | Major |

FAQ: count doc questions vs page questions (exact count match expected). Then verbatim compare each Q and A. If the page has `FAQPage` JSON-LD, its Q/A text must also match the visible FAQ (mismatch = Major).

Do NOT flag: legitimate dynamic content (dates, review counts), whitespace-only differences, smart-quote rendering.

## 2. Sections vs Figma — code A1 (missing / extra), A2 (merged, split, reordered)

Compare three ordered lists: Figma section list (from overview screenshot / sections.json), page section list (h2 landmarks + full-page screenshot strip), copy-doc heading order. Align by matched headings/visual identity.

| Case | Severity |
|---|---|
| Section in Figma, missing on page | Critical |
| Sections reordered vs Figma | Major |
| Two Figma sections merged into one (or one split) | Major |
| Extra section on page not in Figma | Note (verify against copy doc — if in doc, it's fine) |

Write the 3-column alignment (Figma / page / copy doc) into the `ok` entry's `checked` as an HTML table.

## 3. Each section vs its Figma section — A2 layout, A4 image, A5 count, A3/A6 only as a sanity look

**NEGATIVE RULE (hard): Figma text is placeholder. NEVER flag text-content differences in this dimension — that is the copy doc's job (§1).**

Per section pair check:
- layout topology: column count, image left vs right, element order inside the block
- imagery: same photo/illustration or same subject? Wrong/stock-swapped image = Major
- buttons: count, shape, fill/outline style, brand color
- gross spacing anomalies: section visibly crammed or stretched vs the design
- font character: serif vs sans, weight class, dramatically different sizes (not px-perfect)
- background/brand colors and font character are only a sanity look here; exact colour, font-family, weight, size, line-height and letter-spacing values are §4 (`references/style-checks.md`) — don't duplicate one as a visual finding

Every visual finding MUST carry its pair of pictures (the Figma section and the page section) in `shots`. If a section couldn't be captured in Figma, mark it "not compared" — don't guess.

## 4. Fonts and colours by their values — A6 (type), A3 (colour)

`references/style-checks.md`: Figma node properties against `getComputedStyle`, at the Figma
frame width, with ΔE2000 for colours. One grouped finding (property, Figma value, page value)
is one defect with `count` and example selectors in `found`, so one wrong global style is one
defect, not forty. Its §6 «Report» is replaced by the qc review: grouped findings become
`manual` defects, the pair table and palette go into the `ok` entry's `checked`.
