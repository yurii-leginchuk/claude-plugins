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
