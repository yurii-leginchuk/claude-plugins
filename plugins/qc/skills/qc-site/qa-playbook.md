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
- a form that shows its errors only after Submit: Gravity Forms (and most WordPress form
  plugins) validates on the server, so no inline error on blur is the standard behaviour. A
  defect is an error that never shows after Submit, a wrong or missing error text, or the form
  losing what was typed — check it only where a test submission is allowed.

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

**One path per journey.** When the site offers two ways to do the same thing — a popup form
and a form page, a header button and a hero button that open different forms, a phone in the
header and one on a location page — each way is its own journey, named by its path («Request a
quote through the popup», «Request a quote on the quote-form page»). Never carry on into a second
form or a second entry point inside one journey: a defect must belong to exactly one form and
one path, so the developer knows where to fix it. Each journey still runs at 360 and 1440.

Record each journey as one `manual` entry with `check: "journey"` (format in qc-browse).

**Every form on the site gets checked.** The journeys cover the forms on the visitor's main
paths; the rest are easy to miss (a referral form, a form on one industry page, a white-paper
download). The crawl lists every form it found in `profile.json` → `forms` (Gravity Forms id,
pages, first fields). Each form with an id gets its own `check: "form"` at 360 and 1440 —
required fields and `*`, error texts, masks, the button after an error, never submitted — on
one page that carries it, and the entry names it: `"form": "gform_9"` (a journey that fills a
form names it the same way). The report counts «N of M forms checked by hand» and lists every
form nobody named under «Forms not checked by hand»; that list must be empty before you publish,
or say in the summary why a form was left (it needs a login, a payment step).

**Every popup, tab, accordion and slider gets opened.** The page screenshots show each one in
its first state; what it hides — the second tab, the other accordion items, the next slides, the
popup itself — nobody has seen. `profile.json` → `parts` lists each one once (`popup:18298`,
`accordion:8c0d489`, `slider:672f3e48`, with its pages). Open every part at 360 and 1440 on one page
that carries it: every tab, every item, every slide (arrows, dots and a swipe at 360), the popup
from its button — a screenshot of each state and the overflow probe after opening. Record it as
`check: "popup"` / `"faq"` (tabs and sliders go under `faq`) naming the part: `"part":
"accordion:8c0d489"`. The report lists every part nobody named under «Popups, tabs, accordions and
sliders not opened by hand»; that list must be empty before you publish.

**The service pages, once per site** (`check: "pages"`, at 360 and 1440):
- **404** — open `/qc-missing-<random>/`: it answers HTTP 404 (not 200, not a redirect to the
  home page), has the header and footer, says the page is gone and offers a way on (search, home,
  main links).
- **Search** — search a word the site uses (a service name): results come, are relevant, each
  links to a live page; then a nonsense word: a clear «nothing found» with a way on, not an empty
  page. Both at 360 and 1440, from the header search as a visitor opens it.
- **Listings** — the blog or news listing, page 2 and the last page (pagination works, no
  duplicate or missing posts, the page number is in the title), every category or tag archive the
  menu or posts link to, any filter on the listing.
- **Gated content** — content behind an email gate or a «read more»: fill the gate with a test
  address only where submitting is allowed (see «Test submissions»), else record what the
  visitor sees before the gate.

**The navigation, once per site, in depth.** Run `node <engine>/src/cli.js nav <host>` (add
`--pages <a page with another header>` when the site has more than one header). It opens every
dropdown at every level by hover and by keyboard focus, the burger and every submenu inside it
(drill-down menus included), at 360, 390, 768, 1024, 1280, 1440 and 1920, saves a screenshot of
every state to `~/.qc-cache/<host>/nav/` and measures what a script can be sure of: did not open,
past the screen edge, a cut label, the burger panel wider than the screen, last items unreachable.
Its problems are facts — record each as a `menu` defect. Then look at **every** screenshot as a
visitor, against the rest of the site: alignment and spacing of the dropdown and its columns,
the active and hover states, contrast of every item and of the back / close controls, the
dropdown covering something it should not, the logo and the header at that width, icons that
repeat (two searches, two closes), the gap between the header and the dropdown that drops the
hover on the way down. Then by hand at 360 and 1440: the header after scrolling (sticky, its
height, still opens), closing (X, a tap outside, Esc, back to the page where it was), the burger
on a long page, the current page marked in the menu. Every look is one `check: "menu"` entry per
width with the screenshots it used.

## Visual review of the screenshots

A whole-page screenshot is shrunk when read, and a 1–2 px defect (an icon touching its text, a
label one pixel past its pill) disappears. So the browser pass also cuts every page at every
width into **pieces** at full size: the first screen as the visitor sees it (fixed bars and
popups included), then the rest of the page cut at the tops of its sections with fixed elements
hidden, a section taller than 1000 px split with a 100 px overlap. Before cutting it scrolls the
page through (lazy images, entrance animations), waits for the images and stops carousels where
they are, so a piece shows the page, not the moment it was taken. Every row of the page
is in a piece. Pieces are named by their pixels: a footer, a testimonials block or a CTA band
that is the same on 150 pages is **one** piece with the list of its pages.

