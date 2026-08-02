# Классификация Resolved-правок из MarkUp.io (workspace: Poirier Agency)

Источник: https://app.markup.io/w/poirier-agency — 10 markup-проектов, извлечено **1000 Resolved-тредов**
(данные вытянуты из React-стейта страницы, не из скриншотов).

## Охват

| Markup | Домен | Resolved |
|---|---|---|
| Granite | graniterecoverycenters.com | 448 |
| Liberty Bay | www.libertybayrecovery.com | 196 |
| Cape Town | restaurants-in-cape-town.co.za | 105 |
| Addiction Resources | addiction-resources-dev.patest.website | 87 |
| Mt. Sinai | mtsinaiwellness (Mt.Sinai) | 84 |
| Taste of Tribeca | taste-of-tribeca.patest.website | 55 |
| Live Free | livefreerecoverynh.com | 12 |
| Homeprod | homeprod.co | 9 |
| Poirier | poirier.agency | 4 |
| Tacos Barrio | tacosbarrio.com | 0 (только Active) |
| Архив воркспейса | — | пусто |

Стек проверяемых сайтов: **WordPress + Elementor + Gravity Forms + JetPopup**.

---

## Таксономия правил для QC-плагина

Маркер `[ACROSS SITE]` — правка, которую ревьюеры почти всегда просят применить глобально.
Это ключевой сигнал: плагин должен проверять **консистентность между страницами**, а не только одну страницу.

