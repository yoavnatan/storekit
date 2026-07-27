# תוכנית מעבר למסד נתונים אמיתי

> מסמך תוכנית (לא משימה מיידית). נכתב 2026-07-27 אחרי סריקה של כל שכבת הנתונים בפועל.
> מופנה מ-`AI_INSTRUCTIONS.md` → Hard rules → Scalability, ומ-`GO_LIVE_CHECKLIST.md` סעיף 6.
> משלים את `CONTEXTUAL_SEARCH_STRATEGY.md` — החיפוש הסמנטי תלוי במעבר הזה.

**בשורה אחת:** Postgres, סכימה מנורמלת חוץ ממה שבאמת לא צריך, אינדקסים ואילוצים נכתבים
באותה מיגרציה שיוצרת את הטבלה, והמעבר נעשה מודול-מודול מאחורי חתימות הפונקציות הקיימות.

---

## 1. מה יש היום (מצב בפועל, נמדד)

19 קבצי JSON ב-`data/`, 25 מודולי `lib/*.ts` שקוראים/כותבים אותם. הגדולים:
`store-products.json` (834 מוצרים, 720K), `orders.json` (210 הזמנות, 296K),
`stores.json` (42), `sellers.json` (46), `messages.json` (72), `store-categories.json` (130).

הקבצים מתחלקים לשני סוגים, וזה משנה איך מהגרים אותם:

| סוג | קבצים | הופך ל- |
|---|---|---|
| **מערך רשומות** | stores, store-products, orders, sellers, messages, notifications, store-categories, ad-campaigns, admin-messages, error-log | טבלה רגילה, שורה לרשומה |
| **אובייקט לפי מפתח** (דלי) | store-pageviews, product-pageviews, analytics-events, wishlist-counts, store-favorite-counts, user-carts, admin-tab-views, platform-ads | לא טבלה אחת-לאחת — ראה §5 |

**מה כבר עובד לטובתנו:** כל הגישה לנתונים כבר מרוכזת ב-`lib/*.ts` כפונקציות adapter נקיות,
ה-IDs כבר `crypto.randomUUID()` (לא מונים רצים — אין התנגשות בייבוא), ופריטי ההזמנה כבר
שומרים snapshot של שם/מחיר/תמונה. שלושת אלה חוסכים את רוב הכאב.

---

## 2. איזה DB — Postgres

**לא SQLite.** שתי סיבות שנוגעות ישירות לקוד הקיים:
1. **כתיבות בכל בקשה.** ה-middleware כותב היום ב-3 מקומות על כל טעינת עמוד
   (`recordPageView`, `recordProductView`, `recordAnalyticsEvent`). SQLite הוא כותב-יחיד;
   זה בדיוק דפוס העומס שיחנוק אותו.
2. **חיפוש וקטורי.** `CONTEXTUAL_SEARCH_STRATEGY.md` דורש embeddings + vector search.
   `pgvector` הוא הרחבה של Postgres — בחירה ב-DB בלי זה תכפה מיגרציה שנייה בעוד חצי שנה.

בונוס: `JSONB` נותן לשמור בדיוק את השדות שלא שווה לנרמל (`specs`, `variants`) בלי לוותר
על שאילתות עליהם, ו-full-text search בעברית זמין מיידית.

**אירוח:** Neon / Supabase / RDS — כל אחד מהם. **חובה pooler** (§7 סעיף 12).

---

## 3. העיקרון: החתימות לא משתנות

כל מודול ב-`lib/` נשאר עם אותן פונקציות מיוצאות ואותם טיפוסים. רק הפנימיות מתחלפות:
`readFileSync` + `filter` → שאילתה. ככה אף עמוד, API או קומפוננטה לא נוגעים בשינוי,
ו-410 הטסטים הקיימים הם רשת הביטחון.

```
getStoreBySlug(slug)  →  SELECT * FROM stores WHERE slug = $1
```

