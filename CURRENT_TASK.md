# Current Task

## Your instruction

-שורת החיפוש באתר הכללי: צריך שם דרופדאון תוצאות שמתנהג כמו שורת החיפוש שבתוך החנויות, רק שהוא מוצא חנויות ולא מוצרים.

- ההתנהגות של שורת החיפוש הכללית צריכה לעבוד אותו הדבר גם כאשר היוזר נמצא באיזור האישי שלו של הקונים.


## Next

- להתאים חוויה במודל מוצר (PQV) למובייל
- חייבים לשפר את הסרת הרקע של התמונות: דרך אחרת לעשות את זה, אולי בתוך מודל שאפשר ממש לבחור בו, צריך למצוא כלי שיעזור לנו לעשות אתזה, בנוסף לשימוש בכלי שעושה את זה כבר.
- הסרת הרקע: כרגע כשעושים חיתוך לתמונה ואז רוצים גם להסיר רקע, זה לא עובד, צריך לעשות שהעבודה על התמונה תתאפשר במקביל באספקטים שונים.
- המוכר צריך להיות מסוגל לשנות פרטים בהזמנה (כל הפרטים).
- חיבור תשלום אמיתי — Cardcom/Payme, `/api/payment/confirm` webhook, עדכון SellerBalance
- שליחת מייל לקונה ומוכר אחרי הזמנה (SendGrid/Brevo)
- דשבורד אדמין — יתרות מוכרים (earned − paid out), סימון "שולם", תור תשלומים
- ניהול מלאי: `decrementStock` אטומי עם mutex, אינטגרציית Sendit לציטוט משלוח דינמי
- Checkout tracking: `fbq InitiateCheckout` בעמוד checkout, `fbq Purchase` ב-webhook





### תשלומים — ארכיטקטורה  (ישראל בלבד)
> ✅ ההחלטה התקבלה — הפלטפורמה מחזיקה טרמינל Cardcom/Payme אחד מרכזי.
- **צ׳ק אאוט (ללא חובת הרשמה)** — כל קונה, מחובר או לא, יכול לקנות. מחובר → פרטים ממולאים מראש; לא מחובר → ממלא ידנית. שם + מייל + טלפון + כתובת → העברה לדף תשלום Cardcom/Payme → חזרה עם אישור → יצירת Order ב-`data/orders.json`.
- **webhook אישור תשלום** — `/api/payment/confirm`: מאמת חתימה מהספק, יוצר Order, מזכה `SellerBalance`, שולח מייל לקונה ולמוכר.
- **`data/orders.json`** — יצירת קובץ + `src/lib/orders.ts` עם interface Order (ראה AI_INSTRUCTIONS לפרטי השדות).
- **`data/seller-balances.json`** — יצירת קובץ + `src/lib/seller-balances.ts`: totalEarned, totalPaidOut per seller/store.
- **סקשן הזמנות בדשבורד מוכרים** — טבלת הזמנות נכנסות: תאריך, קונה, פריטים, סכום, סטטוס משלוח. מוכר מעדכן סטטוס + מספר מעקב.
- **דשבורד אדמין (`/admin`)** — יתרות מוכרים (earned − paid out), סה"כ הכנסות, תור תשלומים. סימון "שולם" = מוסיף ל-totalPaidOut.
- **התראות מוכר** — email כשנכנסת הזמנה (SMTP: SendGrid / Brevo).
- **commission %** — להגדיר ב-`store.config.ts` (`checkout.commissionPercent`). מנוכה מ-totalEarned בעת יצירת Order.

### משלוחים — ישראל בלבד
> ⚠️ ספקי משלוח ישראליים בלבד.
- **הגדרות בדשבורד מוכר** — flatRate, freeAbove, processingDays (שדות חדשים ב-`Store.shipping`).
- **חישוב מחיר משלוח ב-checkout** — קריאה מ-`store.shipping` לפי סל המוצרים של כל חנות.
- **`StoreProduct.weight`** — שדה חדש (גרמים). נדרש לציטוט Sendit. אופציונלי בשלב ראשון (flatRate מספיק).
- **אינטגרציה Sendit** (שלב שני) — `/api/shipping/quote` מחזיר מחיר דינמי לפי כתובת + משקל.
- **מעקב משלוח** — מוכר מזין מספר מעקב בדשבורד → נשלח ב-email לקונה.

### SEO (קטן, מהיר)
- **`store.url`** ב-`store.config.ts` → להחליף `https://example.com` בדומיין האמיתי (Canonical, sitemap, OG לא נכונים עד אז).
- **`store.locale`** → `he_IL` (כרגע `en_US`, משפיע על `og:locale`).
- **`robots.txt`** — להוסיף ב-`public/robots.txt` (כרגע לא קיים).

### שיווק / Tracking
- **GTM + Meta Pixel IDs** — להגדיר ב-`store.config.ts`. `ViewContent` ו-`AddToCart` כבר מוזרקים ומחכים.
- **`fbq InitiateCheckout`** — להוסיף בעמוד checkout לפני תשלום.
- **`fbq Purchase`** — להוסיף ב-`/api/payment/confirm` אחרי אישור תשלום (server-side).
- **Conversions API (Meta server-side)** — שליחת Purchase מהשרת לפי Meta CAPI. נדרש: `access_token`, `pixel_id` ב-env vars.
- **GTM container setup** — triggers: `view_item` → GA4, `add_to_cart` → GA4. ה-dataLayer כבר מוכן.
- **קידום חנות (Ads flow)** — מוכר בוחר פלטפורמה + תקציב + משך → חיוב דרך ספק הסליקה הישראלי → קמפיין ב-API (Google Ads / Meta). נדרש: `adCampaigns` על Store, UI בדשבורד, API routes.

## Recommended next step
להתאים חוויה במודל מוצר (PQV) למובייל — layout, scroll, תמונות, כפתורים.