### A. Соответствие макету Figma
- **A1** Отсутствует секция / есть лишняя («missed a section», «should be one more block», «where is section»)
- **A2** Секция свёрстана иначе, чем в Figma («this section should look as match as layout in Figma»)
- **A3** Неверный цвет («wrong color #4F68C4 should be», «different background», «wrong background»)
- **A4** Другая картинка на баннере («different picture on banner in figma»)
- **A5** Неверное количество элементов: карточек, чекбоксов, статей («in Figma 4 cards (two in row)», «should be 3 articles», «should be 6 checkboxes»)
- **A6** Типографика не совпадает: размер, вес, лишний bold («this part shouldn't be bold», «h2 60px like on the homepage»)

### B. Layout / отступы / выравнивание — **самая массовая категория**
- **B1** Левый/правый padding контента не одинаков между страницами `[ACROSS SITE]`
- **B2** padding-top ≠ padding-bottom («padding top for picture should be the same with padding bottom»)
- **B3** Слишком большой / маленький отступ («reduce the space», «too big space to footer»)
- **B4** Выравнивание («align to the left», «text-align: center на adaptive», «align the form»)
- **B5** Контент вне контейнера («all content should be in container - this section too»)
- **B6** Перекрытия / z-index («subscribe form should have z-index bigger», «dropdown should be over buttons», «tooltip overlaps the text field»)
- **B7** Одинаковая высота карточек в ряду («let's do the same height for all cards, just add read more»)

### C. Адаптив / responsive
- **C1** Горизонтальный скролл на мобильных — **критично** («!!! should not be horizontal scroll on adaptive!»)
- **C2** Элемент не влезает в экран («it doesn't fit», «fit this section into the screen»)
- **C3** Размер шрифта на планшете/мобильном («at least 14px for iPad», «H1 40px for mobile», «H1 45px for tablet ACROSS SITE»)
- **C4** Порядок блоков на брейкпоинте («move img above the form (<1024px)», «on mobile: first contact information then the form»)
- **C5** Количество колонок в сетке («at least two in row for iPad», «should we do two in a row for tablet»)
- **C6** Брейкпоинт бургер-меню («1230px delete burger menu», «adapt mobile menu to 360px»)
- **C7** Качество / адаптивность изображений («really bad quality photo on the tablet», «can these photos not be stretched»)
- **C8** Баги на конкретных диапазонах («from 1347px till 1189px move button to second row», «the second call button appears only 1100–1300px»)
- **C9** Скролл в мобильном меню («fix the scroll in mob menu, it doesn't show the last item»)

### D. Навигация / меню
- **D1** Dropdown не работает («broken drop down menu», «drop-down doesn't work (desktop only >1024)»)
- **D2** Страница отсутствует в dropdown («please add this page to drop down»)
- **D3** Нет / неверный active-state текущей страницы `[ACROSS SITE]` («state color #ffb800 for active page», «add active state for nav items when you are on current page»)
- **D4** Active-state должен быть и в футере тоже
- **D5** Структура/порядок пунктов («move back Partnerships & Referrals to About Us dropdown»)
- **D6** Меню должно быть в одну строку («nav should be in one row», «in figma header in one row»)
- **D7** Поведение sticky-хедера («make the sticky header a bit less while scrolling», «sticky navigation doesn't scroll down»)
- **D8** Privacy Policy не должна подсвечиваться как активный пункт меню

### E. Ссылки и URL
- **E1** 404-ссылки («404 links», «this page 404», «facebook icon in mobile footer is 404 — двойной слэш в URL»)
- **E2** Ссылка ведёт не туда («wrong link», «should be this link»)
- **E3** Внутренняя ссылка не должна открываться в новой вкладке; внешняя — должна `[ACROSS SITE]`
- **E4** Формат `tel:` в HTML — без пробелов/дефисов/точек, с `+1` («tel:+18556078758») `[ACROSS SITE]`
- **E5** Дубль `+1` в номере («extra +1 in html»)
- **E6** `mailto:` не должен открываться в новой вкладке; email/телефон должны быть кликабельны
- **E7** Кликабельным должен быть только телефон, а не весь текст («make only phone active, not all text»)
- **E8** Скрывать ссылку, если страницы не существует («hide these links if we don't have pages»)
- **E9** Google Business Profile / Maps: ссылка должна вести на GBP нужной локации, а не на поиск Google
- **E10** Текст адреса не совпадает со ссылкой
- **E11** Дубли ссылок («do we need two same links», «should be one link, not two»)
- **E12** Разные номера телефона на разных страницах

### F. Hover / интерактив / курсор
- **F1** Нет hover на ссылках / кнопках / картинках («add hover» — самая частая одиночная правка, 19 раз в Granite)
- **F2** Неверный цвет hover («color #ffb800 on hover for all links in footer», «color #00a2e5 for hover on breadcrumbs») `[ACROSS SITE]`
- **F3** Зона hover/click слишком большая — должна быть на тексте, а не на всём `<div>`/строке/кнопке
- **F4** Курсор `pointer` только у интерактивных элементов («cursor shouldn't be a pointer when the element is not interactive»)
- **F5** Плавность transition («should be transition for all hovers across site»)
- **F6** Подчёркивание: добавить / убрать / оставить только на hover
- **F7** Карточка/блок целиком должен быть кликабельным («make entire blocks clickable»)
- **F8** Зум изображения на hover («slight zoom in on image on hover»)
- **F9** Баги аккордеона («clicking the second item should open the second item, not close the first»)
- **F10** Вес шрифта у active/hover ссылки (weight: 600)

### G. Формы (Gravity Forms)
- **G1** Нет чекбокса Privacy Policy («add PP checkbox to all forms»)
- **G2** Чекбокс должен быть required
- **G3** `*` у всех обязательных полей
- **G4** Ссылка на Privacy Policy открывается в новой вкладке
- **G5** Валидация телефона — только цифры («shouldn't be letters in Phone field»)
- **G6** Email обязателен
- **G7** Кнопка Submit пропадает/не видна после неудачной отправки
- **G8** Стилизация инпутов не как в Figma; фон формы отличается от других страниц
- **G9** Thank-you страница: редирект после submit, стилизация, кликабельный телефон
- **G10** SMS-consent убрать / добавить
- **G11** Раскладка полей: в одну колонку на мобильном, выровнять поля, уменьшить padding чтобы поля были крупнее
- **G12** Активное поле должно подсвечиваться; убрать background при фокусе

### H. Контент / копирайт
- **H1** Оставшийся Lorem ipsum на странице
- **H2** Текст не совпадает с копирайт-доком / Figma («wrong copy», «different text in figma», «missed sentence»)
- **H3** Опечатки («Helpt?», «Connecticut» вместо другого штата)
- **H4** Пропущенный абзац / нет отступа между абзацами
- **H5** Устаревшие даты и годы («03.20.2026», «not sure about this 2025»)
- **H6** Плейсхолдер для отсутствующего изображения
- **H7** Нет alt-текста (логотип в шапке и футере)
- **H8** Дубль текста («remove S.D. at the end — it's already at the beginning»)

### I. SEO / техничка
- **I1** Нет H1 или несколько H1 («missing H1», «multiply H1 on pages», «H1 should be one on all blog pagination and category pages»)
- **I2** Нарушена иерархия заголовков — пропущены h4/h5 `[ACROSS SITE]`
- **I3** H1 должен быть текстом, а не картинкой
- **I4** Страница закрыта noindex, хотя должна быть index, follow
- **I5** Canonical не совпадает с URL
- **I6** Title: дубли, «Home» в тайтле главной, отличается от согласованного
- **I7** Meta description отсутствует или дублируется на двух страницах
- **I8** Пагинация: страницы не индексируются, номер страницы отсутствует в URL, лишняя «2» в URL `[ACROSS SITE]`
- **I9** Нет хлебных крошек на странице
- **I10** Хлебные крошки не совпадают со структурой URL («all program pages should have `programs` in breadcrumbs»)
- **I11** Хлебные крошки ведут на категорию вместо родителя
- **I12** Позиция и стиль хлебных крошек не одинаковы между страницами `[ACROSS SITE]`
- **I13** Нет favicon
- **I14** Артефакты dev-окружения на проде («remove dev across site»)
- **I15** Серверные ошибки: 503, 504 Gateway Time-out
- **I16** Медленная загрузка фильтров/архивов

### J. Доступность (ADA / a11y)
- **J1** Шапка должна быть в теге `<header>` — «this is important rule for accessibility»
- **J2** Навигация должна работать с клавиатуры
- **J3** Недостаточный контраст цвета (#6f88e4 забраковали как слишком низкий контраст)
- **J4** Семантика: абзац как `<p>`, а не как заголовок
- **J5** Общие ADA-замечания

### K. WordPress / Elementor / JetPopup / архивы
- **K1** Фильтр или поиск не работает / отдаёт неверные результаты
- **K2** Таксономия: пустые категории скрыты, а в дизайне они есть (ожидаемое расхождение — стоит уметь отличать)
- **K3** Блок блога выглядит по-разному на разных страницах («the blog section is different on this page from the rest»)
- **K4** Попап не работает (JetPopup)
- **K5** Слайдер/карусель: появляется только после перезагрузки, не работает скроллбар, видео не останавливается при перелистывании
- **K6** Кнопки шаринга не работают
- **K7** «Load more» / «Read more» не работает
- **K8** Пагинация показывается при нулевой выдаче
- **K9** Кнопка «наверх»: не нужна, если карточек меньше 6; должна быть floating
- **K10** Блог: нет автора / категорий / нужного числа статей в блоке «Read some of our news articles»
- **K11** Дубли страниц с одинаковым содержимым

---

## Выводы для архитектуры QC-плагина

1. **Кросс-страничная консистентность важнее одиночной страницы.** Больше половины правок содержат
   «ACROSS SITE» / «should be the same with other pages». Плагин должен собирать метрики
   (padding контейнера, позиция и padding хлебных крошек, hover-цвета, размер H1 по брейкпоинтам,
   формат `tel:`) по всем страницам и **искать выбросы**, а не сверять с абсолютной константой.

2. **Топ-5 категорий по объёму:** B (отступы/выравнивание) → C (адаптив) → F (hover/интерактив) →
   E (ссылки, особенно `tel:` и new-tab) → I (SEO: H1, хлебные крошки, index/canonical).

3. **Полностью автоматизируемо** (без Figma и без человека): E1 404, E3 target=_blank, E4/E5 формат `tel:`,
   E6 mailto, I1 H1, I2 иерархия заголовков, I4 noindex, I5 canonical, I6/I7 title и description,
   I13 favicon, I14 следы dev-домена, I15 5xx, H1 Lorem, H7 alt, J1 `<header>`, J3 контраст,
   G1–G3 и G5 (структура формы), C1 горизонтальный скролл, F4 cursor:pointer.

4. **Требует сравнения между страницами:** B1/B2, D3, F2, I12, K3, C3.

5. **Требует Figma / копирайт-док:** вся группа A, H2, A5.

6. **Требует прогона в браузере на нескольких брейкпоинтах:** C (весь), F1/F3/F5/F9, D1/D7, K4/K5/K7.
   Набор брейкпоинтов из реальных правок: **360, 767, 768, 1024, 1100–1300, 1189, 1230, 1333, 1347**.

---

## Calibration log

Recorded after the first real-site run of the engine (31-page WordPress/Elementor site,
`cleaningny.com`, Task 16/16b). Kept here so the next tuning pass has the actual evidence instead
of re-deriving it. Full detail: `.superpowers/sdd/2026-08-01-qc-static-engine/task-16b-report.md`.

### The first run was 95% noise from two rules

The uncalibrated engine produced 372 findings on 31 pages, of which **353 (95%) came from E1
(broken links) and E3 (`target=_blank`/`rel=noopener`)**, all at `major`, drowning out the 5
genuine defects the same run also found (a malformed URL, a malformed `tel:`, a heading-hierarchy
skip, a duplicate title, and a JSON-LD parse error). That ratio — not a hypothetical — is what
drove the E1/E3 recalibration below.

### E3 (`target=_blank`) — split by certainty, not treated as one rule

| finding | before | after | why |
|---|---|---|---|
| internal link with `target="_blank"` | major/high | **unchanged** — major/high | genuinely wrong: internal links should never force a new tab; this is the agency's house rule |
| external `target="_blank"` missing `rel="noopener"` | major/high | **minor/high** | browsers have shipped implicit `noopener` for `target="_blank"` since 2021 (Chrome 88, Firefox 79, Safari 12.1) — no longer a live security hole, just hygiene |
| external link *without* `target="_blank"` | major/high | **minor/heuristic** | new-tab-or-not for external links is a per-client style call, not a defect — `heuristic` keeps a subjective preference out of the verdict |

### E1 (broken links) — bot-blocking split out of "broken"

Restructured into buckets by what the HTTP status actually proves:

- **internal, any failing status (including 0)** — unchanged, `critical`. Internal breakage is
  always ours to fix.
- **external, status 0** (no response) — unchanged, silent. Ambiguous: could be our checker being
  blocked, not the target site being down.
- **external, 400/401/403/405/429** (new `BOT_BLOCKED_STATUSES` set) — **new**: `note`/`heuristic`,
  worded explicitly as needing manual confirmation. These statuses are what a site returns to a
  non-browser client defending against scrapers, not evidence the link is actually dead. (429 is a
  slightly different case — it can mean *our own crawler* went too fast rather than the target
  blanket-blocking bots; still not evidence of a dead link, so it stays in the same bucket, flagged
  here in case a future pass wants to word it more precisely.)
- **external, everything else received** (404, 410, 5xx, other 4xx) — unchanged, `major`/`high`.
  404/410 are genuinely gone; 5xx survived `fetchOne`'s retries, so it's durable breakage.
  409/malformed-URL detection (doubled `https://` embedded in a path) is unchanged at
  `critical` — this is the check that caught the real bug on `cleaningny.com` and was deliberately
  left alone.

On the real run: E3 was 256 findings (44 internal-blank, 180 external-missing-noopener, 32
external-no-target) and E1 was 99 (62 external 400, 35 external 403, 1 internal 404 on the
malformed link itself, 1 malformed-URL). After recalibration, 129 of those 372 findings (35%) moved
to `heuristic` — set aside for a human to confirm, never silently dropped — instead of inflating
`major`.

### Raw occurrences vs. distinct defects — `counts` alone overstates the work ~4x

A second gap surfaced only once someone tried to *use* the summary block: `counts.major: 56` reads
as "56 major issues," but on `cleaningny.com` those 56 raw occurrences are **15 distinct defects**
(same selector + same rule + same `found` text, repeated verbatim across every page a template
appears on). The most extreme case: one `/privacy-policy/` footer link, missing `rel="noopener"`,
accounted for 32 of the 44 `E3` `major` occurrences by itself — one fix, 32 raw findings.

A caller reading only `counts` overstates remaining work by roughly an order of magnitude, which
directly contradicts the engine's own value proposition ("one template bug found once, not
re-litigated per page"). Fix: `src/report/json.js` now exports `countDistinct(findings)`, keyed on
`defectIdentity(f) = rule + selector + normalizeFound(found, rule)` — page is deliberately excluded
from that identity, since a template-level defect repeated verbatim across every page *is* one
defect. `src/cli.js`'s JSON summary carries this as `distinct`, alongside the raw `counts`:

| rule | severity | raw (`counts`) | distinct |
|---|---|---|---|
| E1 | critical | 2 | 2 |
| E3 | major | 44 | **8** |
| E3 | minor | 180 | **6** |
| E4 | major | 2 | 1 |
| I2 | major | 5 | 2 |
| I6 | major | 2 | 1 |
| I7 | minor | 5 | 2 |
| S1 | major | 3 | 3 |

`counts` on the real run: `{critical: 2, major: 56, minor: 185, note: 0}`.
`distinct` on the same run: `{critical: 2, major: 15, minor: 8, note: 0}`.

A related fix landed alongside this: the HTML report's `rollUp()` originally grouped findings by
`rule` alone and kept only the most severe member, which re-merged the exact severity split E3 had
just been given — 44 `major` + 180 `minor` E3 findings collapsed into one row chipped "Major · 224
находок," making the calibration invisible in the artifact a human actually reads. `rollUp()` now
groups by `rule + severity + confidence`, so each combination renders as its own row.

**Takeaway for anyone consuming this engine's output (including the `/qc-site` skill):** lead with
`distinct`, use raw `counts` only as a secondary "how many pages does this touch" figure, and always
surface `heuristics` separately as unconfirmed rather than folding it into either number.

---

## Browser calibration log

Recorded after the first real-site run of the browser pass (`qc browse`, 10 pages of the same
31-page WordPress/Elementor site, `cleaningny.com`, Task 11). Kept here for the same reason as the
static-engine log above: so the next tuning pass has actual evidence instead of re-deriving it. Full
detail: `.superpowers/sdd/2026-08-01-qc-browser-pass/task-11-report.md`.

### The raw numbers before anything was touched

10 pages requested, 7 completed, 3 failed, 1025 browser findings from 4 of the 9 browser rules —
**C1, X1, X2, F1 and B6 produced nothing at all**:

| rule | severity/conf | raw | pages | distinct | example `found` |
|---|---|---|---|---|---|
| F5 | minor | 657 | 7 | 17 | `правило a:active, a:hover меняет стиль без transition` |
| F4 | minor | 195 | 7 | 39 | `cursor:pointer на неинтерактивном элементе` |
| J3 | major/heuristic | 148 | 7 | 4 | `контраст 2.25:1 при 16px` |
| C2 | major | 25 | 4 | 19 | `ширина 2843px при вьюпорте 1440px` |

Every zero and every noise bucket was checked by hand against the live site (a headless run against
the same 7 pages, calling the rule/bundle code directly — not a second `qc browse`) rather than
assumed either way, per the brief's own warning that a rule producing nothing is as suspect as one
producing too much.

### The three failed pages were a real bug, not the site

`about/`, `services/` and `emergency-cleaning/` all failed with the identical Playwright error
`browser.newContext: Target page, context or browser has been closed`. The page immediately before
the run of failures (`car-dealership-cleaning/`) already shows the same error as a per-width failure
at its LAST width (1440) — the single Chromium instance the whole pass shares (by design, for launch
cost) died mid-pass, and every attempt after that point failed identically and instantly, never
timing out. Nothing detected the browser itself was gone, so nothing tried to recover: a page that
fails this way still gets a stored row (so it is never retried without `--force`, which discards
every already-collected result). Fixed in `src/browser/run.js`: `runBrowserPass` now checks
`browser.isConnected()` before each page and relaunches a fresh browser if it is not, via a new
`launchBrowserImpl` injection point (test-only, mirrors `cli.js`'s `fetchImpl`). Two new tests in
`test/browser/run.test.js` reproduce a real mid-pass crash (closing a real Playwright browser between
two pages) and pin both the recovery and the case where the relaunch itself fails.

### F4 (39 distinct) — the predicted flood never happened; three different real bugs did

**The one prediction on record was wrong, in an interesting way.** F4 was expected to flood on every
`<button>` missing `cursor:pointer` (Chrome's native default is `default`). It didn't: Task 4's
`NATIVE_FORM_TAGS` exclusion, written before any live run existed, correctly prevented exactly that —
confirmed here by re-checking the actual finding directions on the live data: **135 of 195 raw
findings were the OTHER direction** (`cursor:pointer` on an element F4 didn't recognise as
interactive), not the predicted one.

39 distinct was itself mostly an artifact, but not the artifact anyone guessed — three separate,
unrelated causes, each fixed and tested:

1. **Cursor inheritance across nested decorative markup.** `cursor` is inherited; a real dropdown
   arrow rendered as `<span><i><svg><path>` reported the SAME defect at 3 nesting levels (39 raw
   findings from this alone). Fixed: `F4-cursor.js` now skips a candidate whose direct parent already
   computes the identical cursor and is not itself interactive.
2. **Machine-generated ids destabilising `defectIdentity`.** A SmartMenus-style nav plugin assigns
   `id="sm-17856341663330366-3"` fresh on every page render — the SAME toggle link produced a
   DIFFERENT `defectIdentity` (`report/json.js` keys directly off `selector`, which used to trust any
   non-empty id) on every page, inflating 13 raw occurrences of one defect into 13 "distinct" ones.
   Fixed: `_helpers.js`'s `selector()` now falls back to a class/tag-based display when an id contains
   a run of 10+ digits (both the element's own id and a parent's, in the composite "tag#id > tag"
   form).
3. **Two real false-positive gaps in `interactive()`, found only once the ids above stopped churning
   and the real remaining patterns became visible:** a `<label>` associated with a form control (via
   `for` or by wrapping it) is genuinely clickable but wasn't recognised (70 raw findings, the largest
   single bucket — every Gravity Forms radio-option label on the site); and a nav item that is purely
   an `aria-haspopup="true"` submenu toggle with no `href` at all wasn't either. Both fixed in
   `interactive()`; `label` was also added to the Direction-B exclusion list (same reasoning as native
   form controls: no built-in "looks clickable" affordance, but not authoring `cursor:pointer`
   explicitly is normal) to avoid trading one flood for its mirror image. A fourth, smaller fix
   followed from the second: the "inherits pointer from a real interactive ancestor" exclusion used a
   separately hardcoded `closest('a[href], button, [role="button"]')` that had already drifted out of
   sync with `interactive()` itself — a submenu toggle's inner arrow span was still flagged even after
   the toggle was fixed. Now walks ancestors via `ctx.helpers.interactive()` directly.

Measured on all 7 successfully-crawled pages at 2 widths (1440, 360 — 14 page/width samples), running
the pre-fix and post-fix logic side by side against the live site in the same process:

| | raw | distinct |
|---|---|---|
| before | 61 | 27 |
| after | 12 | 3 |

The 3 remaining distinct findings are on `thank-you/` and `contact/thank-you/` — a real
`cursor:default` on 3 genuinely interactive Elementor CTA links, independently confirmed present
before AND after every fix above. Nothing here is a "no button lacks pointer" flood; it never was.

### F5 (657 raw / 17 distinct) — a real bug in the matching logic, confirmed on this site to not move the count

`F5`/`F1` both derived their query target by stripping `:hover` from a rule's WHOLE `selectorText`,
even when that text grouped several comma-separated compounds and only one of them carried `:hover`.
On a rule seen live —
`... .elementor-nav-menu--dropdown a, ... a:focus, ... a.elementor-item-active, ... a.highlighted, ... .elementor-menu-toggle, ... .elementor-menu-toggle:focus:hover`
— the old code folded ALL SIX compounds into one `querySelectorAll` target, matching dropdown nav
links and a menu-toggle button that have nothing to do with the actual hover rule. Fixed in both
`F5-transition.js` and `F1-hover.js`: a shared (duplicated, since both files must stay self-contained
for serialisation — see `_helpers.js`'s own header comment) `splitSelectorGroups()` splits on
top-level commas only (respecting `[]`/`()`) and keeps only the group(s) that themselves contain
`:hover`. Pinned with isolated fixtures where the bug is unambiguous: a grouped rule wrongly
flagging an unrelated sibling link, and `a:active, a:hover` no longer carrying the unrelated
`:active` compound into the displayed `found` text.

**Measured live, the fix changes nothing on this specific run.** Reconstructing the pre-fix logic and
running it side by side with the real (fixed) rule against all 7 pages at 2 widths:

| | F5 raw | F5 distinct |
|---|---|---|
| before (1440px, 7 pages) | 61 | 12 |
| after (1440px, 7 pages) | 61 | 12 |
| before (360px, 7 pages) | 68 | 13 |
| after (360px, 7 pages) | 68 | 13 |

Two reasons, both verified directly against the live DOM: the dominant bucket (`a:active, a:hover`,
463 of 657 raw in the original 10-page run) strips to base selector `a` either way — `a:active` is
already a strict subset of plain `a`, so the old and new query produce the identical element set.
And the specific mega-selector quoted above, when queried live, turned out to have its "extra"
non-hover compounds match either zero real elements (an unused Elementor pointer-effect variant) or
none beyond what the genuine hover compound already matched — this SITE's markup happens not to
expose the bug's effect, even though the bug itself is real and independently reproduced on
constructed fixtures. The fix stays: it is the correct algorithm, it is what stops a differently
structured theme's grouped selector from flooding the way this one didn't, and it produces an
honest `found` string instead of a misleadingly reconstructed one.

### F1 (0 raw, before and after) — confirmed genuine, not a matching-bug artifact

Same grouped-selector fix as F5 (F1's `targets` list had the identical bug, in the opposite
direction: an over-broad target marks candidates "covered" and SUPPRESSES a real finding). Applying
it live, side by side with the pre-fix logic, across all 7 pages at 2 widths: **0 before, 0 after,
on every single page/width combination.** Checked why directly: of 108 interactive candidates
(`a[href], button, [role="button"]`) on the homepage, 103–108 already match a broad, genuine
`:hover`-covering rule (`a:active, a:hover`, `[type="button"]:focus, [type="button"]:hover, ...
button:hover`, plus 113 total `:hover` selectors in the theme's stylesheets). This is a well-styled
theme with near-universal hover coverage, not a broken rule — F1's silence on this run is a genuine
clean result.

### J3 (148 raw / 4 distinct) — verified genuine by hand

Not touched. One occurrence (`li > a.elementor-item`, `контраст 2.25:1 при 16px`, homepage, 1440px)
was checked directly: the site renders a SECOND, fully visible instance of the main nav (likely a
sticky/scrolled-header variant) with muted green text `rgb(150,176,151)` over a near-white
`rgb(250,250,250)` background — computed by hand: **2.2470:1**, matching the reported `2.25:1` to
four significant figures. A real WCAG contrast failure, not noise.

### C2 (25 raw / 19 distinct) — spot-checked, left as is

19 distinct, stable Elementor element ids (not the churning kind F4 hit), each ~2841–2843px wide at
a 1440px viewport, on 4 pages. Consistent with a real, per-widget overflow (most likely an
unconstrained slider/carousel), not noise — raw and distinct are already close to 1:1. Not touched.

### C1, X1, X2, B6 (0 raw) — confirmed genuine, not a broken sink

All four checked directly against the live site rather than assumed clean:

- **X1** (console errors/failed requests) was the one the brief specifically doubted ("a production
  WordPress site with analytics and a chat widget producing not one console error... is unlikely").
  An INDEPENDENT Playwright listener (bypassing `preparePage`'s own capture mechanism entirely) on the
  live homepage also captured zero console errors, zero failed requests, zero 4xx/5xx responses over
  4 seconds. Running the actual `preparePage` + bundle mechanism against the same URL confirmed
  `window.__qcConsole` ends empty too, matching. X1's existing positive-control tests already prove
  the sink itself works on a page WITH errors; this proves it against a live page correctly finds
  none. Genuinely clean, not silently broken.
- **C1** (horizontal scroll): `document.documentElement.scrollWidth === clientWidth` confirmed
  directly at both 1440px and 360px (the width most likely to show an overflow bug).
- **B6** and **X2**: zero across all 70 (7 page x 10 width) combinations of the original run is
  consistent with a site with no baked-open modals/drawers (B6) and no unresolved lazy-load
  placeholders or broken `<img>` tags (X2) at crawl time. No live discrepancy was found in spot checks
  that would suggest either mechanism is silently failing.

### Two debts closed alongside the calibration

- **E4/E5 doubled-country-code overlap**: `E4` used to stay silent on ANY doubled `tel:` value,
  deferring entirely to `E5`. When the value was ALSO separator-malformed (`tel:+1-1-718-969-0845`,
  `tel:+1 1 718 969 0845`), that dropped a certain, directly-observable defect (the value isn't
  clean) into `E5`'s branch, which is `heuristic` confidence exactly when the doubling itself is the
  inferred (12-digit, leading "11") kind — a real defect quietly excluded from `counts`/the verdict.
  `E4` now fires (`expected: null`, its own `high` confidence, `major` severity) whenever the
  non-doubled form is STILL not clean, leaving the actual correction to `E5`; it stays silent when
  the doubling is the whole story. `lib/phone.js`'s `doubledCountryCode()` gained a `stillMalformed`
  flag for this. Tests: both brief-named cases plus a property test that E4/E5 never disagree on a
  proposed correction for the same href.
- **7-day staleness banner**: unreachable because `SNAPSHOT_TTL_MS` and the banner's own threshold
  were BOTH 7 days (commit `dc6889e`'s message claimed this was fixed — it set the reuse TTL to match
  the banner instead of the other way around, which only swapped which literal was wrong: a reused
  snapshot is by construction always younger than the TTL, so `snapshotAgeDays > 7` could never be
  true). Both numbers now live in `src/lib/snapshot-ttl.js`; the banner threshold
  (`STALENESS_WARNING_DAYS`) is derived from the TTL (`SNAPSHOT_TTL_DAYS - 1`) rather than restated,
  so they cannot drift apart a third time, and stays strictly below the TTL so it is reachable. Tests
  pin both the "threshold < TTL" property directly and that a snapshot near the TTL (but still inside
  the reuse window) renders the banner.
