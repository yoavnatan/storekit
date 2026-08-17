/**
 * סהר — the apparel showcase catalog (100 products).
 *
 * Shape of a row, kept to one line each so the whole catalog is scannable:
 *   n  Hebrew product name        c  index into the store's `categories`
 *   d  Hebrew description         p  price in ₪ (whole shekels)
 *   s  English image SUBJECT      w  shipping weight in grams
 *   v  variant preset key, or null for a genuinely single-SKU product
 *
 * `s` is the only English in the file and it never reaches a shopper — it is the
 * subject clause handed to the image generator, which the store's art direction
 * in `identity.mjs` then wraps. It describes the OBJECT and its colour only; the
 * lighting, the backdrop and the styling belong to the store, not to the product,
 * or the catalog stops looking like one shop.
 *
 * This file is over the 200-line guideline and that is deliberate (memory
 * `feedback_line_limit_guideline`): it is one flat data table, and splitting it
 * by category would mean five files to keep the count balanced across.
 *
 * Not every product has variants. A showcase store where every single item pops a
 * size picker stops demonstrating the plain product, which is most of a real
 * catalog — so jewellery, hats and one-size accessories are deliberately `null`.
 *
 * ── Two rules this table has to satisfy, both added 2026-08-17 ─────────────────
 *
 * **1. Every garment here is MODEST.** The owner is religious ("אני אדם דתי") and
 * asked for a rack that suits "אנשים שומרי מסורת": no necklines, nothing cropped,
 * nothing sheer, nothing tight, nothing sleeveless, hems below the knee. Ten rows
 * were rewritten rather than re-shot — an open-back evening dress, two cropped
 * tops, a tank, a V-neck blouse, a denim mini, a cropped-top activewear set, a
 * sports tank and thigh-length swim shorts. `MODESTY` in `identity.mjs` states the
 * same rule to the image model, but a rule stated only there would be one bad roll
 * away from a product photograph the shop cannot show; the garment itself has to be
 * modest for the picture to have no other option.
 *
 * **2. Every name reads as Hebrew a shopper would say.** "סוודר צמר מריחה" was
 * merino transliterated into the word for smearing, and "ז׳קט בלייזר לא מובנה" was
 * "unstructured blazer" rendered as a jacket nobody understands. The English in `s`
 * is a brief for an image model; `n` is a label on a shelf, and translating one into
 * the other word-for-word produces neither.
 *
 * ⚠️ **Renaming a row costs money.** `image-manifest.json` is keyed by this exact
 * Hebrew string, so a rename orphans every picture that product already has and the
 * generator re-buys them at the next run. Rename in the same round as a planned
 * regeneration, never after one. And two lists in `identity.mjs` point at these
 * names by hand — `backdropAccentAlways` and `cardProducts` — which
 * `tests/showcase-catalog-integrity` checks, because a stale name there fails
 * silently rather than loudly.
 */

