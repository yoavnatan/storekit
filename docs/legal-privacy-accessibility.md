# Privacy and accessibility — what the law actually requires of this site

**Read this before editing `/privacy` or `/accessibility`, and before answering a question about
either.** Everything below was checked on **2026-08-25** against a primary source — the Privacy
Protection Authority's own professional guide, and the text of the accessibility regulations — and
each claim carries the source it came from. The reason for the file is that both subjects are
surrounded by vendor blog posts selling a widget or an audit, and those get the two most
consequential facts wrong in the same direction: they overstate what a small site must do (register
a database, appoint a DPO) and understate the one duty it cannot escape (the accessibility
statement, which no revenue threshold exempts a site built after 2017 from).

⚠️ **None of this is legal advice and none of it replaces the עו״ד.** It is the factual base the
two pages were written on, so that a later session does not re-derive it from a sales page.

---

## 1. Privacy — תיקון 13 לחוק הגנת הפרטיות

**In force 2025-08-14.** The largest change to Israeli privacy law in decades.

> **Read this section as Israeli law only** (owner, 2026-08-25: *"צריך להתאים לחוקים ולנוהג המקובל
> בישראל, לא באירופה"*, and then *"נכון על כל הסשן"*). GDPR material is far better documented in
> English than Israeli law is, so it is what a session drifts to by default — and it produces work
> that is both wrong about which rules bind us and heavier than what an Israeli business actually
> does. Every claim below is sourced to an Israeli statute, regulation or Authority publication.
> **Where the law and the local practice differ, both are stated** — a duty nobody in Israel
> discharges is still worth naming, but so is the gap.

Source: *מדריך מקצועי: תיקון מס' 13 לחוק הגנת הפרטיות*, הרשות להגנת הפרטיות —
<https://www.gov.il/he/pages/guide_tikon13_professional>

### What we DO have to do

| Duty | Where it lands |
|---|---|
| **חובת יידוע (§11), as widened** — say whether there is a legal obligation to give the data, **what happens if the person refuses**, the purpose, who receives it and why, **and that a right of access (§13) and a right of correction (§14) exist** | `/privacy`, clauses "האם חובה למסור המידע" + "הזכויות שלך" |
| **State the retention and deletion policy** | `/privacy`, clause "כמה זמן נשמר המידע", interpolated from `lib/data-retention.ts` |
| **Process only for the purpose the database was set for (§8(ב))**, and only with authorisation (§8(ג)) | An engineering constraint, not a page. A new use of order data is a new purpose. |
| **Honour access / correction / deletion requests** | 30 days. Stated on the page; there is no built flow yet — see §4 below. |

### What we do NOT have to do — and must not pretend to

- **Database registration: abolished for us.** Amendment 13 all but ended registration for the
  private sector. What remains: a public body's database, and a database whose *main purpose* is
  collecting personal data to pass to others as a business or for consideration (data brokers,
  direct mail) with **10,000+** subjects. A marketplace is neither. *"חובת רישום מאגרי מידע ביחס
  לגופים במגזר הפרטי בוטלה כמעט לחלוטין"* — the guide, §6.
- **A ממונה על הגנת הפרטיות (DPO): not required.** The duty falls on public bodies; data brokers
  with 10,000+ subjects; controllers whose **main occupation** involves systematic large-scale
  monitoring of people (the guide names mobile carriers and search engines); and controllers whose
  main occupation is large-scale processing of specially-sensitive data (banks, insurers,
  hospitals, HMOs are named in the statute). Selling goods with one platform-wide pixel is none of
  these. **Do not name a DPO on the page** — the title takes on the role's obligations without
  being under its criteria.
- **The חובת הודעה לרשות: not triggered.** It applies to a database holding *specially-sensitive*
  information on **more than 100,000 people** that is not otherwise registrable, within 30 days.
  Two thresholds away from us. Worth re-reading if the platform ever gets near that size.

### Sanctions, so the size of the risk is on the record

Administrative fines under Amendment 13 run to **₪150,000** per violation (doubled above one
million subjects), with floors of ₪30,000–₪200,000 for some categories and a ceiling of
**₪1,600,000** for the worst. Separately, the amendment **abolished the shortened two-year
limitation period** for civil privacy claims — it is now the general seven years — and allows
compensation **without proof of damage** up to ₪10,000 for, among others, approaching a person for
their data without the §11 notice.

---

## 2. Accessibility — is it compulsory? Yes, and no exemption reaches this site

**תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), תשע״ג-2013, תקנה 35.**

Sources: the regulation text — <https://www.nevo.co.il/law_html/law01/500_865.htm> · a
clause-by-clause reading — <https://aisrael.org> (נגישות ישראל) · the exemptions —
<https://www.kolzchut.org.il> (כל-זכות)

- **The standard is ת״י 5568 at level AA** (the Israeli standard tracking WCAG). Not AAA.
- **תקנה 35ה requires publishing an accessibility statement** — what was made accessible, who to
  contact about accessibility, and how to report a problem.