**חריג אחד שחייב לשבור את הכלל** — פונקציות `getAll*()` שמחזירות הכל:
`getAllOrders()`, `getAllStores()`, `readProducts()`, `getMessagesBySeller()`.
היום זה בסדר (210 הזמנות); ב-100,000 הזמנות פונקציה שמחזירה הכל לזיכרון היא באג.
**במעבר הן חייבות לקבל פרמטרי סינון/עימוד ולדחוף אותם לשאילתה.** רשימת הקוראים שלהן
כבר קצרה — `admin-stats.ts`, `seller-performance.ts`, `platform-performance.ts` — וכולם
ממילא עושים אגרגציה שה-DB יעשה טוב יותר (`SUM`/`GROUP BY` במקום `reduce`).

---

## 4. סכימה — הטבלאות

### ליבה
```
sellers(id uuid pk, name, email citext unique, password_hash, google_id unique,
        tier text, created_at timestamptz)

stores(id uuid pk, seller_id → sellers, slug citext unique, name, tagline, description,
       colors jsonb, categories text[], shipping jsonb, banner_image, profile_image,
       address, address_visible bool, hours jsonb, hours_visible bool,
       blocked bool default false, promo_weight int default 0,
       bg_colors text[], feed_sync jsonb, feed_export_token,
       custom_domain_hostname citext unique, custom_domain_status, custom_domain_added_at,
       created_at timestamptz)

store_previous_slugs(slug citext pk, store_id → stores, replaced_at)
```
**`previousSlugs` יוצא מהמערך לטבלה משלו** — זה מה שהופך את חיפוש ה-301 לשליפה רגילה
עם אינדקס רגיל, במקום אינדקס GIN על מערך. גם `isSlugTaken` נהיה בדיקה אחת מול שתי טבלאות.
**`customDomain` נפרס לשלוש עמודות** ולא נשאר JSONB — כי `hostname` הוא השליפה הכי חמה
באפליקציה (§6), ואי אפשר לאנדקס אותו טוב בתוך JSONB.

### קטלוג
```
store_categories(id uuid pk, store_id → stores, parent_id → store_categories, name, position)

store_products(id uuid pk, store_id → stores, slug citext, name, description,
               price_agorot bigint, stock int, sku, category_id → store_categories,
               hidden bool default false, blocked bool default false,
               tags text[], specs jsonb, variants jsonb, created_at,
               UNIQUE (store_id, slug),
               UNIQUE (store_id, sku) WHERE sku IS NOT NULL)

product_images(product_id → store_products, position int, url, cloudinary_public_id,
               PRIMARY KEY (product_id, position))

product_variant_stock(product_id → store_products, combo_key text, stock int,
                      PRIMARY KEY (product_id, combo_key))
```
**`variantStock` חייב לצאת מה-JSON לטבלה** — זו הטבלה היחידה שבה `UPDATE` אטומי מחליף
את ה-Mutex (§7 סעיף 5). `variants` (הגדרת המימדים) נשאר JSONB כי אף פעם לא שולפים לפיו.

### כסף
```
orders(id uuid pk, buyer_name, buyer_email, buyer_phone, buyer_address, buyer_id → sellers,
       shipping_agorot bigint, total_agorot bigint,
       payment_ref text UNIQUE, payment_status, shipping_status, tracking_number,
       created_at, updated_at)

order_items(id uuid pk, order_id → orders, product_id, product_name, product_slug,
            store_slug, store_name, price_agorot bigint, qty int, image,
            selected_variants jsonb)

order_stores(order_id → orders, store_slug, store_name,
             subtotal_agorot bigint, shipping_agorot bigint, delivery_method,
             seller_note, PRIMARY KEY (order_id, store_slug))
```
**`order_items` שומר snapshot ולא FK למוצר** — זה כבר המצב היום ו**אסור לתקן את זה**
במעבר. אם ההזמנה תצביע על המוצר החי, שינוי מחיר ישכתב היסטוריה פיננסית.
זו הטעות הקלאסית ב"נרמול" של הזמנות.

### שאר
```
messages, admin_messages, notifications, ad_campaigns, brand_campaigns, error_log
```
כולם המרה ישירה אחת-לאחת של המערך הקיים.

---

## 5. הדליים — מה שלא ממירים אחד-לאחד