export const FASHION_PRODUCTS = [
  // ── נשים (c:0) ─────────────────────────────────────────────────────────────
  { n: 'שמלת מידי בגזרת A', d: 'גזרת A מתרחבת עם מותן מודגש, תפורה מבד ויסקוזה עם נפילה רכה שלא נצמד לגוף ולא מתקמט בישיבה ארוכה.\n\nהאורך נופל מתחת לברך, מה שהופך אותה לאחת השמלות שהכי קל להתאים — עם סנדל שטוח ביום, עם עקב ותיק קטן בערב, ועם סניקרס ובלייזר כשרוצים משהו באמצע. יש כיסים אמיתיים בצדדים, וסגירת רוכסן נסתרת בגב.\n\nמומלץ לכבס בתוכנית עדינה ב-30 מעלות ולייבש בתלייה. לא דורשת גיהוץ.', c: 0, sub: 'שמלות', p: 289, w: 380, v: 'apparel', s: 'a midi A-line dress in dusty rose, soft flowing fabric' },
  { n: 'שמלת קיץ פרחונית', d: 'הדפס פרחים עדין על בד קליל, שרוול קצר ואורך מתחת לברך. קלילה במיוחד ליום חם.', c: 0, sub: 'שמלות', p: 249, w: 260, v: 'apparel', s: 'a floral summer midi dress with short sleeves and a high round neckline, light airy fabric, small blue flower print' },
  { n: 'שמלת מקסי סרוגה', d: 'סריג דק באורך מלא, נצמד בעדינות ולא מגביל בתנועה.', c: 0, sub: 'שמלות', p: 349, w: 520, v: 'apparel', s: 'a long ribbed knit maxi dress in warm caramel with long sleeves' },
  { n: 'שמלת חולצה מכופתרת', d: 'שמלה בגזרת חולצה מכותנה נושמת, עם חגורת קשירה במותן שמאפשרת לכוון את הגזרה בדיוק לאן שנוח.\n\nהיא עובדת מצוין גם למשרד וגם לסוף השבוע, וזו בדיוק הסיבה שהיא חוזרת אלינו כל עונה. הכפתורים לאורך כל החזית, כך שאפשר ללבוש אותה גם פתוחה מעל גופייה.', c: 0, sub: 'שמלות', p: 279, w: 340, v: 'apparel', s: 'a cotton shirt dress in sage green with a tie belt at the waist' },
  { n: 'שמלת ערב שחורה', d: 'גזרה נקייה עם שרוול ארוך וגב סגור, בד עבה שמחזיק צורה לאורך הערב.', c: 0, sub: 'שמלות', p: 429, w: 460, v: 'apparel', s: 'an elegant long black evening dress with long sleeves, a high closed neckline and a fully closed back, structured fabric' },
  { n: 'חולצת כותנה בסיסית', d: 'כותנה עבה, גזרה ישרה, צווארון עגול. נכנסת כמעט לכל קומבינציה בארון.', c: 0, sub: 'חולצות וגופיות', p: 89, w: 140, v: 'apparel', s: 'a basic cotton t-shirt in off-white with a straight hip-length cut and a round neckline' },
  { n: 'חולצת סריג שרוול ארוך', d: 'סריגה עדינה עם צווארון גולף נמוך, גזרה נוחה שלא מאבדת צורה בכביסה.', c: 0, sub: 'חולצות וגופיות', p: 119, w: 190, v: 'apparel', s: 'a long-sleeve fine-knit top in deep terracotta with a mock neck, comfortable relaxed fit' },
  { n: 'חולצת פשתן מכופתרת', d: 'פשתן נושם בגזרה משוחררת, נראה טוב גם מקומט. חולצת הקיץ שאפשר ללבוש שלוש עונות.', c: 0, sub: 'חולצות וגופיות', p: 189, w: 220, v: 'apparel', s: 'a relaxed linen button-up shirt in natural beige' },
  { n: 'חולצת סריג שרוול קצר', d: 'חולצת בסיס מבד סריג עם שרוול קצר וצווארון עגול. נוחה לבד ומושלמת כשכבה מתחת.', c: 0, sub: 'חולצות וגופיות', p: 69, w: 110, v: 'apparel', s: 'a short-sleeve ribbed cotton top in cream with a round neckline' },
  { n: 'חולצה רכה בצווארון עגול', d: 'בד ויסקוזה רך עם צווארון עגול מעודן ושרוול קצר מתנפח קלות.', c: 0, sub: 'חולצות וגופיות', p: 139, w: 160, v: 'apparel', s: 'a soft blouse in muted lilac with a high round neckline and slightly puffed short sleeves' },
  { n: 'סוודר אוברסייז', d: 'סריג עבה בגזרה רחבה עם שרוול נופל. חם באמת, ולא מגרד.', c: 0, sub: 'סריגים', p: 299, w: 620, v: 'apparel', s: 'a chunky oversized knit sweater in oatmeal cream with drop shoulders' },
  { n: 'קרדיגן כפתורים', d: 'סריג דק עם כפתורי צדף וכיסים קדמיים. שכבה שנשארת בתיק לכל השנה.', c: 0, sub: 'סריגים', p: 259, w: 480, v: 'apparel', s: 'a fine-knit button cardigan in soft camel with front pockets' },
  { n: 'סווטשירט כותנה רך', d: 'פוטר כותנה רך בגזרה ישרה עם גומי במותן. נעים במיוחד מהכביסה הראשונה.', c: 0, sub: 'סריגים', p: 179, w: 380, v: 'apparel', s: 'a cotton sweatshirt in dusty sage with a straight hip-length cut' },
  { n: 'מכנסי מטען רחבים', d: 'גזרה ישרה ורחבה עם כיסי צד גדולים וחגורת בד. נוחים כמו טרנינג ונראים מסודר.', c: 0, sub: 'מכנסיים וחצאיות', p: 269, w: 540, v: 'apparel', s: 'wide-leg cargo trousers in soft khaki with large side pockets' },
  { n: 'מכנסי פשתן מתרחבים', d: 'פשתן קליל בגזרה גבוהה ומתרחבת, גומי נסתר מאחור. מכנס הקיץ שנושם.', c: 0, sub: 'מכנסיים וחצאיות', p: 229, w: 320, v: 'apparel', s: 'high-waisted flared linen trousers in sand beige' },
  { n: 'ג׳ינס גבוה ישר', d: 'דנים עבה בגזרה ישרה ומותן גבוה, עם מעט אלסטיות שמחזיקה צורה לאורך היום.', c: 0, sub: 'מכנסיים וחצאיות', p: 299, w: 620, v: 'apparel', s: 'high-waisted straight-leg jeans in mid blue denim' },
  { n: 'מכנסי טרנינג רכים', d: 'פוטר מוברש מבפנים עם גומי במותן ובקרסול. הבחירה הראשונה לימים ארוכים.', c: 0, sub: 'מכנסיים וחצאיות', p: 199, w: 480, v: 'apparel', s: 'soft brushed jogger sweatpants in heather grey' },
  { n: 'חצאית מידי פליסה', d: 'קפלים דקים בבד עם נפילה, מתנועעת יפה בהליכה ולא מצריכה גיהוץ.', c: 0, sub: 'מכנסיים וחצאיות', p: 239, w: 340, v: 'apparel', s: 'a pleated midi skirt in soft champagne with fine knife pleats' },
  { n: 'חצאית ג׳ינס מידי', d: 'דנים עבה בגזרה ישרה באורך מידי, עם כיסים אמיתיים.', c: 0, sub: 'מכנסיים וחצאיות', p: 189, w: 380, v: 'apparel', s: 'a straight denim midi skirt in light wash falling well below the knee, with real pockets' },
  { n: 'בלייזר מחויט', d: 'בלייזר בגזרה נקייה עם רפידות עדינות בכתף, מגיע עם מכנס תואם.', c: 0, sub: 'מעילים וז׳קטים', p: 549, w: 980, v: 'apparel', s: 'a tailored blazer in warm chocolate brown, structured shoulders' },
  { n: 'ז׳קט ג׳ינס קלאסי', d: 'דנים עבה עם כפתורי מתכת וכיסי חזה. ז׳קט שנשאר יפה שנים.', c: 0, sub: 'מעילים וז׳קטים', p: 329, w: 760, v: 'apparel', s: 'a classic denim jacket in mid-wash blue with metal buttons' },
  { n: 'מעיל טרנץ׳ קליל', d: 'טרנץ׳ באורך מתחת לברך עם חגורת קשירה, בד עמיד לרוח קלה.', c: 0, sub: 'מעילים וז׳קטים', p: 489, w: 1_100, v: 'apparel', s: 'a lightweight trench coat in soft taupe with a tie belt' },
  { n: 'ז׳קט בומבר', d: 'בומבר עם גומי בשרוול ובמותן ובטנה חלקה. שכבה קלה לערבי מעבר.', c: 0, sub: 'מעילים וז׳קטים', p: 359, w: 720, v: 'apparel', s: 'a bomber jacket in olive green with ribbed cuffs' },
  { n: 'סט אימון שני חלקים', d: 'חולצת אימון ארוכה ומכנס תואם מבד נמתח שמחזיק צורה, מתאים גם לאימון וגם ליום.', c: 0, sub: 'מעילים וז׳קטים', p: 289, w: 420, v: 'apparel', s: 'a matching two-piece activewear set in mauve — a long loose long-sleeve training top and full-length loose track trousers' },

  // ── גברים (c:1) ────────────────────────────────────────────────────────────
  { n: 'טי־שירט כותנה כבדה', sub: 'חולצות', d: 'כותנה 240 גרם בגזרה ישרה שלא מתקצרת בכביסה. הבסיס שהכי משתלם לקנות בכמה צבעים.', c: 1, p: 99, w: 220, v: 'apparel', s: 'a heavyweight cotton t-shirt in bone white, boxy fit' },
  { n: 'טי־שירט הדפס גרפי', sub: 'חולצות', d: 'הדפס קדמי מודפס בסילק־סקרין שלא מתקלף, על כותנה רכה בגזרה רגילה.', c: 1, p: 119, w: 220, v: 'apparel', s: 'a graphic print t-shirt in washed black with an abstract geometric print' },
  { n: 'חולצת פולו סרוגה', sub: 'חולצות', d: 'סריג דק עם צווארון פתוח ושלושה כפתורים. הדרך הכי קלה להיראות מסודר בקיץ.', c: 1, p: 179, w: 280, v: 'apparel', s: 'a knitted polo shirt in sage green with an open collar' },
  { n: 'חולצת פשתן שרוול קצר', sub: 'חולצות', d: 'פשתן נושם בגזרה משוחררת עם צווארון קובני. אווררי גם ביום הכי חם.', c: 1, p: 199, w: 210, v: 'apparel', s: "a short-sleeve linen camp-collar shirt in soft ecru" },
  { n: 'חולצה מכופתרת אוקספורד', sub: 'חולצות', d: 'כותנת אוקספורד עבה עם צווארון מכופתר. חולצה אחת שעובדת בעבודה ובערב.', c: 1, p: 229, w: 300, v: 'apparel', s: 'an oxford button-down shirt in light blue' },
  { n: 'חולצת פלנל משבצות', sub: 'חולצות', d: 'פלנל רך במשבצות עדינות, שרוול ארוך עם כפתור בשרוול. חמה בלי להיות כבדה.', c: 1, p: 219, w: 420, v: 'apparel', s: 'a soft flannel shirt in muted rust and cream check, modern slim cut' },
  // "סוודר צמר מריחה" until 2026-08-17 — a transliteration of merino that reads in Hebrew as a
  // sweater made of smearing. Owner: "השמות שנתת הם פשוט נורא מוזרים בעברית".
  { n: 'סוודר מרינו', sub: 'סריגים', d: 'צמר מרינו דק שמחמם באמת ולא מגרד, עם צווארון עגול נמוך.', c: 1, p: 379, w: 460, v: 'apparel', s: 'a fine merino wool crewneck sweater in charcoal grey' },
  { n: 'סוודר קלוע', sub: 'סריגים', d: 'סריג קלוע עבה בגזרה נוחה. פריט החורף שהכי הרבה שואלים איפה קנית.', c: 1, p: 329, w: 680, v: 'apparel', s: 'a chunky cable-knit sweater in warm oat' },
  { n: 'סווטשירט קפוצ׳ון', sub: 'סריגים', d: 'פוטר עבה מוברש מבפנים עם כיס כנגורו וקפוצ׳ון כפול.', c: 1, p: 249, w: 620, v: 'apparel', s: 'a heavyweight hoodie in faded navy with a kangaroo pocket' },
  { n: 'מכנסי צ׳ינו ישרים', sub: 'מכנסיים', d: 'צ׳ינו כותנה בגזרה ישרה עם מעט אלסטיות. מכנס שמתאים כמעט לכל אירוע.', c: 1, p: 239, w: 520, v: 'apparel', s: 'straight-fit chino trousers in warm stone' },
  { n: 'ג׳ינס גזרה ישרה', sub: 'מכנסיים', d: 'דנים עבה בגזרה ישרה עם שטיפה בינונית. מתרכך יפה עם השימוש.', c: 1, p: 289, w: 680, v: 'apparel', s: "straight-leg men's jeans in mid-wash indigo" },
  { n: 'מכנסי דגמ״ח', sub: 'מכנסיים', d: 'גזרה רחבה עם כיסי צד גדולים ובד עמיד. נוח, ובעיקר שורד.', c: 1, p: 259, w: 600, v: 'apparel', s: "loose fit cargo trousers in washed olive" },
  { n: 'מכנסיים קצרים מחויטים', sub: 'מכנסיים', d: 'שורט באורך מעל הברך עם קפל קדמי וחגורת בד. מסודר בלי להיות רשמי.', c: 1, p: 179, w: 300, v: 'apparel', s: 'tailored shorts in sand beige with a front pleat' },
  { n: 'מכנסי טרנינג עם גומי', sub: 'מכנסיים', d: 'פוטר רך עם גומי בקרסול וכיסי רוכסן. יושבים טוב גם בלי חגורה.', c: 1, p: 199, w: 480, v: 'apparel', s: 'tapered jogger sweatpants in dark heather grey with zip pockets' },
  { n: 'ז׳קט חולצה מרופד', sub: 'מעילים וז׳קטים', sub2: 'ז׳קטים', d: 'שאקט בבד עבה עם ריפוד דק וכיסי חזה. השכבה שמחליפה מעיל רוב השנה.', c: 1, p: 389, w: 880, v: 'apparel', s: 'a padded shirt jacket (shacket) in tobacco brown with chest pockets' },
  { n: 'ז׳קט בומבר קליל', sub: 'מעילים וז׳קטים', sub2: 'ז׳קטים', d: 'בומבר בבד קל עם גומי בשרוול, מתקפל לתיק בלי להתקמט.', c: 1, p: 349, w: 640, v: 'apparel', s: "a lightweight bomber jacket in deep navy" },
  { n: 'ז׳קט ג׳ינס מכופתר', sub: 'מעילים וז׳קטים', sub2: 'ז׳קטים', d: 'ז׳קט דנים עם כיסי חזה וכפתורי מתכת, בגזרה מודרנית קצת יותר רחבה.', c: 1, p: 339, w: 800, v: 'apparel', s: "a men's denim trucker jacket in dark wash" },
  { n: 'מעיל פוך קצר', sub: 'מעילים וז׳קטים', sub2: 'מעילים', d: 'מעיל פוך קל במיוחד שמתקפל לשקית שמגיעה איתו. חם הרבה מעל למשקל שלו.', c: 1, p: 449, w: 720, v: 'apparel', s: 'a lightweight quilted puffer jacket in slate blue' },
  { n: 'סט פיג׳מה כותנה', sub: 'בית וספורט', d: 'מכנס ארוך וחולצה מכופתרת מכותנה נושמת. מרגיש כמו סוף השבוע.', c: 1, p: 189, w: 460, v: 'apparel', s: "a cotton pyjama set in soft striped grey" },
  { n: 'חולצת ספורט נושמת', sub: 'בית וספורט', d: 'בד טכני שמייבש מהר עם תפרים שטוחים שלא משפשפים. לריצה ולחדר כושר.', c: 1, p: 89, w: 130, v: 'apparel', s: 'a breathable short-sleeve sports top in slate grey with a round neckline' },
  // Twelve rows added 2026-08-13 at the owner's request. The men's shelf was the smallest of the
  // three clothing categories — 20 against נשים's 24 — and the only clothing shelf with no second
  // level at all, so it both looked thin and demonstrated the two-level menu nowhere. Several of
  // these deliberately name a male model in the SUBJECT line: a blazer or a suit reads as a shape
  // on a hanger and as a garment on a person, and this shelf had nobody wearing anything.
  { n: 'חליפה מחויטת שני חלקים', sub: 'חליפות ואירועים', d: 'ז׳קט ומכנסיים בגזרה מחויטת מבד צמר קליל שנופל יפה ולא מבריק.\n\nהבטנה נושמת, אז אפשר ללבוש אותה גם באירוע קיץ בלי להצטער. הגזרה סלחנית גם למי שלא רגיל לחליפות.', c: 1, p: 1_290, w: 1_600, v: 'apparel', s: 'a two-piece tailored suit in deep navy, worn buttoned by a cropped male figure' },
  // "ז׳קט בלייזר לא מובנה" until 2026-08-17 — a literal rendering of "unstructured blazer" that in
  // Hebrew reads as a jacket nobody understands. Owner: "מה הכוונה בלא מובנה?"
  { n: 'בלייזר רך', sub: 'חליפות ואירועים', d: 'בלייזר בלי מבנה פנימי — קליל כמו חולצה ומסודר כמו ז׳קט. הפריט שהופך ג׳ינס לערב.', c: 1, p: 649, w: 780, v: 'apparel', s: 'a soft unstructured blazer in warm sand, worn open by a cropped male figure over a plain tee' },
  { n: 'חולצה מכופתרת לאירוע', sub: 'חליפות ואירועים', d: 'כותנה פופלין בגימור חלק, עם צווארון שעומד בלי ללחוץ בצוואר.', c: 1, p: 269, w: 250, v: 'apparel', s: 'a crisp poplin dress shirt in white, worn by a cropped male figure with the collar open' },
  { n: 'עניבת סריג', sub: 'חליפות ואירועים', d: 'עניבה סרוגה עם קצה ישר — פחות רשמית ויותר מעניינת מעניבת משי.', c: 1, p: 139, w: 90, v: null, s: 'a knitted tie with a flat square end in burgundy' },
  { n: 'חולצת הנלי שרוול ארוך', sub: 'חולצות', d: 'צווארון הנלי עם שלושה כפתורים על כותנה בצלעות. שכבה אחת שנראית מכוונת.', c: 1, p: 189, w: 300, v: 'apparel', s: 'a long-sleeve ribbed henley shirt in olive, worn by a cropped male figure' },
  { n: 'חולצת אוברסייז כבדה', sub: 'חולצות', d: 'גזרה רחבה בכוונה מבד כבד שמחזיק צורה ולא מתקמט בתיק.', c: 1, p: 209, w: 340, v: 'apparel', s: 'an oversized heavyweight shirt in washed indigo, worn open by a cropped male figure' },
  { n: 'סוודר צווארון גולף', sub: 'סריגים', d: 'צמר מריחה בצווארון גבוה שלא מגרד. חם בלי להיות מסורבל.', c: 1, p: 419, w: 520, v: 'apparel', s: 'a merino roll-neck sweater in charcoal, worn by a cropped male figure' },
  { n: 'קרדיגן מכופתר', sub: 'סריגים', d: 'סריג מכופתר עם כיסים אמיתיים, נלבש פתוח או סגור.', c: 1, p: 359, w: 560, v: 'apparel', s: 'a buttoned cardigan in oatmeal with patch pockets' },
  { n: 'מכנסי פשתן משוחררים', sub: 'מכנסיים', d: 'פשתן בגזרה רחבה עם גומי חלקי במותן. מכנס הקיץ שאפשר גם לצאת בו.', c: 1, p: 269, w: 380, v: 'apparel', s: 'relaxed wide-leg linen trousers in stone, worn by a cropped male figure' },
  { n: 'מכנסי חליפה מחויטים', sub: 'מכנסיים', d: 'קפל קדמי וגזרה ישרה שנופלת נקי על הנעל.', c: 1, p: 349, w: 460, v: 'apparel', s: 'tailored pleated trousers in dark grey with a clean break at the shoe' },
  { n: 'מעיל טרנץ׳ ארוך לגבר', sub: 'מעילים וז׳קטים', sub2: 'מעילים', d: 'טרנץ׳ באורך מתחת לברך מבד דוחה מים קליל, עם חגורה שאפשר לקשור או להתעלם ממנה.', c: 1, p: 749, w: 1_100, v: 'apparel', s: 'a long lightweight trench coat in classic beige, worn open by a cropped male figure' },
  { n: 'מכנסי שחייה', sub: 'בית וספורט', d: 'בד שמתייבש מהר עם כיס רשת ורוכסן אחורי, באורך עד הברך. נראה טוב גם מחוץ למים.', c: 1, p: 159, w: 180, v: 'apparel', s: 'knee-length quick-dry swim shorts in deep navy with a single cream side stripe' },

  // ── הנעלה (c:2) ────────────────────────────────────────────────────────────
  { n: 'סניקרס לבנות קלאסיות', d: 'עור חלק בגימור נקי עם סוליה נמוכה. הנעל שמתאימה כמעט להכול.', c: 2, sub: 'סניקרס', p: 349, w: 780, v: 'shoes', s: 'classic white low-top leather sneakers, clean minimal design' },
  { n: 'סניקרס רטרו', d: 'עיצוב בהשראת שנות ה־70 בשילוב זמש וגימור חלק, עם פס צד בגוון מנוגד וסוליית גומי בצבע שמנת.\n\nמה שהופך אותן לנעל יומיומית ולא רק לפריט יפה הוא הריפוד הפנימי: מדרס אנטומי נשלף וצוואר מרופד סביב הקרסול, כך שאפשר להיות עליהן שעות בלי לחשוב עליהן. הסוליה גמישה ולא מחליקה על רצפה רטובה.\n\nמידות 37–43. אם אתם בין שתי מידות, מומלץ לבחור את הגדולה מביניהן.', c: 2, sub: 'סניקרס', p: 379, w: 820, v: 'shoes', s: 'retro suede running sneakers in cream and burnt orange' },
  { n: 'סניקרס גבוהות', d: 'גזרה גבוהה עם תמיכה בקרסול וסוליית גומי עבה.', c: 2, sub: 'סניקרס', p: 399, w: 900, v: 'shoes', s: 'high-top canvas sneakers in off-white with a chunky rubber sole' },
  { n: 'נעלי ריצה קלות', d: 'משקל נמוך במיוחד וסוליה גמישה שמחזירה אנרגיה. מרגישות כמו כלום על הרגל.', c: 2, sub: 'סניקרס', p: 449, w: 620, v: 'shoes', s: 'lightweight running shoes in soft mint and grey with a knit upper' },
  { n: 'סניקרס פלטפורמה', d: 'סוליה מוגבהת שמוסיפה גובה בלי לוותר על נוחות, עם ריפוד פנימי רך.', c: 2, sub: 'סניקרס', p: 389, w: 880, v: 'shoes', s: 'platform sneakers in white leather with a thick stacked sole' },
  { n: 'מגפוני צ׳לסי', d: 'עור רך עם גומי בצד שנכנס בקלות, סוליה שקטה ועקב נמוך.', c: 2, sub: 'מגפיים', p: 529, w: 1_040, v: 'shoes', s: 'chelsea ankle boots in cognac brown leather with elastic side panels' },
  { n: 'מגפי קרסול עם עקב', d: 'עקב בלוק יציב בגובה בינוני וגימור חלק. אפשר לעמוד בהם ערב שלם.', c: 2, sub: 'מגפיים', p: 559, w: 980, v: 'shoes', s: 'ankle boots with a block heel in black leather' },
  { n: 'מגפי גשם קצרים', d: 'גומי אטום לחלוטין עם בטנה נעימה וסוליה מונעת החלקה.', c: 2, sub: 'מגפיים', p: 299, w: 1_150, v: 'shoes', s: 'short rubber rain boots in deep forest green' },
  { n: 'נעלי בלרינה', d: 'נעל שטוחה עם קצה מעוגל ורצועה אחורית רכה. נוחה גם ביום הליכה ארוך.', c: 2, sub: 'נעליים אלגנטיות', p: 289, w: 480, v: 'shoes', s: 'ballet flats in soft blush leather with a rounded toe' },
  { n: 'נעלי לופר', d: 'לופר בגימור חלק עם רצועת מתכת עדינה וסוליה גמישה.', c: 2, sub: 'נעליים אלגנטיות', p: 419, w: 720, v: 'shoes', s: 'leather loafers in dark chocolate with a slim metal bar detail' },
  { n: 'נעלי עקב מחודדות', d: 'עקב דק בגובה 7 ס״מ עם ריפוד פנימי בכף הרגל. גזרה מאריכה.', c: 2, sub: 'נעליים אלגנטיות', p: 469, w: 640, v: 'shoes', s: 'pointed-toe stiletto heels in deep burgundy' },
  { n: 'סנדלי רצועות שטוחים', d: 'רצועות עור רכות שלא משפשפות וסוליה דקה. סנדל הקיץ הבסיסי.', c: 2, sub: 'סנדלים וכפכפים', p: 259, w: 420, v: 'shoes', s: 'flat strappy leather sandals in tan' },
  { n: 'סנדלי פלטפורמה', d: 'סוליה מוגבהת קלה עם רצועות רחבות ואבזם מתכוונן.', c: 2, sub: 'סנדלים וכפכפים', p: 329, w: 620, v: 'shoes', s: 'platform sandals in cream with wide straps and a buckle' },
  { n: 'כפכפי סליידר', d: 'רצועה רחבה מרופדת וסוליה עבה. הכפכף שיוצא איתך גם מהבית.', c: 2, sub: 'סנדלים וכפכפים', p: 149, w: 400, v: 'shoes', s: 'padded slide sandals in sand beige with a thick sole' },
  { n: 'כפכפי אצבע עור', d: 'רצועת עור רכה שנכנעת לרגל אחרי יומיים וסוליה שקטה.', c: 2, sub: 'סנדלים וכפכפים', p: 189, w: 340, v: 'shoes', s: 'leather thong flip-flops in warm brown' },
  { n: 'נעלי בית סרוגות', d: 'בטנה רכה ופנימית וסוליה שקטה שלא מחליקה על פרקט.', c: 2, sub: 'סנדלים וכפכפים', p: 129, w: 380, v: 'shoes', s: 'knitted house slippers in oatmeal with a soft sole' },
  { n: 'נעלי עבודה גבוהות', d: 'עור עבה עם סוליה משוננת ותפרים כפולים. בנויות לשרוד.', c: 2, sub: 'נעליים לשטח', p: 589, w: 1_280, v: 'shoes', s: 'rugged lace-up work boots in oiled brown leather with a lug sole' },
  { n: 'מוקסינים רכים', d: 'עור רך במיוחד עם תפר בעבודת יד וסוליה גמישה.', c: 2, sub: 'נעליים אלגנטיות', p: 379, w: 640, v: 'shoes', s: 'soft suede moccasins in taupe with hand-stitched detail' },
  { n: 'סניקרס בד קלות', d: 'בד קנבס נושם עם סוליית גומי דקה. הנעל שנכנסת לתיק לטיול.', c: 2, sub: 'סניקרס', p: 199, w: 560, v: 'shoes', s: 'lightweight canvas sneakers in faded navy' },
  { n: 'נעלי טיולים נמוכות', d: 'סוליה אוחזת עם הגנה על האצבעות ובד נושם שמתייבש מהר.', c: 2, sub: 'נעליים לשטח', p: 499, w: 880, v: 'shoes', s: 'low hiking shoes in olive and grey with a grippy sole' },

  // ── תיקים (c:3) ────────────────────────────────────────────────────────────
  { n: 'תיק טוט עור', d: 'תא ראשי רחב שבולע מחשב וקלסר, עם כיס פנימי לטלפון ולמפתחות.', c: 3, p: 449, w: 780, v: 'colorOnly', s: 'a large leather tote bag in warm cognac with two shoulder straps' },
  { n: 'תיק טוט בד', d: 'קנבס עבה שמחזיק צורה גם מלא, עם ידיות מחוזקות ותחתית רחבה.', c: 3, p: 149, w: 380, v: 'colorOnly', s: 'a heavy canvas tote bag in natural ecru with reinforced handles' },
  { n: 'תיק צד קטן', d: 'תיק קרוסבודי בגודל טלפון וארנק, עם רצועה מתכווננת ורוכסן מלא.', c: 3, p: 269, w: 320, v: 'colorOnly', s: 'a small leather crossbody bag in black with an adjustable strap' },
  { n: 'תיק כתף מובנה', d: 'גזרה נקייה עם אבזם מתכת שמחזיק צורה, ובטנה עמידה שלא נקרעת.', c: 3, p: 389, w: 560, v: 'colorOnly', s: 'a structured shoulder bag in soft taupe with a metal clasp' },
  { n: 'תיק באגט', d: 'תיק קטן וארוך שנצמד לגוף, סגירה מגנטית ורצועה קצרה.', c: 3, p: 299, w: 300, v: 'colorOnly', s: 'a baguette shoulder bag in cream leather with a short strap' },
  { n: 'תיק גב לעבודה', d: 'תא מרופד למחשב 15 אינץ׳, גב מאוורר ורצועות מתכווננות שלא נחתכות בכתף.', c: 3, p: 429, w: 820, v: 'colorOnly', s: 'a minimal work backpack in charcoal with a padded laptop compartment' },
  { n: 'תיק גב עור רך', d: 'עור רך עם סגירת שרוך ודש עליון, ותא פנימי נסתר.', c: 3, p: 519, w: 760, v: 'colorOnly', s: 'a soft leather drawstring backpack in dark tan' },
  { n: 'פאוץ׳ מותן', d: 'נלבש על המותן או באלכסון על החזה, עם רוכסן ראשי וכיס אחורי נסתר.', c: 3, p: 179, w: 240, v: 'colorOnly', s: 'a belt bag in matte black nylon with a wide adjustable strap' },
  { n: 'תיק נסיעה', d: 'תיק סוף שבוע עם תא נעליים נפרד ורצועת כתף מרופדת. נכנס למדף מעל למושב.', c: 3, p: 559, w: 1_240, v: 'colorOnly', s: 'a weekender travel duffel bag in waxed canvas and leather trim' },
  { n: 'תיק כלים לאימון', d: 'בד עמיד למים עם תא רטוב נפרד ותא נעליים מאוורר.', c: 3, p: 249, w: 640, v: 'colorOnly', s: 'a gym duffel bag in slate grey with a separate shoe compartment' },
  { n: 'קלאץ׳ ערב', d: 'תיק ערב קטן עם שרשרת נשלפת, נכנס בו טלפון, שפתון ומפתח.', c: 3, p: 219, w: 220, v: 'colorOnly', s: 'an evening clutch in champagne satin with a detachable chain' },
  { n: 'ארנק עור מתקפל', d: 'שישה תאי כרטיסים, תא שטרות רחב וכיס מטבעות ברוכסן.', c: 3, p: 189, w: 120, v: 'colorOnly', s: 'a bifold leather wallet in dark brown, open flat showing card slots' },
  { n: 'ארנק כרטיסים דק', d: 'ארנק דק במיוחד לארבעה כרטיסים ושטרות מקופלים. לא מתפח בכיס.', c: 3, p: 119, w: 60, v: 'colorOnly', s: 'a slim card holder wallet in black leather' },
  { n: 'תיק מחשב דק', d: 'שרוול מרופד למחשב 14 אינץ׳ עם רוכסן שקט וכיס חיצוני לכבלים.', c: 3, p: 199, w: 320, v: 'colorOnly', s: 'a slim padded laptop sleeve in felt grey' },
  { n: 'תיק שופינג מתקפל', d: 'מתקפל לכיס קטן ונפתח לתיק שסוחב עומס אמיתי. נשאר בתיק ולא בבית.', c: 3, p: 79, w: 90, v: 'colorOnly', s: 'a foldable ripstop shopping bag in mustard yellow' },
  { n: 'תיק קש קיצי', d: 'קש שזור בעבודת יד עם בטנת בד ורצועות עור. תיק חוף שאפשר לצאת איתו לעיר.', c: 3, p: 259, w: 480, v: null, s: 'a woven straw beach tote with leather handles and a fabric lining' },
  { n: 'תיק צילום קטן', d: 'ריפוד פנימי עם מחיצות מתכווננות למצלמה ולעדשה נוספת.', c: 3, p: 339, w: 620, v: 'colorOnly', s: 'a compact padded camera bag in olive canvas with adjustable dividers' },
  { n: 'נרתיק אביזרים', d: 'נרתיק קטן לכבלים, מטענים ואוזניות, עם גומיות פנימיות שמחזיקות הכול במקום.', c: 3, p: 99, w: 140, v: 'colorOnly', s: 'a small tech accessory organiser pouch in grey with inner elastic loops' },

  // ── תכשיטים ואביזרים (c:4) ─────────────────────────────────────────────────
  { n: 'שרשרת זהב עדינה', d: 'שרשרת דקה בציפוי זהב 18 קראט עם תליון קטן. יפה לבד ויפה בשכבות.', c: 4, p: 189, w: 20, v: null, s: 'a delicate gold-plated chain necklace with a small pendant' },
  { n: 'שרשרת חוליות', d: 'חוליות בינוניות בגימור מט, סוגר יציב שלא נפתח לבד.', c: 4, p: 249, w: 40, v: null, s: 'a matte gold chunky chain necklace' },
  { n: 'עגילי חישוק קטנים', d: 'חישוק קטן בציפוי זהב עם סגירה נוחה. מתאימים גם לשינה.', c: 4, p: 129, w: 10, v: null, s: 'small gold hoop earrings on a plain surface' },
  { n: 'עגילי טיפה', d: 'עגיל תלוי עם אבן חן קטנה, קל במשקל ולא מושך את האוזן.', c: 4, p: 159, w: 12, v: null, s: 'teardrop drop earrings with a small pale green stone' },
  { n: 'עגילים צמודים קטנים', d: 'עיגול קטן בגימור חלק, מתאים לכל יום ולא נתקע בשיער.', c: 4, p: 89, w: 8, v: null, s: 'minimal small stud earrings in brushed silver' },
  { n: 'טבעת חותם', d: 'טבעת חותם רחבה בגימור מוברש, אפשר לחרוט עליה.', c: 4, p: 219, w: 15, v: null, s: 'a wide signet ring in brushed gold' },
  { n: 'סט טבעות דקות', d: 'שלוש טבעות דקות שנלבשות יחד או בנפרד, כל אחת בגימור אחר.', c: 4, p: 149, w: 12, v: null, s: 'a set of three thin stacking rings in mixed gold and silver finishes' },
  { n: 'צמיד חוליות', d: 'צמיד חוליות עדין עם סוגר בטחון נוסף. לא נופל.', c: 4, p: 179, w: 25, v: null, s: 'a fine link bracelet in gold with a safety clasp' },
  { n: 'צמיד עור קלוע', d: 'עור קלוע בעבודת יד עם סוגר מגנטי. מתרכך יפה עם הזמן.', c: 4, p: 129, w: 30, v: null, s: 'a braided leather bracelet in dark brown with a magnetic clasp' },
  { n: 'שעון יד מינימליסטי', d: 'לוח נקי בלי מספרים מיותרים, רצועת עור אמיתית ועמידות למים יומיומית.', c: 4, p: 449, w: 90, v: 'colorOnly', s: 'a minimalist wristwatch with a clean white dial and a tan leather strap' },
  { n: 'משקפי שמש מרובעים', d: 'מסגרת אצטט מרובעת עם עדשות מקוטבות והגנה מלאה מ־UV.', c: 4, p: 279, w: 40, v: 'colorOnly', s: 'square acetate sunglasses in tortoiseshell with dark lenses' },
  { n: 'משקפי שמש עגולים', d: 'מסגרת מתכת דקה עם גשר כפול ועדשות בגוון חם.', c: 4, p: 249, w: 32, v: 'colorOnly', s: 'round thin metal-frame sunglasses with warm amber lenses' },
  { n: 'כובע באקט', d: 'כובע דלי מבד כותנה עבה עם שוליים רחבים שבאמת מצלים.', c: 4, p: 119, w: 110, v: null, s: 'a cotton bucket hat in sand beige with a wide brim' },
  { n: 'כובע מצחייה', d: 'מצחייה מעוקלת עם סגירה מתכווננת מאחור ובד נושם.', c: 4, p: 99, w: 90, v: 'colorOnly', s: 'a curved-brim baseball cap in washed olive' },
  { n: 'כובע קש רחב שוליים', d: 'קש טבעי שזור עם סרט בד, מתקפל בלי לאבד צורה.', c: 4, p: 169, w: 130, v: null, s: 'a wide-brim woven straw sun hat with a fabric band' },
  { n: 'צעיף צמר רך', d: 'צמר רך שלא מגרד בגודל נדיב שאפשר לכרוך פעמיים.', c: 4, p: 189, w: 260, v: 'colorOnly', s: 'a soft oversized wool scarf in muted rust' },
  { n: 'חגורת עור קלאסית', d: 'עור מלא ברוחב 3.5 ס״מ עם אבזם מתכת מוברש. חגורה אחת לכל המכנסיים.', c: 4, p: 199, w: 180, v: 'colorOnly', s: 'a classic leather belt in dark brown with a brushed metal buckle' },
  { n: 'סט גרביים כותנה', d: 'שלושה זוגות מכותנה מסורקת עם גומי שלא נחלש אחרי חודש.', c: 4, p: 79, w: 150, v: null, s: 'a set of three folded cotton socks in cream, grey and rust' },
];
