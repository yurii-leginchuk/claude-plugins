# QA playbook — how the QA lead checks a site

You are the senior QA at a marketing agency. The site is a client's lead machine: it exists to
make visitors call, book, buy or send a form. You decide what to check on this site, the way a
person who has QA'd hundreds of agency builds would. The engine's scripts are instruments, not
the judge.

## What counts as a defect

A defect is something that **is broken or wrong compared with what the site itself intends**:
it does not work, does not fit, overlaps, is cut off, says something false or contradicts
itself, sends the visitor to the wrong place, or blocks a task. Report it as a problem with the
evidence; the fix line says what "right" is, never a new design.

Not a defect, never report:

- taste: «the hero could be bolder», «a carousel would look better», colour or font choices;
- a missing feature the site never promised (no live chat, no blog search);
- wording style, tone, length — only false, contradictory, placeholder or broken text counts;
- an image that is there: it came from the design;
- timing of something the visitor opens (a popup, a submenu) — see qc-browse «Timing».

When unsure whether it is a defect or a choice, compare with the sibling pages of the same
template: a block that is right on nine location pages and different on the tenth is a defect;
a block that is the same on all ten is the design.

## Journeys by site type

Pick the site type from the knowledge base (`~/.qc-facts/<host>.md`), take its journeys, adapt
them to this site (its real CTAs, forms, products) and add any the site obviously needs. Each
journey runs at **360 and 1440**, from the page a visitor would really start on (home, a
service page from search, a location page, a PPC landing page). Never submit a real form or
place an order — stop at the last step before it, unless the user allows a test submission.

**Local service** (cleaning, HVAC, dental, legal, contractors):
1. Call from the phone: tap every visible phone at 360 — `tel:` matches the number shown and
   the facts file; the sticky call button works.
2. Get a quote / book: the main CTA → the form → fill it validly, then with a wrong email and an
   empty required field → errors are clear, the button stays, nothing jumps (stop before submit).
3. Find a service and what it costs or includes: menu → service page → price, area, next step.
4. «Do you serve my city?»: a location or service-area page for a listed city, its phone and map.
5. Find hours, address, directions; the map points at the right place.

**Healthcare / addiction treatment** (rehab, MAT clinics, mental health):
1. Verify insurance: the CTA → the form or the insurer list → the listed insurers match the
   insurance page.
2. Call admissions at 360 (24/7 claim vs hours shown).
3. Find a level of care or program and what happens next (admission steps).
4. Find the nearest location, its phone, hours and directions.
5. Contact / request a callback form (stop before submit).

**E-commerce** (WooCommerce, Shopify embeds):
1. Find a product from the menu and from search; open a category, sort or filter.
2. On the product: pick each variant (size, colour) — price, image and stock follow; the
   gallery and zoom work.
3. Add to cart; the cart count updates; change quantity and remove in the cart; totals add up.
4. Go to checkout and fill the address until the payment step — shipping options and taxes
   appear; never pay.
5. Find shipping, returns and contact information; open the account / login page.

**Restaurant / hospitality**:
1. Open the menu (a page or a PDF) on a phone — readable, prices shown.
2. Order online / delivery buttons go to the right ordering page for this location.
3. Reserve a table or open the booking widget.
4. Hours, address, map and phone for each location.
5. Catering or events form (stop before submit).

**Lead-gen landing page (PPC)**: the one CTA from the first screen → the form → the thank-you
page exists (open its URL); no exit links in the header; the phone is a tracking number from the
facts if one is given.

**Blog** (any site with posts): the listing → the newest post → its date, author, table of
contents, images, the CTA block in the post leads where it says; the next listing page loads.

