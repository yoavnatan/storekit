/**
 * לופט — the home & design showcase catalog (100 products).
 *
 * Row shape is identical to `catalog-fashion.mjs`; read that header for it.
 *
 * This is the store that carries the platform's WEIGHT and BULK cases: an
 * armchair at 18kg and a ceramic mug at 320g go through the same shipping
 * calculator, and a showcase catalog where everything weighs half a kilo proves
 * nothing about it. The heavy rows here are also why this is the one store with
 * `selfPickup: true` — the pickup path in checkout has to be reachable in a real
 * store, not merely described.
 *
 * Israel 2026, concretely (owner): the balcony is a room, hosting at a big table
 * is the centre of the week, and apartments are small — so this catalog leans
 * outdoor-and-hosting where an imported one would lean fireplace-and-basement.
 */

export const HOME_PRODUCTS = [
  // ── ריהוט (c:0) ────────────────────────────────────────────────────────────
  { n: 'כורסת בד מרופדת', d: 'מושב עמוק עם ריפוד בד עמיד ורגלי עץ אלון מלא. נוחה לשעה של קריאה ולא רק להיראות טוב.', c: 0, p: 1_490, w: 18_000, v: 'colorHome', s: 'an upholstered lounge armchair in warm oatmeal fabric with solid oak legs' },
  { n: 'ספה תלת מושבית', d: 'שלושה מושבים עם ריפוד עמיד לשפשוף וכריות גב נשלפות לכביסה.', c: 0, p: 4_290, w: 48_000, v: 'colorHome', s: 'a three-seat sofa in soft clay-coloured fabric with removable back cushions' },
  { n: 'ספת דו מושבית קומפקטית', d: 'רוחב 150 ס״מ שנכנס גם לסלון קטן, בלי לוותר על עומק מושב אמיתי.', c: 0, p: 2_890, w: 32_000, v: 'colorHome', s: 'a compact two-seat sofa in sage green fabric' },
  { n: 'שולחן אוכל עץ מלא', d: 'אלון מלא באורך 180 ס״מ שמושיב שישה בנוח. גימור שמן שמתחדש בעצמך.', c: 0, p: 3_490, w: 42_000, v: null, s: 'a solid oak dining table with a natural oil finish, clean tapered legs' },
  { n: 'שולחן אוכל מתארך', d: 'נפתח מארבעה לשישה סועדים בתנועה אחת. פתרון לדירה שמארחת יותר ממה שיש בה מקום.', c: 0, p: 2_990, w: 38_000, v: null, s: 'an extendable dining table in pale ash wood' },
  { n: 'כיסא אוכל מרופד', d: 'מושב מרופד עם מסעד גב מעוקל שתומך בגב התחתון, ורגלי עץ יציבות.', c: 0, p: 449, w: 6_500, v: 'colorHome', s: 'an upholstered dining chair in bouclé cream fabric with wooden legs' },
  { n: 'כיסא אוכל עץ', d: 'עץ מלא בעיצוב נקי, נערם בקלות ולא חורק אחרי שנה.', c: 0, p: 379, w: 5_200, v: null, s: 'a solid wood dining chair with a curved backrest, minimal design' },
  { n: 'שרפרף בר מתכוונן', d: 'גובה מתכוונן עם משענת רגליים וסיבוב 360 מעלות. מתאים לאי במטבח.', c: 0, p: 549, w: 8_400, v: 'colorHome', s: 'an adjustable-height bar stool with a leather seat and black metal base' },
  { n: 'שולחן קפה עגול', d: 'משטח עגול בקוטר 80 ס״מ עם מדף תחתון נוסף. לא תופס את כל הסלון.', c: 0, p: 890, w: 14_000, v: null, s: 'a round coffee table in light oak with a lower shelf' },
  { n: 'שולחן צד קטן', d: 'שולחן צד צר שנכנס ליד הכורסה או ליד המיטה, משטח שיש מלאכותי עמיד.', c: 0, p: 429, w: 6_800, v: 'colorHome', s: 'a small side table with a marble-look top and a slim metal frame' },
  { n: 'שידת מגירות', d: 'ארבע מגירות על מסילות שקטות עם סוגר עצירה. גימור שלא מראה טביעות אצבע.', c: 0, p: 1_290, w: 26_000, v: 'colorHome', s: 'a four-drawer wooden dresser in warm walnut with soft-close runners' },
  { n: 'שידת לילה', d: 'מגירה אחת ומדף פתוח, בגובה שמתאים למיטה סטנדרטית.', c: 0, p: 499, w: 9_000, v: 'colorHome', s: 'a bedside nightstand in pale oak with one drawer and an open shelf' },
  { n: 'כוננית ספרים פתוחה', d: 'חמישה מדפים בגובה 180 ס״מ, כולל רצועת קיר לייצוב. מדפים שנושאים ספרים אמיתיים.', c: 0, p: 1_190, w: 24_000, v: null, s: 'an open five-shelf bookcase in light wood against a plaster wall' },
  { n: 'מדף קיר צף', d: 'מדף עץ מלא עם תושבת נסתרת, מגיע עם דיבלים לקיר בטון.', c: 0, p: 189, w: 2_400, v: 'sizeHome', s: 'a floating wooden wall shelf with a hidden bracket' },
  { n: 'ספסל כניסה עם אחסון', d: 'מושב מרופד עם תא אחסון מתחת לנעליים. פותר את הכניסה לדירה.', c: 0, p: 749, w: 12_000, v: 'colorHome', s: 'an entryway storage bench with a padded seat and a shoe compartment underneath' },
  { n: 'עגלת הגשה על גלגלים', d: 'שתי קומות עם ידית ונעילת גלגלים, עוברת מהמטבח למרפסת.', c: 0, p: 389, w: 5_600, v: 'colorHome', s: 'a two-tier rolling serving cart in matte black metal' },
  { n: 'שולחן מרפסת מתקפל', d: 'עץ אקציה מטופל לחוץ, מתקפל ונשען על הקיר בחורף.', c: 0, p: 590, w: 9_800, v: null, s: 'a folding acacia wood balcony table, treated for outdoor use' },
  { n: 'כיסא מרפסת נערם', d: 'נערם בערימה של ארבעה, עמיד לשמש ולא דוהה אחרי קיץ.', c: 0, p: 279, w: 4_200, v: 'colorHome', s: 'a stackable outdoor balcony chair in sand-coloured weather-resistant material' },
  { n: 'ספסל מרפסת דו מושבי', d: 'שני מושבים בבד חוץ שמתייבש מהר, עם מסגרת מתכת מגולוונת.', c: 0, p: 1_190, w: 16_000, v: 'colorHome', s: 'a two-seat outdoor balcony bench with quick-dry cushions and a galvanised frame' },
  { n: 'שולחן עבודה צר', d: 'עומק 50 ס״מ שנכנס לפינה, עם מעבר כבלים אחורי ומדף תחתון.', c: 0, p: 899, w: 15_000, v: null, s: 'a narrow home office desk in oak with a cable pass-through' },

  // ── תאורה (c:1) ────────────────────────────────────────────────────────────
  { n: 'מנורת רצפה קשת', d: 'זרוע מעוקלת שמביאה אור אל מעל הספה בלי לקדוח בתקרה.', c: 1, p: 890, w: 8_200, v: 'colorHome', s: 'an arc floor lamp with a brushed brass stem and a linen shade' },
  { n: 'מנורת רצפה טריפוד', d: 'שלוש רגלי עץ ואהיל בד, אור חם שממלא פינה שלמה.', c: 1, p: 649, w: 6_400, v: 'colorHome', s: 'a tripod floor lamp with wooden legs and a natural linen shade' },
  { n: 'מנורת שולחן קרמיקה', d: 'בסיס קרמיקה יצוק עם אהיל בד, מתג על הכבל.', c: 1, p: 349, w: 2_800, v: 'colorHome', s: 'a ceramic table lamp with a rounded terracotta base and a cream fabric shade' },
  { n: 'מנורת קריאה מתכווננת', d: 'זרוע מפרקית שמכוונת בדיוק לספר ולא לעיניים, עם ראש מסתובב.', c: 1, p: 289, w: 2_100, v: 'colorHome', s: 'an adjustable articulated reading lamp in matte black' },
  { n: 'מנורה תלויה מעל שולחן', d: 'גוף מתכת רחב שמפזר אור על כל רוחב השולחן, כולל כבל באורך מתכוונן.', c: 1, p: 559, w: 3_400, v: 'colorHome', s: 'a wide pendant lamp in matte olive metal hanging above a dining table' },
  { n: 'מנורה תלויה ראטן', d: 'ראטן שזור שמטיל צללית יפה על התקרה. קלה במיוחד לתלייה.', c: 1, p: 429, w: 1_600, v: null, s: 'a woven rattan pendant lamp casting a patterned shadow' },
  { n: 'שלישיית מנורות תלויות', d: 'שלושה גופים בגבהים שונים על מסילה אחת, לאי במטבח.', c: 1, p: 899, w: 5_200, v: 'colorHome', s: 'a set of three pendant lamps at different heights over a kitchen island' },
  { n: 'מנורת קיר ספוט', d: 'ספוט מכוון עם התקנה על הקיר, מדגיש תמונה או פינת קריאה.', c: 1, p: 219, w: 1_100, v: 'colorHome', s: 'a directional wall spot light in brushed brass' },
  { n: 'מנורת לילה עם עמעם', d: 'עוצמת אור מתכווננת בנגיעה, אור חם שלא מעיר את מי שכבר ישן.', c: 1, p: 179, w: 900, v: 'colorHome', s: 'a small touch-dimmable bedside lamp with a warm glow' },
  { n: 'פנס מרפסת סולארי', d: 'נטען מהשמש ונדלק לבד עם החשכה, עמיד לגשם.', c: 1, p: 149, w: 700, v: null, s: 'a solar-powered lantern for a balcony, warm light, weather resistant' },
  { n: 'שרשרת אורות למרפסת', d: 'עשרה מטר עם נורות LED חמות ועמידות למים. משנה מרפסת בערב אחד.', c: 1, p: 129, w: 800, v: 'sizeHome', s: 'a string of warm outdoor festoon lights along a balcony railing' },
  { n: 'מנורת שולחן עבודה', d: 'זרוע ארוכה עם ראש רחב וטמפרטורת אור מתחלפת. לא עושה בוהק על המסך.', c: 1, p: 329, w: 1_800, v: 'colorHome', s: 'a modern desk lamp with a wide head and a long arm in soft white' },
  { n: 'נורות לד חמות', d: 'שלוש נורות בגוון 2700K שמחזיקות שנים. אור חם ולא בית חולים.', c: 1, p: 69, w: 220, v: null, s: 'three warm-white LED light bulbs' },
  { n: 'עמעם קיר מסתובב', d: 'מחליף מפסק קיים ומאפשר לכוון עוצמה. התקנה של רבע שעה.', c: 1, p: 119, w: 180, v: null, s: 'a rotary wall dimmer switch in matte white' },
  { n: 'נר לד נטען', d: 'להבה מרצדת בלי אש אמיתית, נטען ב-USB ומחזיק ערב שלם.', c: 1, p: 89, w: 240, v: 'sizeHome', s: 'a rechargeable LED candle with a flickering warm flame' },
  { n: 'מנורת שידה עם טעינה', d: 'משטח טעינה אלחוטית מובנה בבסיס, כדי שיהיה כבל אחד פחות ליד המיטה.', c: 1, p: 289, w: 1_400, v: 'colorHome', s: 'a bedside lamp with a built-in wireless charging pad in its base' },
  { n: 'גוף תאורה צמוד תקרה', d: 'גוף שטוח וצנוע לחדר שירות או למסדרון, אור אחיד בלי צל.', c: 1, p: 199, w: 1_200, v: null, s: 'a flush ceiling light fixture, slim and round, in white' },
  { n: 'מנורת רצפה מינימלית', d: 'עמוד דק עם ראש מכוון, תופסת פחות ממחצית מטר רבוע.', c: 1, p: 469, w: 4_800, v: 'colorHome', s: 'a slim minimalist floor lamp with an adjustable head in warm grey' },

  // ── קרמיקה וכלי הגשה (c:2) ────────────────────────────────────────────────
  { n: 'סט צלחות עיקריות', d: 'שש צלחות אבנית בגימור מט עם שפה מוגבהת קלות. בטוחות למדיח ולמיקרוגל.', c: 2, p: 349, w: 4_800, v: 'colorHome', s: 'a set of six matte stoneware dinner plates in warm sand' },
  { n: 'סט צלחות מנה ראשונה', d: 'שש צלחות קטנות בגוון תואם, נערמות נמוך ולא תופסות ארון.', c: 2, p: 259, w: 3_200, v: 'colorHome', s: 'a set of six small stoneware side plates in muted olive' },
  { n: 'קערות מרק עמוקות', d: 'ארבע קערות עמוקות שמחזיקות חום, נוחות גם לפסטה ולסלט אישי.', c: 2, p: 289, w: 3_600, v: 'colorHome', s: 'four deep ceramic soup bowls in cream with a speckled glaze' },
  { n: 'קערת הגשה גדולה', d: 'קערה רחבה שמושכת עין באמצע שולחן, מספיקה לסלט לשמונה.', c: 2, p: 219, w: 2_400, v: 'colorHome', s: 'a large wide ceramic serving bowl in terracotta' },
  { n: 'ספלי קפה אבנית', d: 'ארבעה ספלים בגימור מט עם ידית נוחה, שומרים על חום.', c: 2, p: 189, w: 1_800, v: 'colorHome', s: 'four matte stoneware coffee mugs in muted clay tones' },
  { n: 'כוסות זכוכית עבה', d: 'שש כוסות זכוכית עבה שעומדות במדיח ובחיים. מתאימות לחם ולקר.', c: 2, p: 149, w: 2_600, v: null, s: 'six thick clear glass tumblers' },
  { n: 'כוסות יין', d: 'שש כוסות בגזרה נקייה עם רגל דקה, זכוכית שקופה במיוחד.', c: 2, p: 219, w: 2_200, v: null, s: 'six clear stemmed wine glasses with a fine rim' },
  { n: 'קנקן זכוכית עם מכסה', d: 'ליטר וחצי עם מסננת מובנית לפירות או לנענע.', c: 2, p: 129, w: 1_200, v: null, s: 'a glass pitcher with a lid and a built-in infuser' },
  { n: 'קנקן קרמיקה', d: 'קנקן יצוק בגימור מט, יפה גם ריק על השיש.', c: 2, p: 169, w: 1_400, v: 'colorHome', s: 'a matte ceramic pitcher in soft sage' },
  { n: 'מגש הגשה עץ', d: 'עץ מלא עם ידיות חרוטות ושוליים מוגבהים. עובר מהמטבח למרפסת בלי לשפוך.', c: 2, p: 189, w: 1_600, v: 'sizeHome', s: 'a solid wood serving tray with carved handles and a raised lip' },
  { n: 'מגש שיש מלאכותי', d: 'משטח קר שמתאים לגבינות ולקינוחים, קל לניקוי.', c: 2, p: 229, w: 2_800, v: null, s: 'a marble-look serving board for cheese' },
  { n: 'קרש חיתוך והגשה', d: 'עץ אקציה עבה עם תעלת ניקוז היקפית, מגיש ישר מהקרש.', c: 2, p: 149, w: 1_800, v: 'sizeHome', s: 'a thick acacia cutting and serving board with a juice groove' },
  { n: 'סט כלי אוכל נירוסטה', d: 'עשרים וארבעה חלקים בגימור מוברש, כבדים מספיק כדי להרגיש טוב ביד.', c: 2, p: 349, w: 2_400, v: null, s: 'a 24-piece brushed stainless steel cutlery set arranged neatly' },
  { n: 'סט כלי הגשה גדולים', d: 'כף וסכין הגשה עם ידיות עץ. הפריט שתמיד חסר כשמארחים.', c: 2, p: 129, w: 600, v: null, s: 'a serving spoon and fork set with wooden handles' },
  { n: 'סיר הגשה חרס', d: 'חרס מזוגג שנכנס לתנור ומגיע לשולחן חם. מתאים לתבשילים ארוכים.', c: 2, p: 289, w: 3_400, v: 'colorHome', s: 'a glazed clay casserole dish with a lid, oven to table' },
  { n: 'צלוחיות מזה', d: 'שש צלוחיות קטנות לסלטים ולרטבים, נערמות זו בזו.', c: 2, p: 139, w: 1_600, v: 'colorHome', s: 'six small stackable ceramic dip bowls in mixed earth tones' },
  { n: 'כלי לחלה', d: 'מגש מוארך עם שוליים נמוכים, מתאים גם ללחם וגם למאפים.', c: 2, p: 179, w: 1_500, v: 'colorHome', s: 'an oblong ceramic bread platter with a low rim' },
  { n: 'מלחייה ופלפלייה', d: 'זוג קרמיקה עם מנגנון טחינה מתכוונן. יושבות טוב על שולחן מסודר.', c: 2, p: 119, w: 700, v: 'colorHome', s: 'a ceramic salt and pepper grinder pair' },
  { n: 'סט תה קרמיקה', d: 'קנקן תה עם מסננת ושני ספלים תואמים, שומר חום זמן אמיתי.', c: 2, p: 259, w: 2_200, v: 'colorHome', s: 'a ceramic teapot with a strainer and two matching cups' },
  { n: 'כלי אחסון קרמיקה', d: 'שלושה כלים אטומים בגדלים עולים, לקפה, לסוכר ולתה.', c: 2, p: 199, w: 2_600, v: 'colorHome', s: 'three ceramic storage canisters with sealed lids in graduated sizes' },
  { n: 'כוסות אספרסו', d: 'ארבע כוסות קטנות עם דופן עבה שמחזיקה חום ולא שורפת את היד.', c: 2, p: 99, w: 900, v: 'colorHome', s: 'four small thick-walled espresso cups' },
  { n: 'בקבוק שמן זית', d: 'בקבוק זכוכית כהה עם פייה מונעת טפטוף. שומר על השמן מהאור.', c: 2, p: 89, w: 800, v: null, s: 'a dark glass olive oil bottle with a drip-free spout' },

  // ── טקסטיל (c:3) ───────────────────────────────────────────────────────────
  { n: 'שטיח סלון שטוח', d: 'אריגה שטוחה שלא אוגרת אבק, מתאימה גם מתחת לשולחן אוכל.', c: 3, p: 1_290, w: 14_000, v: 'sizeHome', s: 'a flat-weave living room rug in sand and clay geometric pattern' },
  { n: 'שטיח צמר רך', d: 'צמר עבה שנעים לדרוך עליו יחף, עם מרקם עדין בגוון אחיד.', c: 3, p: 1_690, w: 18_000, v: 'sizeHome', s: 'a thick soft wool rug in warm oatmeal' },
  { n: 'שטיח כניסה', d: 'סיבים עמידים שמנקים את הנעל, עם גב שלא מחליק.', c: 3, p: 189, w: 2_800, v: null, s: 'a durable entryway doormat in natural coir with a dark border' },
  { n: 'כרית נוי פשתן', d: 'ציפית פשתן רחיצה עם רוכסן נסתר, מגיעה עם מילוי.', c: 3, p: 149, w: 700, v: 'colorHome', s: 'a linen throw cushion in muted terracotta' },
  { n: 'כרית נוי סרוגה', d: 'סריג עבה עם מרקם בולט, מוסיפה חום לספה בלי לשנות צבע.', c: 3, p: 169, w: 800, v: 'colorHome', s: 'a chunky knitted throw cushion in cream' },
  { n: 'כרית ישיבה למרפסת', d: 'בד חוץ שמתייבש מהר עם קשירה לכיסא. שורדת קיץ שלם בשמש.', c: 3, p: 129, w: 900, v: 'colorHome', s: 'an outdoor seat cushion with ties, in sage quick-dry fabric' },
  { n: 'שמיכת חבל סרוגה', d: 'סריג עבה בגודל נדיב שמכסה שניים על הספה.', c: 3, p: 349, w: 2_200, v: 'colorHome', s: 'a chunky knitted throw blanket in warm oat draped over a sofa arm' },
  { n: 'שמיכת פיקה קלה', d: 'כותנה נושמת לקיץ הישראלי, מכסה בלי לחמם יותר מדי.', c: 3, p: 259, w: 1_600, v: 'colorHome', s: 'a light cotton waffle-weave summer blanket in soft white' },
  { n: 'סט מצעים כותנה', d: 'סדין, ציפה ושתי ציפיות מכותנה מסורקת בצפיפות גבוהה. מתרכך עם כל כביסה.', c: 3, p: 449, w: 2_400, v: 'colorHome', s: 'a folded cotton bedding set in warm sand' },
  { n: 'סט מצעי פשתן', d: 'פשתן רחיץ שנראה טוב גם לא מגוהץ, ומווסת חום בקיץ ובחורף.', c: 3, p: 749, w: 2_800, v: 'colorHome', s: 'a washed linen bedding set in muted olive, casually rumpled' },
  { n: 'כרית שינה אנטומית', d: 'קצף זיכרון בגובה שתומך בצוואר, עם ציפית נשלפת לכביסה.', c: 3, p: 219, w: 1_400, v: 'sizeHome', s: 'a contoured memory foam pillow with a removable cover' },
  { n: 'מפת שולחן פשתן', d: 'פשתן רחיץ באורך שמתאים לשולחן שישה, לא נדבק ולא מחליק.', c: 3, p: 279, w: 900, v: 'colorHome', s: 'a washed linen tablecloth in natural flax on a wooden table' },
  { n: 'ראנר לשולחן', d: 'רץ אריג בגוון תואם, מספיק לשולחן שבת בלי לכסות את העץ.', c: 3, p: 129, w: 400, v: 'colorHome', s: 'a woven table runner in clay tones on a bare wood table' },
  { n: 'מפיות בד', d: 'שש מפיות פשתן רחיצות, מחליפות לגמרי את הנייר בשולחן אירוח.', c: 3, p: 149, w: 500, v: 'colorHome', s: 'six folded linen napkins in soft sand' },
  { n: 'סט מגבות מקלחת', d: 'שתי מגבות גדולות ושתי קטנות מכותנה סופגת שלא מתקשה.', c: 3, p: 259, w: 2_200, v: 'colorHome', s: 'a stack of folded cotton bath towels in warm grey' },
  { n: 'שטיחון אמבטיה', d: 'ספיגה מהירה עם גב מונע החלקה, מתייבש בין מקלחת למקלחת.', c: 3, p: 119, w: 900, v: 'colorHome', s: 'an absorbent cotton bath mat in cream with a non-slip backing' },
  { n: 'וילון אטום', d: 'בד עבה שחוסם אור בוקר, עם לולאות נסתרות למוט.', c: 3, p: 289, w: 2_600, v: 'colorHome', s: 'a blackout curtain panel in warm greige with hidden loops' },
  { n: 'וילון שקוף מסנן', d: 'בד קליל שמפזר אור חזק בלי להחשיך את החדר.', c: 3, p: 179, w: 1_100, v: 'colorHome', s: 'a sheer light-filtering curtain panel in off-white' },
  { n: 'סל כביסה בד', d: 'סל מתקפל עם מסגרת פנימית שמחזיקה צורה וידיות מחוזקות.', c: 3, p: 139, w: 1_100, v: 'colorHome', s: 'a collapsible fabric laundry basket in natural cotton with handles' },
  { n: 'כיסוי לספה', d: 'כיסוי נמתח שמתאים לספה תלת מושבית, רחיץ במכונה.', c: 3, p: 329, w: 1_800, v: 'colorHome', s: 'a stretch sofa cover in warm taupe' },

  // ── עיצוב ואקססוריז (c:4) ─────────────────────────────────────────────────
  { n: 'אגרטל קרמיקה גבוה', d: 'צוואר צר שמחזיק זר גם בלי לסדר אותו. גימור מט אחיד.', c: 4, p: 189, w: 1_800, v: 'colorHome', s: 'a tall matte ceramic vase with a narrow neck in warm clay' },
  { n: 'אגרטל זכוכית שקוף', d: 'זכוכית עבה בגזרה רחבה, יפה עם ענף בודד ועם זר מלא.', c: 4, p: 129, w: 1_400, v: 'sizeHome', s: 'a wide clear glass vase with thick walls' },
  { n: 'שלישיית אגרטלים קטנים', d: 'שלושה גדלים בגוונים תואמים, עובדים יחד על מדף או בנפרד.', c: 4, p: 159, w: 1_200, v: 'colorHome', s: 'a set of three small ceramic bud vases in graduated earth tones' },
  { n: 'עציץ קרמיקה עם צלוחית', d: 'חור ניקוז וצלוחית תואמת. גודל שמתאים לצמח בית בינוני.', c: 4, p: 149, w: 2_200, v: 'sizeHome', s: 'a ceramic plant pot with a matching saucer in speckled cream' },
  { n: 'עציץ עם רגליים', d: 'עציץ מוגבה על שלוש רגלי עץ, מרים צמח מהרצפה.', c: 4, p: 229, w: 2_800, v: 'colorHome', s: 'a raised plant pot on three wooden legs' },
  { n: 'צמח נוי מלאכותי', d: 'עלים בגימור מט שנראים אמיתיים מקרוב, בלי טיפול ובלי שמש.', c: 4, p: 189, w: 1_600, v: 'sizeHome', s: 'a realistic artificial olive branch plant in a simple pot' },
  { n: 'מראה עגולה', d: 'מסגרת דקה בקוטר 60 ס״מ עם תלייה מוכנה. מגדילה מסדרון צר.', c: 4, p: 349, w: 4_200, v: 'colorHome', s: 'a round wall mirror with a thin brass frame' },
  { n: 'מראה מלבנית מוארכת', d: 'מראה גוף בגובה 150 ס״מ, נשענת על הקיר או נתלית.', c: 4, p: 549, w: 9_000, v: 'colorHome', s: 'a tall rectangular full-length mirror leaning against a plaster wall' },
  { n: 'שעון קיר מינימליסטי', d: 'לוח נקי בלי מספרים ומנגנון שקט לגמרי. לא נשמע בלילה.', c: 4, p: 179, w: 800, v: 'colorHome', s: 'a minimalist silent wall clock with a clean face and thin hands' },
  { n: 'סט נרות ריחניים', d: 'שלושה נרות שעווה טבעית בכלי זכוכית, זמן בעירה של 30 שעות כל אחד.', c: 4, p: 199, w: 1_400, v: null, s: 'a set of three scented candles in amber glass jars' },
  { n: 'פמוטים מודרניים', d: 'שלושה פמוטים בגבהים שונים מאותה משפחת גימור.', c: 4, p: 169, w: 1_600, v: 'colorHome', s: 'three modern candle holders at different heights in brushed brass' },
  { n: 'מפזר ריח קני במבוק', d: 'מפזר עם קנים טבעיים שמחזיק חודשיים, ריח עדין ולא מתקתק.', c: 4, p: 139, w: 700, v: null, s: 'a reed diffuser in a small glass bottle with natural rattan sticks' },
  { n: 'סל אחסון קלוע', d: 'סל שזור בעבודת יד עם ידיות, מסתיר שמיכות או צעצועים בסלון.', c: 4, p: 179, w: 1_400, v: 'sizeHome', s: 'a handwoven storage basket with handles in natural seagrass' },
  { n: 'ארגונית שולחן עץ', d: 'תאים בגדלים שונים לעטים, למשקפיים ולמפתחות. מסדרת כניסה או שולחן.', c: 4, p: 129, w: 900, v: null, s: 'a wooden desk organiser with compartments of different sizes' },
  { n: 'מתלה קיר לקולבים', d: 'חמישה ווים על לוח עץ מלא, נושא מעילים אמיתיים ולא רק צעיפים.', c: 4, p: 159, w: 1_400, v: 'colorHome', s: 'a solid wood wall coat rack with five hooks' },
  { n: 'תמונת קיר ממוסגרת', d: 'הדפס איכותי במסגרת עץ דקה עם זכוכית מט שלא מחזירה אור.', c: 4, p: 249, w: 2_200, v: 'sizeHome', s: 'a framed abstract art print in warm earth tones with a thin wooden frame' },
  { n: 'סט מסגרות תמונה', d: 'שלוש מסגרות בגדלים תואמים לקיר גלריה קטן, כולל תבנית תלייה.', c: 4, p: 199, w: 2_400, v: 'colorHome', s: 'a set of three matching wooden picture frames in different sizes' },
  { n: 'מדף קיר לתבלינים', d: 'שני מדפים צרים למטבח, נושאים צנצנות תבלין בלי לתפוס משטח.', c: 4, p: 139, w: 1_600, v: 'colorHome', s: 'a narrow two-tier wall spice shelf in light wood' },
  { n: 'קולב עומד', d: 'קולב רצפה עם בסיס יציב ושמונה ווים, מתפרק לאחסון.', c: 4, p: 249, w: 3_600, v: 'colorHome', s: 'a standing coat rack with a stable round base and eight hooks' },
  { n: 'מחזיק מפתחות קיר', d: 'לוח עץ קטן עם ארבעה ווים ומדף עליון לארנק ולמשקפיים.', c: 4, p: 99, w: 600, v: 'colorHome', s: 'a small wooden wall key holder with four hooks and a top ledge' },
];