ארבעה קבצים הם דלי יומי, ותרגום נאיבי שלהם יוצר בעיה:

**`store-pageviews` / `product-pageviews` / `analytics-events`** — היום כל דלי יומי מחזיק
**מערך של כל מזהי המבקרים** של אותו יום (`visitors: [...]`), כדי לספור מבקרים ייחודיים.
מדדתי: יום עמוס אחד כבר מחזיק 359 מזהים. **זה גדל בלי גבול** — ב-10,000 מבקרים ליום זו
שורה עם 10,000 ערכים שנקראת ונכתבת מחדש בכל טעינת עמוד.

הפתרון:
```
page_view_events(store_id → stores, product_id, visitor_id, day date, occurred_at,
                 UNIQUE (store_id, product_id, visitor_id, day))
page_view_daily(store_id, product_id, day, total int, uniques int,
                PRIMARY KEY (store_id, product_id, day))
```
הכתיבה נהיית `INSERT ... ON CONFLICT DO NOTHING` (שורה אחת, בלי לקרוא כלום),
והספירה נהיית `COUNT(*)` / `COUNT(DISTINCT visitor_id)`. `page_view_daily` הוא
rollup לילי שמאפשר למחוק את ה-events הגולמיים אחרי 90 יום בלי לאבד היסטוריה.

**`wishlist-counts` / `store-favorite-counts`** — היום מונים שמורים. מונה שמור **תמיד**
נסחף מהאמת בסופו של דבר. במעבר הם הופכים ל-`COUNT(*)` על טבלאות ה-wishlist/favorites
האמיתיות; אם זה יאט (לא יאט בסקייל הזה) — `COUNT` עם אינדקס, ורק אם באמת צריך, מונה
מתוחזק בטריגר.

**`user-carts`** → `cart_items(user_id, store_slug, product_id, variant_key, qty, added_at)`
ו-`wishlist_items(user_id, product_id)`. עגלה כאובייקט מקונן אחד לכל משתמש היא כתיבה של
כל העגלה בכל שינוי כמות.

---

## 6. אינדקסים — הרשימה המדויקת

נכתבים **באותה מיגרציה שיוצרת את הטבלה**. להוסיף אינדקס לטבלה ריקה זה חינם; להוסיף
אותו לטבלה עמוסה בפרודקשן זו פעולה חוסמת.

**החמים ביותר — רצים על כל בקשת עמוד** (מ-`middleware.ts`):
| אינדקס | מי משתמש |
|---|---|
| `stores(custom_domain_hostname)` unique | `getStoreByCustomDomain` — כל בקשה, כולל בקשות שאינן חנות |
| `stores(slug)` unique | `getStoreBySlug` — כל טעינת חנות/מוצר |
| `store_previous_slugs(slug)` pk | פתרון 301 + `isSlugTaken` |
| `store_products(store_id, slug)` unique | כל טעינת עמוד מוצר |

**תכופים:**
`store_products(store_id) WHERE NOT hidden AND NOT blocked` (חלקי — כל רשת מוצרים) ·
`order_items(order_id)` · `order_stores(store_slug)` (לוח המוכר) · `orders(created_at DESC)` ·
`orders(buyer_email)` · `messages(seller_id, read)` · `notifications(user_id, read)` ·
`store_categories(store_id, parent_id)` · `page_view_daily(store_id, day)` ·
`cart_items(user_id)`.

**איך מוודאים שהם באמת נתפסים:** `EXPLAIN ANALYZE` על השאילתה. הפלט אומר `Index Scan`
(תקין) או `Seq Scan` (סורק הכל — האינדקס לא בשימוש). להריץ על ארבע השורות החמות אחרי
המיגרציה. זו בדיקה של חמש דקות שמונעת אתר איטי עם משתמשים אמיתיים.

---

## 7. מקרי קצה — למנוע מראש, לא לגלות אחר כך

כל אחד מאלה נבדק מול הדאטה בפועל.