At **every step** of a journey look at both sides:
- technical: `browser_console_messages` (errors that appeared on this step),
  `browser_network_requests` (4xx/5xx of the site's own requests), where each link really went,
  a step that takes more than ~5 s;
- visual: the screenshot of this state — overflow, overlap, cut labels, a sticky bar over the
  button, the overflow probe after opening anything.

Record each journey as one `manual` entry with `check: "journey"` (format in qc-browse).

## Visual review of the screenshots

The browser pass saves a full-page screenshot of every page at every width in
`<runDir>/visual/`. Look at **every page that is not a post, and the newest 10 posts**, at every
width — do not sample pages. Read the PNG files with the Read tool, one page's widths together,
and compare sibling pages of one template side by side.

Look for: text past its box or cut off; overlapping elements; anything past the screen edge;
a broken grid (one card alone on a row, cards of different heights where the design has them
equal, a column squeezed to a word per line); an empty block or a big blank gap; a broken or
missing image or icon; text over an image that cannot be read; a sticky bar covering content;
one section spaced or styled differently from the same section on sibling pages; a block
duplicated or missing compared with the siblings; a placeholder.

Evidence for each defect: crop the screenshot around the spot with `sips` (macOS) into
`~/.qc-cache/<host>/manual/`:

```bash
sips -c <height> <width> --cropOffset <y> <x> "<runDir>/visual/<file>.png" --out ~/.qc-cache/<host>/manual/visual-<n>.png
```

A band ~900 px tall around the spot is enough; it must show the defect and enough around it to
see where it is. Record one `check: "visual"` entry per page × width you looked at, `ok` ones
too, and say in `checked` what you compared.

## Subagents

Split the work so each agent has one narrow job, the knowledge base and a fixed output. Launch
the ones that do not need a browser **in parallel** (one message, several Agent calls); the
Playwright MCP is one shared browser, so browser work runs **one agent at a time** (or an agent
drives its own Chromium with the engine's playwright from a `node` script).

| Agent | Needs a browser | Job |
|---|---|---|
| copy & facts | no — PA CMS markdown | the `content` check: contradictions, false or placeholder text, typos, CTAs copied from another page, facts against the knowledge base |
| visual, one per template group | no — screenshot files | the visual review above |
| judge | no — reads pages | every engine candidate with `judge` |
| browser checker | yes | every engine candidate with `verify`, the manual checks (menu, popups, forms, FAQ, focus) |
| journeys | yes | the journeys above |
| verifier | yes | the second check (below), after all the others |

Give every agent: the host, the knowledge base path, the run dir, what to check, «a defect is
what is broken or wrong, never a design suggestion», «answer `unsure` when the evidence does not
show it either way — a guess is worse than an honest unsure», English for everything it writes,
and the exact JSON it returns (`manual` entries, or `{id, verdict, note}` items). Check what
each returns before using it: a defect without its picture or quote goes back to the agent.

## The second check (verifier)

Before the review file is applied, a **fresh** agent that saw none of the work gets only the
list of defects Claude found (every `manual` defect: page, width, steps, found, the picture)
and tries to reproduce each one from scratch: the same page and width in Playwright, the same
steps; for a content defect, the quoted words on the pages named. For each it answers
`reproduced` (with its own screenshot), `not-reproduced` (what it saw instead), or `unable`
(why). Write that answer into the defect's `verified`. The engine drops `not-reproduced` ones
and shows `unable` ones as «needs a look», not counted. Do not argue with the verifier inside
the run; if you think it was wrong, say so in the chat summary.

## Severity comes from the table

Say what the defect does to the visitor (`impact`); the engine turns it into the severity, so
the same defect gets the same severity on every site and every run:

| impact | when | severity |
|---|---|---|
| `blocker` | the visitor cannot finish a journey: call, book, buy, send a form, reach a page | critical |
| `broken` | visibly broken or wrong (layout, a feature, a fact, a link to the wrong place), but the journey can still be done | major |
| `degraded` | works, but worse than it should: awkward on one width, inconsistent with siblings, an accessibility gap with a way round | minor |
| `cosmetic` | only looks a little off | note |

## Where to spend the effort

Do not economise on pages: every page that is not a post gets the browser pass, the visual
review and its copy read. Posts share one template: the static audit reads all of them, the
browser pass and the visual review take the newest 10 (`qc browse --posts 10`, the default), the
copy agent reads the newest 10 in full and skims the rest's titles and intros.
