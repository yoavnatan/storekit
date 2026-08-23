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

## ⚠️ Still to ask them — three questions, and each one may remove work rather than add it

Written here rather than in a task list because the pattern this file exists to record is that
**PayMe's apparent limitations keep turning out to be settings.** Multi-capture read as "not enabled"
and was a switch plus a wrong endpoint. Do not design around any of these before asking.

0. **⚠️ FOR THE INTEGRATION CALL — raise this even though our design works.** The owner asked for
   this to stay open (2026-08-23): *"אני מרגיש שיש פה משהו שאני לא מבין… אם לא כדאי לדבר עם מי
   שיעזור לנו עם האינטגרציה בפועל — לעשות את מה שהוא תיאר עם הלכידה 110%"*. **He is right to keep
   it open, and the reason is not that our design is unsound.**

   What we built: authorize goods + delivery TOGETHER, then capture each store's goods and capture
   the delivery to our own merchant. Total drawn = 100% of the authorization. Measured working, and
   it needs nothing from PayMe.

   What PayMe described: authorize the sale, then capture past it — *"לכידה בשווי 500 ש״ח שהם 100%…
   להעלות ל-110%"* — which only makes sense if the delivery is NOT inside the authorized amount.

   Both reach the same place. **The question worth asking the person who does the real integration
   is why they described it the other way round**, because a vendor's recommended pattern usually
   encodes something the API does not state: a settlement rule, an issuer behaviour, a chargeback
   consequence, or how the two shapes appear on a cardholder's statement. Ours has been proved to
   work in the sandbox; that is not the same as knowing it is the shape they support in production.

   Ask it as: *"we authorize goods + delivery together and capture within 100% — you described
   authorizing the sale and capturing past it at 110%. Is there a reason to prefer yours?"*

1. **Can the PARTNER account accept card payments?** `174 · אפשרות זו אינה נתמכת במשתמשים מסוג זה`
   describes a *type*, which is a setting. If yes, the delivery fee has somewhere to land and both
   workarounds in `payme-sandbox-notes.md` §15 disappear.
2. ~~**Which ceiling is the 110% offer about?**~~ **ANSWERED — it is the capture ceiling, and the
   arithmetic is the proof: ₪300 of goods plus ₪30 of delivery is 110% of ₪300.** See "What this
   settles" §3. Our design authorizes goods and delivery together and captures 100%, so it needs no
   raise; and it stays clear of the separate 60% cap on our commission by capturing delivery to our
   own merchant. Nothing to ask.
3. **Enable multi-capture on the sandbox key**, if it is not already: it worked when called
   correctly, but whether that was because it is on for us or because the sandbox is permissive is
   not established.

---

## What this settles

### 1. Their answer to "several sellers in one purchase" is MULTI-CAPTURE — and the checkout is built on it
The question was explicit and so is the answer: the guide they linked is *multi-capture for credit
cards*, whose own prerequisite reads *"at least 2 users from the same marketplace"*. One
authorization on the buyer's card, drawn down by one capture per seller.

`lib/payment-split.ts` was rebuilt on it on 2026-08-23, after it was measured working across two
sellers. It had been one permanent token charged as N separate sales — which also worked, and was
not what the vendor considers the answer.

⚠️ An earlier session recorded multi-capture as "not enabled on our key". It had called
`capture-sale`, the single-capture endpoint. `payme-sandbox-notes.md` §14 has the measurements.

### 2. The fixed fee is real — but their NAME for it is not the API's
"direct market fee" is what they call it in conversation. The API field is `market_fee_fixed`;
`direct_market_fee` is **silently ignored** (measured, `payme-sandbox-notes.md` §11). PayMe accept
unknown parameters without complaint, so this distinction is worth money.

### 3. ✅ RESOLVED — and the resolution is that PayMe's own suggestion does not scale
Three sessions argued about which of the two ceilings their "110%" referred to. The owner settled it
in two steps, and the second step is the one that matters.

**First he read the arithmetic plainly:** ₪300 of goods plus ₪30 of delivery is ₪330 — 110% of ₪300.
So the number is the CAPTURE ceiling: their model authorizes the goods and then captures past the
authorization to pull the delivery through.

**Then he broke it:** *"אבל 20 שקל ועוד 30 שקל משלוח זה לא 110 אחוז."* Correct. That is **250%**. And
₪10 with ₪30 of delivery is 400%.

**So "110%" is an example Yakir happened to pick, not a formula.** Under their model the ceiling
that would actually be required is `(goods + delivery) / goods`, which rises without bound as the
item gets cheaper — so no single setting fixes it, and a marketplace selling small items would keep
discovering new failures at new price points. It is the same shape as the 60% market-fee cap, which
also bites hardest on a cheap item with real delivery.

**Our design has no such dependency.** Authorize goods AND delivery together, capture exactly 100%
of that, and the ratio between them never enters the arithmetic. Delivery is captured to our own
merchant account rather than folded into the seller's sale, so the 60% cap does not enter it either
(`payme-sandbox-notes.md` §18). Nothing has to be raised, at any price point.

⚠️ **This does not close question 0 above.** Knowing why they described the other shape is still
worth a sentence on the integration call — a vendor recommending a pattern usually knows something
the API does not state. But it is now a question about their reasoning, not about a limit we need.

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