```bash
node <plugin-root>/engine/src/cli.js tiles "<host>"
```

lists the pieces to look at (`T1…Tn`): `shared` — pieces on several pages (`pages`: how many),
then by page type and page, with file, width, `top`–`bottom` and `kind` (`screen` or
`section`). `cached` pieces are left out: the same pixels were looked at on an earlier QC and
that look stands (its defects carry over by themselves). `hints` on a piece are the script's
measurements on it (B9 icon touching text, B5 text past its box, B3 empty block, C2 wider than
the screen, B6 overlap) with their `D` ids: look at that spot first and settle each hint with a
verdict in `items`, like any candidate. `missing` lists page widths with no pieces (an old
browser pass: `qc browse --force`). The pieces cover every page that is not a post and the newest
10 posts. **Look at every piece — nothing is skipped or sampled.**

How to look, so it stays cheap:
- **Read 6–10 pieces in one step** (several Read calls in one message), one page's pieces in
  order; never one piece per step: every step resends everything already read.
- One agent takes **about 60 pieces**: the shared pieces in one or two agents, the rest split
  by page type. A type with more pieces is split.
- Compare sibling pages of one template by their pieces side by side in one step.

In each piece look at every element, edge to edge, not only the big blocks: text past its box or
cut off; an icon touching or overlapping its text, no gap between an icon and a label; text
crowding a rounded edge; overlapping elements; anything past the screen edge; a broken grid (one
card alone on a row, cards of different heights where the design has them equal, a column
squeezed to a word per line); an empty block or a big blank gap; a broken or missing image or
icon; text over an image that cannot be read; a sticky bar covering content (first screen); a
section spaced or styled differently from the same section on sibling pages; a block duplicated
or missing compared with the siblings; a placeholder. A defect that sits on the overlap of two
pieces is one defect.

Record **one `check: "visual"` entry per agent batch** (or per page): `tiles` — every id looked
at (`["T12-T19", "T40"]`), `ok` ones too; `checked` — what was compared. **Each defect once**,
with `tile`: the piece it is on. Give its `target` (the exact, unique words of the broken element, or its selector — see qc-browse) and mark the spot on the piece: `box` — `{x, y, w, h}` in px of that piece
(read them off the picture); the engine draws the frame. A defect without `box` gets its spot
found on the live page by `qc evidence` (its `selector`, or the words quoted in `found`), so
quote the text of the spot when there is any. The piece is its picture and the piece's pages are its pages —
do not repeat a defect per page or per width; a defect seen at two widths names one piece and
says the other width in `where`. Give a tighter crop in `shots` only when the piece alone does
not show the spot:

```bash
sips -c <height> <width> --cropOffset <y> <x> "<piece>.png" --out ~/.qc-cache/<host>/manual/visual-<n>.png
```

`qc review` prints `tiles`: `seen` of `total` (cached ones count as seen), and the first
`unseen` pieces. **Do not publish until `seen` equals `total`** — give the unseen pieces to an
agent and review again. The report says plainly when the look did not cover every piece.

## Subagents

