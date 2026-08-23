# PayMe — what they told us in writing

**This file exists because two sessions guessed at things that were answered in an email nobody had
saved.** The owner's instruction, 2026-08-23: *"אני אמרתי שחייב חייב להתייחס למיילים שלו"* — and he
was right, because the exchange below overturned a conclusion each of those sessions had recorded
with confidence.

**Order of authority when the three sources disagree:**
1. **A measurement against the live sandbox** (`payme-sandbox-notes.md`) — what the API actually did.
2. **This file** — what PayMe said they support, and what they have to switch on for us.
3. `payme-api-blueprint.md` — their raw spec, saved verbatim and **old**.

A statement here is not a measurement. Where the two disagree the measurement wins, and where this
file describes something never measured it says so.

**⚠️ Credentials are deliberately redacted below.** They live in `.env`, which is in no repository
(`CLAUDE.md` §restore). Never paste a key into this file, however convenient it is to have the whole
message in one place.

---

## 2026-08-2? — the owner to PayMe (Yakir), before signing

> שלום יקיר,
>
> בהמשך לשיחתנו אתמול, יש מספר דברים שעליי לוודא לפני חתימה על הסכם.
>
> 1. האם ה-API תומך בתשלום למספר מוכרים ברכישה אחת? (ענית כן, אבל אני אשמח לראות תיעוד, מאחר וזה
>    לא מופיע בהסכם ששלחת).
> 2. האם בעת עסקה הסכום שאותו אני גובה מהמוכר הוא נפרד ממה שמתואר כ״עמלת הפצה״? כלומר, האם אני
>    יכול להגדיר לכל בית עסק, עמלת מכירה שמועברת אליי בעת המכירה שאינה נחשבת עמלת סליקה?
> 3. האם בפיצול ניתן להגדיר גם סכום דינמי שלא מחושב באחוזים מהעסקה? (למשל — דמי משלוח שהקונה משלם
>    ואני צריך שיעברו אליי כדי שאשלם לחברת המשלוחים)?
>
> אם יש דוקומנטציה של הפיצול ואם ניתן, גישה לסנדבוקס, זה יסייע מאוד.

## PayMe's reply

> היי יואב בוקר טוב
>
> 1. https://payme.stoplight.io/docs/guides/4u5yp5vp5f41m-multi-capture-credit-cards זה התיעוד
> 2. אתה יכול להשתמש ב-direct market fee או ב-market fee, הראשון זה עמלה קבועה לדוגמה ״5 שקלים״,
>    השני זה אחוז מתוך העסקה.
> 3. כן זה אומר שכשאתה עושה לכידה בשווי 500 ש״ח שהם 100%, אני צריך להעלות לך את האפשרות בהגדרות
>    אצלי ל-110% לדוגמה.
>
> \*\*\* יש לשים לב — כי זוהי סביבה פתוחה ומשותפת לפרטנרים רבים, חשוב מאוד לא לשתף מידע רגיש/אישי
> בסביבה זאת. היא נועדה להתנסות במערכת פאיימי. \*\*\*
>
> מפתח שותף: «REDACTED — .env: PAYME_CLIENT_KEY»
> מזהה API כשותף: «REDACTED — .env: PAYME_SELLER_API_ID»
> כתובת סביבת הטסטים: https://sandbox.payme.io/
>
> הקמת יישות מוכר (seller): דרך פקודת create-seller עם ה-API —
> https://docs.payme.io/docs/payments/4239571881646-create-seller

---

## What this settles, and what it opens

### 1. ⚠️ Their answer to "several sellers in one purchase" is **multi-capture** — which is NOT what we built
The question was explicit and so is the answer: the documentation they pointed at is
*multi-capture for credit cards*. That is **one authorization drawn down by several captures**.

What this repository implements instead is **one PERMANENT buyer token charged as N separate sales**
(`lib/payment-split.ts`). That route was measured working end to end (`payme-sandbox-notes.md` §2–3)
and needs nothing switched on, so it is not wrong — but it is not the route the vendor considers the
answer, and the difference is not cosmetic:

* Multi-capture is **one authorization on the buyer's card**, which is very likely one line on their
  statement instead of one per store — the exact thing the owner objected to. **Not verified.**
* `§3.1.1` item 4 measured multi-capture **disabled on our key**: capture ₪40 of a ₪100
  authorization and the sale jumps to `completed`, a second capture refused `305`. That matches Yakir
  saying he must *"להעלות לך את האפשרות בהגדרות אצלי"* — it is off until he turns it on.
* An earlier session read that measurement as "the cart does not need this" and moved on. Given
  answer 1, that reading needs revisiting rather than inheriting.

**Nothing should be rebuilt on this until the guide is read and multi-capture is enabled and
measured.** Both are blocked on somebody who can open a browser and on Yakir respectively.

### 2. The fixed fee is real — but their NAME for it is not the API's
"direct market fee" is what they call it in conversation. The API field is `market_fee_fixed`;
`direct_market_fee` is **silently ignored** (measured, `payme-sandbox-notes.md` §11). PayMe accept
unknown parameters without complaint, so this distinction is worth money.

### 3. The 110% is about OUR cut, not about capture-versus-authorization
Answer 3 responds to a question that is explicitly about a fixed delivery amount. So the ceiling is a
**per-account setting they raise on request**, and the 60% we measured is its current value on our
account. `payme-sandbox-notes.md` §6 carries the full correction, including the fact that I argued
the opposite earlier the same day and was wrong.

---

## Why the linked documentation is not quoted here

Both `payme.stoplight.io` and `docs.payme.io` are the same Stoplight JavaScript application. Fetching
either returns a 447KB shell whose only readable text is the page title; the article itself is loaded
by script afterwards. Their content API is reachable — `/api/v1/projects/payme/guides/nodes/…` answers
rather than 404-ing at the route level — but the node's internal URI is not the one in the address
bar and could not be guessed.

**This is a limit on fetching, not a decision to skip documentation.** Everything of theirs that can
be read has been: the raw API spec (`payme-api-blueprint.md`), the partner agreement PDF, and — found
2026-08-23, after an earlier session had wrongly written it off as unreadable — their Hosted Fields
SDK example on GitHub, which is plain files and answered every question about the browser half.

**To close it: paste the page contents in, or export it from their site.** It is the last unread
PayMe material we know exists.