1. **סלאג של מוצר ייחודי רק בתוך חנות.** מדדתי: **47 סלאגים כפולים** בין חנויות
   (`product`, `product-2`, `-`), **אפס** כפילויות בתוך אותה חנות. אילוץ `UNIQUE(slug)`
   גלובלי **יפיל את הייבוא בשורה הראשונה**. חייב להיות `UNIQUE(store_id, slug)`.
2. **SKU רק 2 מוצרים מתוך 834 מחזיקים.** האילוץ חייב להיות חלקי
   (`WHERE sku IS NOT NULL`), אחרת NULL-ים מתנגשים בחלק מהמנועים.
3. **שורות ישנות בפורמט אחר.** `store-pageviews` מחזיק גם `64` (מספר) וגם
   `{total, visitors[]}` (אובייקט) — שתי גרסאות של אותו שדה. סקריפט הייבוא חייב לנרמל,
   לא להניח. אותו סוג בעיה בכל שדה שנוסף מאוחר (`hidden`, `categoryId`, `sku` חסרים ברוב המוצרים).
4. **התנגשות סלאג בין שני מוכרים בו-זמנית.** היום `createStore` בודק-ואז-כותב — מרוץ אמיתי
   שקיים בקוד. **לתקן במעבר:** לא לבדוק מראש, אלא לנסות `INSERT`, לתפוס את הפרת ה-unique
   ולנסות `foo-2`. ה-DB הוא הסמכות היחידה שלא יכולה לפספס.
5. **מלאי — כאן ה-Mutex מת.** `decrementStock` היום מוגן ב-Mutex בתהליך אחד; זה נשבר ברגע
   שרצים שני שרתים. במעבר:
   ```sql
   UPDATE product_variant_stock SET stock = stock - $qty
   WHERE product_id = $id AND combo_key = $k AND stock >= $qty
   ```
   מספר השורות שהושפעו הוא התשובה: 0 = אין מלאי, דחה. אין מרוץ, בלי נעילה, בכל מספר שרתים.
   זה גם מה שמאפשר לבטל את `mutex.ts`.
6. **כפילות תשלום.** `UNIQUE(payment_ref)` על `orders`. webhook שנשלח פעמיים (וזה קורה)
   ייכשל על האילוץ במקום ליצור הזמנה שנייה. זה הבסיס לסעיף 2 ב-`CURRENT_TASK`.
7. **כסף בשלמים, לא בשברים.** היום המחירים הם `number` של JS ויש `Math.round(x*100)/100`
   פזור בקוד. **לאחסן אגורות כמספר שלם** (`price_agorot`). זה מוחק מחלקה שלמה של באגי
   עיגול שמתגלים רק כשמישהו מתלונן על שקל.
8. **אזור זמן.** הדליים היומיים ממופתחים במחרוזת תאריך מקומית. אם ה-DB ב-UTC והחישוב
   בישראל, גבול היום זז ב-3 שעות והדוחות לא יסתדרו. **לקבע `Asia/Jerusalem`** בהמרה
   לתאריך ולתעד את זה.
9. **מחיקות מדורגות — להחליט במפורש לכל קשר.** מחיקת חנות: מוצרים/קטגוריות/קמפיינים
   `ON DELETE CASCADE`. **הזמנות לעולם לא** — `RESTRICT`, זו רשומה פיננסית. חנות שנמחקת
   ויש לה הזמנות → סימון `deleted_at`, לא מחיקה.
10. **תמונות — 20,000 ומעלה.** התמונות יושבות ב-Cloudinary; ה-DB מחזיק רק כתובות
    (1,997 היום, מקסימום 4 למוצר). המגבלה האמיתית היא תוכנית Cloudinary ומספר
    הטרנספורמציות, לא ה-DB. **לשמור גם `cloudinary_public_id` ולא רק URL** — בלעדיו אי
    אפשר למחוק תמונה יתומה או להחליף טרנספורמציה בהמשך.
11. **`citext` לסלאגים ולמיילים.** אחרת `Acme` ו-`acme` הן שתי חנויות, ומייל בהרשמה
    יוצר חשבון כפול.