Split the work so each agent has one narrow job, the knowledge base and a fixed output. Launch
the ones that do not need a browser **in parallel** (one message, several Agent calls); the
Playwright MCP is one shared browser, so browser work runs **one agent at a time** (or an agent
drives its own Chromium with the engine's playwright from a `node` script).

| Agent | Needs a browser | Job |
|---|---|---|
| copy & facts (`qc:copy-reviewer`) | no — PA CMS markdown | the `content` check: contradictions, false or placeholder text, typos, CTAs copied from another page, facts against the knowledge base |
| visual (`qc:visual-reviewer`), ~60 pieces each from `qc tiles` | no — the piece files | the visual review above, every piece it was given, and the `hints` on them |
| judge | no — reads pages | every engine candidate with `judge` |
| browser checker | yes | every engine candidate with `verify`, the manual checks (menu, popups, forms, FAQ, focus) |
| journeys | yes | the journeys above |
| verifier | yes | the second check (below), after all the others |

**Models.** Looking at pieces and reading copy is wide, simple work: the plugin's own agents
`qc:visual-reviewer` and `qc:copy-reviewer` run on Sonnet (set in their files) — launch them by
`subagent_type`; where they are not loaded, pass `model: "sonnet"` in the Agent call. The judge, the browser checker, the journeys and the verifier
reason about cause and evidence: leave them on the default model.

Give every agent: the host, the knowledge base path, the run dir, what to check, «a defect is
what is broken or wrong, never a design suggestion», «answer `unsure` when the evidence does not
show it either way — a guess is worse than an honest unsure», English for everything it writes,
and the exact JSON it returns (`manual` entries, or `{id, verdict, note}` items). Check what
each returns before using it: a defect without its picture or quote goes back to the agent.

## The second check (verifier)

Before the review file is applied, a **fresh** agent that saw none of the work gets only the
list of defects Claude found (every `manual` defect: page, width, steps, found, the picture)
and tries to reproduce each one from scratch: the same page and width in Playwright, the same
steps. For content defects first run `node <plugin-root>/engine/src/cli.js quotes "<host>"
"<review-input.json>"`: it looks up every quoted «…» on the pages named, in the crawled text. A
quote it finds is there — the verifier only judges whether the claim about it is right (a
contradiction, a typo, a false fact), reading those pages' Markdown from the PA CMS, not the
browser. Quotes it does not find (alt text, a file name, an href, a page not crawled) the
verifier checks on the page itself. For each it answers
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
browser pass and the visual review (every piece) take the newest 10 (`qc browse --posts 10`, the default), the
copy agent reads the newest 10 in full and skims the rest's titles and intros.

## Every defect says what it is, in its own title

- **`title` is the problem in a few words**, written for someone scanning a list: «Personal
  claim form asks for a business claim type», «Two sentences merged on Claims», «Hero is missing
  the intro line under the H1». Never the rule's name («Pages contradict each other») — the
  report shows the rule's code and name beside it. The engine refuses a manual defect without
  a title.
- **The code names what is wrong**, not the check you found it in. Copy: H3 a typo or a broken /
  merged sentence, H1 lorem ipsum, H6 a placeholder, H7 an alt text, H2 text against the copy doc,
  H8 the same text twice, H5 an outdated date, H9 a removed service or old data, H12 another
  place's name, H17 the brand; **H16 only when two places on the site say different things**
  (and name both). Links E…, forms G…, layout B…, design A….
- **The first page is the one that shows it best**; a defect hidden in a closed popup, tab or
  menu carries your own screenshot with it open (`shots`), because the engine's crop cannot
  open it.

## The live site and the strategy are references

On a dev site with a live one (`--prod`, or `prodCompare` in the audit summary), and whenever
the strategy sheet is given, every defect about content or a missing piece is checked against
them before it is written:
- **content that looks wrong** (a date under the wrong year, a duplicate link, a strange name):
  open the same page on live. The same there → it is old content: say «the same on live», keep
  the defect only if it is wrong for the visitor, and fix from the right source. Different on
  live → a migration error: the fix is the live value, quoted, with its URL;
- **an empty or missing page** (a body with nothing between header and footer, a page the menu
  links to that has nothing): look it up on live and in the sheet. Live has the content → «copy
  it from <live URL>» with what it holds; the sheet says the page is new or dropped → say so and
  what to do (fill it from the copy doc in the sheet, remove it from the menu and the sitemap);
  nowhere → «the client must send the content», and the defect is copy;
- **any fix** that needs a value (a link, a phone, an address, a document, a text) looks there
  first, then in the facts file; say which source the value came from.

## Every failed item says how to fix it

The rule's own «expected» is generic («a working link», «a valid path»). For every defect that
stays in the report — the engine's confirmed ones and your own — work out the concrete fix and
write it as `fix` on the item (`{ "id": "D12", "verdict": "confirmed", "note": "…", "fix": "…" }`)
or as `expected` on a manual defect. Look it up, do not guess:

- **a broken or wrong link**: find where it should go — the page that moved (the sitemap, the
  site search, the PA CMS page list, a page with the same title), the file in the uploads (the
  same file name under `/wp-content/uploads/`), the live site's URL for a dev link; give the
  exact URL to put in;
- **a Google Business Profile link, a phone, an address, hours**: the right one from the facts
  file and the knowledge base (the contact page, the GBP the site lists elsewhere); say which
  source it comes from;
- **text**: the corrected words, quoted;
- **layout**: what to change and where (the Elementor widget or section, the setting, the width);
- when the right value cannot be found, say what is missing and who has it («the client must
  send the new PDF»), never invent one.

Lead with the answer in one line, then the detail. Write it in HTML or in Markdown; the report
renders both in its own style, so use its classes instead of inline styles (anything else is
dropped):

- `<div class="pair"><div class="before">now</div><div class="after">should be</div></div>` —
  the wrong value next to the right one (a link, a phone, a text);
- `<span class="value">…</span>` or `<code>` for a value to paste; `<span class="ok">`,
  `<span class="bad">`, `<span class="warn">`, `<span class="muted">` for a word that needs a colour;
- `<div class="callout">…</div>` for the one thing a developer must not miss;
- `<ul>`, `<ol>`, `<table>`, `<b>`, `<mark>`, `<kbd>`, `<a href="https://…">`.

The same goes for `checked` (what the agent saw): one fact per line, not one long paragraph. For
a missing page or link, say plainly whether it exists somewhere (give the URL) or does not exist
and must be created or asked from the client.