- **The turnover exemption does not reach us.** The one people quote — annual turnover up to
  **₪1,000,000** — is a *temporary three-year* exemption and applies **only to a site whose
  operation began before 26.10.2017**. This site did not exist then, so it is exempt at no revenue.
  A separate blanket exemption exists for a **עוסק פטור**; that is a status about tax registration,
  and the platform company is not one.
- **A רכז נגישות is NOT required of us.** That duty (תקנה 91) starts at **25 employees**. The
  statement therefore names an address and a phone number to write to and avoids the title.
- **Enforcement.** Administrative: **₪7,500 per day** of violation (doubled for a corporation).
  Civil: up to **₪50,000 without proof of damage**. Criminal: about ₪150,000. A correction window
  of 60 days follows a warning (תקנה 35א(ד)).

### And it is not only a legal duty here

The owner's own framing from the start (memory `project_seo_priority`) is that accessibility is
part of SEO, and that is literally true: semantic headings, real labels, alt text, keyboard order
and contrast are the same substrate a crawler reads. The work is not a tax on the SEO goal — it is
the same work.

---

## 3. What was actually measured, 2026-08-25

axe-core 4.10 at **WCAG 2.1 AA** driven over `/`, `/stores`, `/search`, a store page, `/checkout`,
`/contact`, `/help`, `/pricing`, `/returns-policy` and `/seller/register`, at **1280px and 375px**,
plus a keyboard drive of the product card. **Three real defects, all fixed the same session:**

1. `aria-pressed` on the category chips at `/stores` — invalid ARIA on a link (critical). The store
   page's own chip row had already moved to `aria-current="page"`; this was the copy that did not
   follow. The dead `[aria-pressed]` half of the CSS selectors went with it.
2. `nested-interactive` on every product card — the picture carried `role="button"` while
   containing the wishlist button and the carousel dots (serious, 24 nodes).
3. `scrollable-region-focusable` — the card's image carousel scrolled but was not a tab stop, so a
   keyboard shopper could not reach the second photo of anything (serious, 11 nodes).

(1) and (2) were **twin drift**: a rule learned in one renderer and not carried to the other, which
is the failure class memory `project_brand_boost_twin_drift` names.

**Every scanned page is now clean at WCAG 2.1 AA.** Re-run the scan before moving the date on
`/accessibility` — the harness is a one-off Playwright script, not a committed suite (the
Playwright rule in `AI_INSTRUCTIONS.md`); rebuild it from this paragraph.

---

## 4. Open, and owner's to decide

- **Cookies — DECIDED and built, 2026-08-25. The first version of this row got the law wrong, so
  the correction is kept here rather than tidied away.** It said the Authority's 2020 draft
  "requires" opt-in. It does not, and neither does the statute:

  > **Israeli law contains no express cookie-banner duty and does not require opt-in.** What it
  > requires is the §11 notification duty and consent *מדעת* — and, subject to clear disclosure in
  > the privacy policy, consent **may be implied from the user's conduct**. The 2020 document is a
  > *draft* opinion that was never finalised. **The Israeli practice** follows: most Israeli sites
  > run cookies from the first visit and show at most a notice bar saying so. A blocking opt-in
  > banner is the European shape.

  **What shipped is the Israeli one**, after a first implementation of the European one was built
  and replaced the same day (owner: *"צריך להתאים לחוקים ולנוהג המקובל בישראל, לא באירופה"*, then
  *"נכון על כל הסשן"* and *"הלכת רחוק מדי"*). Concretely:

  | | |
  |---|---|
  | Tags run | from the first visit, for a visitor with no recorded preference |
  | The bar | a NOTICE — one sentence, a link to `/privacy`, and "הבנתי". **No reject button, no settings button** (*"שלא יהיה שם כפתור כיבוי… פשוט שקל ללחוץ עליו"*) |
  | The off-switch | in the cookies clause of `/privacy`, which the footer links from every page |
  | Google Consent Mode | `default` on every page, `update` when a preference changes — so a switched-off category reaches Google's gate and not only ours |

  **The three things that make this lawful rather than merely customary, and none is optional:**
  a visitor with no preference is treated as permitting (that IS implied consent); the disclosure
  is actually published, in full, on `/privacy`; and the control is genuinely reachable. The
  parenthesis in the owner's instruction — *"כל עוד זה חוקי"* — is the constraint, and "reachable"
  is the floor even though "prominent" is not the goal. `lib/consent.ts` carries the reasoning and
  `tests/consent.test.ts` pins both directions, including that the notice bar has no off-switch and
  that `/privacy` does.

- ⚠️ **How long a buyer's identifying details live inside an old order.** Two questions to two
  people: the רו״ח (how many years an accounting record must be kept) and the עו״ד (when the
  identifying fields come off). Until answered, `ORDER_RETENTION_YEARS` stays `null` and the page
  states the duty rather than a number. Already a GO_LIVE row.
- **No built flow for a subject-access or deletion request.** The page gives an address and a
  30-day promise, which is lawful and is what a business this size does. It becomes a real feature
  the first time the volume makes a mailbox insufficient.