12. **Connection pooling — הסיבה מספר 1 ל"עבד בפיתוח, נפל בפרודקשן".** שרת Node שפותח
    חיבור לכל בקשה ימצה את מגבלת החיבורים של Postgres תוך דקות. חובה pool בגודל קבוע
    (או pgBouncer בהוסטינג serverless). להגדיר את זה **ביום הראשון**, לא אחרי הנפילה.

---

## 8. סדר העבודה

**שלב 0 — תשתית (יום).** Postgres מקומי ב-docker-compose, כלי מיגרציות
(Drizzle/Kysely/node-pg-migrate — כל אחד), חיבור ב-`.env`, pool.
**וגם: להקים CI כאן** — קובץ אחד ב-`.github/workflows/` שמריץ `npm ci` + `npx tsc --noEmit` + `npm test`
על כל push. עד היום הבדיקות רצו כי Claude מריץ אותן ידנית לפני דיווח, וזה מספיק כשיש סשן אחד
שנוגע בהכל; שלב 2 הוא ענף ארוך על פני הרבה סשנים, ושם "מישהו זכר לבדוק" מפסיק להיות אמין.
CI גם מתקין מאפס, כלומר תופס תלות שקיימת מקומית אבל חסרה ב-`package.json`. ~15 שורות, פעם אחת.

**שלב 1 — סכימה + ייבוא (יום-יומיים).** מיגרציה אחת שיוצרת הכל **כולל האינדקסים
והאילוצים**, וסקריפט `scripts/import-json-to-db.mjs` שקורא את `data/*.json` וכותב.
הסקריפט חייב להיות **ניתן להרצה חוזרת** (`ON CONFLICT DO NOTHING`) כדי שאפשר יהיה
לתקן ולהריץ שוב בלי לאפס. הוא גם מקום הנרמול של סעיף 7.3.

**שלב 2 — החלפת מודולים, אחד-אחד (החלק הארוך).** לפי סדר תלות:
`sellers` → `stores` → `store-categories` → `store-products` → `orders` →
`messages`/`notifications` → הדליים → השאר.
אחרי כל מודול: `npx tsc` + `npm test`. הטסטים הקיימים הם שער האיכות — אם מודול הוחלף
נכון, הם עוברים בלי שינוי.

**שלב 3 — ניקוי.** מחיקת `data/*.json` והקוראים שלהם, מחיקת `mutex.ts`,
הרצת `EXPLAIN ANALYZE` על ארבע השאילתות החמות, בדיקת עומס בסיסית.

**שלב 4 — מה שנפתח עכשיו.** scheduler לסנכרון מלאי (GO_LIVE §6.1 מחכה בדיוק לזה),
ו-`pgvector` + embeddings לחיפוש הסמנטי (`CONTEXTUAL_SEARCH_STRATEGY.md`) — פרויקט נפרד,
אבל ה-DB כבר יתמוך בו.

**לעבוד בענף.** באמצע שלב 2 האפליקציה שבורה; `git checkout main` מחזיר גרסה עובדת
תוך שנייה. ראה גם `GO_LIVE_CHECKLIST.md` §7 (deploy בלי נפילות) — כלל התאימות-לאחור
של הסכימה חל מהרגע שיש פרודקשן.

---

## 9. איך יודעים שזה יצא חלק

1. **410 הטסטים עוברים בלי שינוי.** אם טסט נשבר, המודול לא הוחלף נכון (או שנמצא באג אמיתי).
2. **`EXPLAIN ANALYZE` מראה `Index Scan`** על ארבע השליפות החמות של §6.
3. **השוואת ספירות** אחרי הייבוא: מספר הרשומות בכל טבלה = מספר הרשומות בקובץ המקור.
   סקריפט של 20 שורות, תופס ייבוא חלקי מיד.
4. **סכום כסף זהה.** `SELECT SUM(total_agorot) FROM orders` מול הסכום מה-JSON —
   הבדיקה היחידה שמוכיחה שהמרת האגורות לא איבדה כלום.
5. **בדיקת מלאי בו-זמנית.** לירות 50 רכישות מקבילות של מוצר עם מלאי 10 ולוודא
   שבדיוק 10 הצליחו. זה הטסט שמוכיח שסעיף 7.5 עובד.
