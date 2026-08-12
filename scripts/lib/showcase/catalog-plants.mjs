/**
 * אדנית — the urban-nursery showcase catalog (100 products).
 *
 * Row shape is identical to `catalog-fashion.mjs`; read that header for it.
 *
 * The fourth store, added 2026-08-12 at the owner's suggestion ("משתלה אורבנית").
 * It earns its place by carrying a product type none of the other three can: a
 * LIVING good. That is a genuinely different catalog to run — it is sized by pot
 * diameter rather than by S/M/L, it carries care instructions instead of a spec
 * sheet, its stock moves with the season, and it is awkward to ship rather than
 * merely heavy, which is why this is the second self-pickup store.
 *
 * Descriptions lean practical on purpose. Someone buying a plant is deciding
 * whether they can keep it alive, so light and watering belong in the copy — a
 * nursery that writes only about how pretty a plant is reads as a gift shop.
 */

export const PLANT_PRODUCTS = [
  // ── צמחי פנים (c:0) ────────────────────────────────────────────────────────
  { n: 'מונסטרה דליציוזה', d: 'העלים המחורצים הגדולים שכולם מזהים. אור עקיף בהיר, השקיה כשהאדמה יבשה בחלק העליון.\n\nגדלה מהר ובגדול — בתוך שנתיים היא תופסת פינה שלמה, אז שווה לתת לה מקום מראש. עמוד תמיכה נכנס בקלות לעציץ כשהיא מתחילה להישען.', c: 0, p: 129, w: 2_400, v: 'potSize', s: 'a monstera deliciosa houseplant with large split leaves in a terracotta pot' },
  { n: 'פיקוס ליראטה', d: 'עלים גדולים בצורת כינור, צמח שמחזיק חדר לבד. אוהב אור בהיר וקבוע ולא אוהב שמזיזים אותו.', c: 0, p: 189, w: 3_200, v: 'potSize', s: 'a fiddle leaf fig plant with large violin-shaped leaves in a pale stoneware pot' },
  { n: 'פותוס זהוב', d: 'הצמח שהכי קשה להרוג. משתלשל יפה ממדף וסובל גם אור חלש.', c: 0, p: 59, w: 900, v: 'potSize', s: 'a golden pothos trailing plant with variegated heart-shaped leaves' },
  { n: 'סנסיווריה', d: 'עלים זקופים וקשיחים, שורדת שבועיים בלי מים בלי להתלונן.\n\nהבחירה הנכונה לחדר עם מעט אור או למי ששוכח להשקות. גם מסננת אוויר טוב מרוב הצמחים.', c: 0, p: 79, w: 1_600, v: 'potSize', s: 'a snake plant with tall upright variegated leaves in a concrete pot' },
  { n: 'זמיוקולקס', d: 'עלים מבריקים כמעט מלאכותיים למראה. מים פעם בשבועיים, אור בינוני, וזהו.', c: 0, p: 89, w: 1_800, v: 'potSize', s: 'a ZZ plant with glossy dark green leaves in a matte black pot' },
  { n: 'פילודנדרון לב', d: 'עלים בצורת לב שמשתלשלים במהירות. מושלם לתלייה או לראש ארון.', c: 0, p: 69, w: 800, v: 'potSize', s: 'a heartleaf philodendron trailing from a hanging pot' },
  { n: 'קלתיאה אורביפוליה', d: 'עלים עגולים עם פסים כסופים שנסגרים בלילה. אוהבת לחות — מקום טוב בשבילה הוא אמבטיה עם חלון.', c: 0, p: 119, w: 1_400, v: 'potSize', s: 'a calathea orbifolia with round silver-striped leaves' },
  { n: 'אלוקסיה', d: 'עלים משולשים גדולים עם עורקים בולטים. דרמטית, ודורשת לחות ואור עקיף.', c: 0, p: 149, w: 1_600, v: 'potSize', s: 'an alocasia plant with dramatic arrow-shaped veined leaves' },
  { n: 'מרנטה', d: 'דוגמת עלים צבעונית שמתקפלת בערב כמו כפות ידיים. צמח שכיף להסתכל עליו משתנה.', c: 0, p: 89, w: 900, v: 'potSize', s: 'a maranta prayer plant with patterned red-veined leaves' },
  { n: 'שרך בוסטון', d: 'עלווה עשירה ומתפרצת. אוהב לחות גבוהה, אז ריסוס פעמיים בשבוע עושה לו טוב.', c: 0, p: 79, w: 1_200, v: 'potSize', s: 'a lush boston fern in a hanging basket' },
  { n: 'פפרומיה', d: 'עלים עבים וקטנים, צמח קומפקטי שנשאר בגודל שלו. מתאים למדף צר או לשולחן עבודה.', c: 0, p: 55, w: 600, v: 'potSize', s: 'a small peperomia plant with thick round leaves' },
  { n: 'דרצנה מרג׳ינטה', d: 'גזע דק ועלים צרים כמו זיקוקים. גדלה לגובה ולא לרוחב, נוחה לפינות.', c: 0, p: 99, w: 1_800, v: 'potSize', s: 'a dracaena marginata with a slim trunk and narrow spiky leaves' },
  { n: 'ספתיפילום', d: 'עלים כהים ופרח לבן שחוזר כמה פעמים בשנה. מסמנת לך שהיא צמאה בכך שהעלים נופלים — ומתאוששת תוך שעה.', c: 0, p: 79, w: 1_200, v: 'potSize', s: 'a peace lily with dark leaves and a single white spathe flower' },
  { n: 'אפיפרמנום מנומר', d: 'גרסה מנומרת בלבן־ירוק. ככל שהאור בהיר יותר, הנמר בולט יותר.', c: 0, p: 89, w: 800, v: 'potSize', s: 'a variegated marble queen pothos with white and green leaves' },
  { n: 'הויה', d: 'עלים עבותים ומבריקים, ובבגרות אשכולות פרחים שעווניים בריח מתוק. צמח סבלני מאוד.', c: 0, p: 109, w: 900, v: 'potSize', s: 'a hoya plant with thick waxy trailing leaves' },
  { n: 'קקטוס עמוד', d: 'קקטוס זקוף ואדריכלי. שמש מלאה, ומים אחת לשלושה שבועות בקיץ בלבד.', c: 0, p: 89, w: 2_200, v: 'potSize', s: 'a tall columnar cactus in a concrete pot' },
  { n: 'שלישיית סוקולנטים', d: 'שלושה זנים שונים בעציצים קטנים תואמים. מתנה קטנה שנשארת בחיים.', c: 0, p: 79, w: 900, v: null, s: 'three small succulents in matching miniature pots' },
  { n: 'אכוריה', d: 'ורדת עלים סימטרית וקומפקטית. אדמה מנקזת, שמש חלקית, ומעט מאוד מים.', c: 0, p: 45, w: 400, v: null, s: 'a small echeveria succulent rosette' },
  { n: 'אלוורה', d: 'צמח שימושי באמת — הג׳ל בעלה מרגיע כוויות שמש. שמש בהירה ומים נדירים.', c: 0, p: 65, w: 1_100, v: 'potSize', s: 'an aloe vera plant with thick pointed leaves' },
  { n: 'פילודנדרון ברזילאי', d: 'עלים מוארכים עם פס בהיר במרכז. גדל מהר ומשתלשל יפה.', c: 0, p: 79, w: 900, v: 'potSize', s: 'a philodendron brasil with striped yellow-green trailing leaves' },
  { n: 'בונסאי פיקוס', d: 'עץ מיניאטורי מעוצב בעבודת יד, מגיע בקערת קרמיקה שטוחה.\n\nדורש תשומת לב שבועית — השקיה קטנה וקבועה וגיזום קל פעמיים בשנה. זה לא צמח שמניחים ושוכחים, וזה בדיוק העניין בו.', c: 0, p: 249, w: 1_800, v: null, s: 'a small ficus bonsai tree in a shallow ceramic bowl' },
  { n: 'קיסוס אנגלי', d: 'משתלשל צפוף עם עלים קטנים. מצוין למדף גבוה או לסלסלה תלויה.', c: 0, p: 59, w: 700, v: 'potSize', s: 'an english ivy trailing plant in a hanging pot' },
  { n: 'צמח כסף סיני', d: 'עלים כסופים־ירוקים, סובל אור נמוך ומזגן. מהעמידים שיש.', c: 0, p: 89, w: 1_200, v: 'potSize', s: 'a chinese evergreen aglaonema with silver-green patterned leaves' },
  { n: 'פיקוס בנג׳מין', d: 'עץ פנים קלאסי עם עלווה צפופה. מפיל עלים כשמזיזים אותו — בחרו מקום ותשאירו אותו שם.', c: 0, p: 139, w: 2_600, v: 'potSize', s: 'a ficus benjamina indoor tree with dense small leaves' },

  // ── מרפסת וגינה (c:1) ──────────────────────────────────────────────────────
  { n: 'שתיל עגבניות שרי', d: 'שתיל מבוסס בעציץ 12 ס״מ. שמש מלאה, ובתוך חודשיים אתם קוטפים מהמרפסת.', c: 1, p: 25, w: 500, v: null, s: 'a young cherry tomato seedling in a small nursery pot' },
  { n: 'שתיל בזיליקום', d: 'ריח שממלא את המרפסת. קטיפה תכופה מלמעלה שומרת אותו שיחי ולא גבוה.', c: 1, p: 19, w: 400, v: null, s: 'a basil seedling with bright green leaves in a small pot' },
  { n: 'שתיל נענע', d: 'גדל מהר ובכוח — כדאי להשאיר אותו בעציץ נפרד או שהוא ישתלט על השכנים.', c: 1, p: 19, w: 400, v: null, s: 'a mint plant in a terracotta pot' },
  { n: 'שתיל רוזמרין', d: 'שיח תבלין עמיד שסובל שמש ישראלית מלאה ומעט מים. מחזיק שנים.', c: 1, p: 29, w: 700, v: 'potSize', s: 'a rosemary shrub in a clay pot' },
  { n: 'שתיל פטרוזיליה', d: 'שתיל חסון בעציץ. קטיפה מבחוץ פנימה, וזה מתחדש כל הזמן.', c: 1, p: 19, w: 400, v: null, s: 'a parsley plant in a small nursery pot' },
  { n: 'שתיל כוסברה', d: 'אוהבת שמש חלקית ולא אוהבת חום קיצוני. הכי טוב לשתול אותה באביב או בסתיו.', c: 1, p: 19, w: 400, v: null, s: 'a coriander cilantro plant in a pot' },
  { n: 'שתיל צ׳ילי', d: 'שיח נמוך שמניב עשרות פלפלונים בעונה, ונראה יפה גם לפני שהם מבשילים.', c: 1, p: 32, w: 600, v: null, s: 'a chili pepper plant with small red peppers' },
  { n: 'שתיל תות שדה', d: 'מתאים במיוחד לאדנית תלויה — הפירות משתלשלים מעבר לשפה ולא נוגעים באדמה.', c: 1, p: 29, w: 500, v: null, s: 'a strawberry plant with white flowers in a hanging planter' },
  { n: 'שיח לבנדר', d: 'פורח סגול לאורך כל האביב ומריח נהדר. שמש מלאה, ניקוז טוב, וגיזום אחרי הפריחה.', c: 1, p: 49, w: 1_200, v: 'potSize', s: 'a lavender shrub with purple flower spikes in a terracotta pot' },
  { n: 'גרניום פורח', d: 'הצמח הקלאסי של המרפסת הישראלית. פורח כמעט כל השנה וסולח על השקיה לא סדירה.', c: 1, p: 39, w: 900, v: 'potSize', s: 'a flowering geranium with red blooms in a balcony pot' },
  { n: 'פטוניה משתלשלת', d: 'מפל פרחים צבעוני מאדנית תלויה. אוהבת שמש ומים יומיים בקיץ.', c: 1, p: 35, w: 800, v: 'colorHome', s: 'trailing petunias cascading from a hanging balcony planter' },
  { n: 'בוגנוויליה', d: 'הפריחה החזקה ביותר שיש, ובקיץ הישראלי היא בשיאה. צריכה שמש מלאה ומקום להיאחז בו.', c: 1, p: 79, w: 2_400, v: 'potSize', s: 'a bougainvillea with vivid magenta bracts climbing a trellis' },
  { n: 'יסמין מטפס', d: 'ריח ערב שמגיע עד לתוך הבית. מטפס על סבכה או על מעקה תוך עונה.', c: 1, p: 69, w: 1_800, v: 'potSize', s: 'a climbing jasmine with small white flowers on a trellis' },
  { n: 'עץ לימון ננסי', d: 'עץ הדר בגודל שמתאים למרפסת, ומניב לימונים אמיתיים.\n\nצריך שמש מלאה, דשן הדרים בכל עונה וניקוז אמיתי — הדר בעציץ סובל יותר מהצפה מאשר מיובש. מגיע כבר מורכב ובגיל נותן פרי.', c: 1, p: 189, w: 4_200, v: 'potSize', s: 'a dwarf lemon tree in a large pot with a few yellow lemons' },
  { n: 'עץ זית בעציץ', d: 'עלווה כסופה ועמידות מלאה לשמש. גדל לאט, וזה יתרון במרפסת.', c: 1, p: 219, w: 5_400, v: 'potSize', s: 'a small potted olive tree with silvery leaves' },
  { n: 'אדנית ירק למרפסת', d: 'אדנית מוכנה עם שלושה תבלינים שגדלים טוב יחד. מגיעה שתולה ומושקית.', c: 1, p: 119, w: 3_200, v: null, s: 'a rectangular balcony planter box filled with three herb plants' },
  { n: 'סבכת טיפוס', d: 'סבכת עץ מטופל לחוץ, נשענת על קיר או נעוצה בעציץ גדול.', c: 1, p: 89, w: 1_600, v: 'sizeHome', s: 'a wooden garden trellis leaning against a concrete wall' },
  { n: 'מתלה עציצים למעקה', d: 'נתלה על מעקה מרפסת סטנדרטי בלי קדיחה, ומחזיק שני עציצים.', c: 1, p: 79, w: 1_100, v: 'colorHome', s: 'a metal railing planter bracket holding two pots on a balcony rail' },
  { n: 'מדף עציצים מדורג', d: 'שלוש מדרגות שמכניסות שישה עציצים לשטח של שניים. מתקפל לאחסון.', c: 1, p: 189, w: 3_800, v: 'colorHome', s: 'a three-tier plant stand with pots on a balcony' },
  { n: 'עציץ תלוי מקרמה', d: 'קשירה בעבודת יד מחוט כותנה טבעי. מתאים לעציץ עד 17 ס״מ.', c: 1, p: 69, w: 400, v: null, s: 'a macrame plant hanger holding a terracotta pot' },
  { n: 'רשת הצללה למרפסת', d: 'מורידה משמעותית את חום הצהריים ומגנה על צמחים רגישים. כולל קשירות.', c: 1, p: 129, w: 1_800, v: 'sizeHome', s: 'a beige shade net stretched over a balcony' },
  { n: 'ערכת גינת מרפסת', d: 'אדנית, מצע, דשן ושלושה שתילים — כל מה שצריך כדי להתחיל באותו יום.', c: 1, p: 249, w: 6_400, v: null, s: 'a balcony gardening starter kit with a planter, soil bag and seedlings' },

  // ── עציצים ומצעים (c:2) ────────────────────────────────────────────────────
  { n: 'עציץ טרקוטה קלאסי', d: 'חרס נושם שמונע ריקבון שורשים. חור ניקוז וצלוחית תואמת.', c: 2, p: 39, w: 1_400, v: 'sizeHome', s: 'a classic terracotta plant pot with a matching saucer' },
  { n: 'עציץ בטון', d: 'בטון יצוק בגימור גס, כבד ויציב — לא נופל ברוח על המרפסת.', c: 2, p: 89, w: 3_200, v: 'sizeHome', s: 'a raw concrete plant pot with a rough finish' },
  { n: 'עציץ קרמיקה מזוגג', d: 'זיגוג מט בגוון אחיד עם חור ניקוז. יפה גם ליד ריהוט בהיר.', c: 2, p: 79, w: 1_800, v: 'colorHome', s: 'a matte glazed ceramic plant pot in muted sage' },
  { n: 'עציץ עם השקיה עצמית', d: 'מאגר מים בתחתית שמספיק לשבועיים. פתרון אמיתי לחופשה.', c: 2, p: 119, w: 1_600, v: 'sizeHome', s: 'a self-watering plant pot with a water level indicator' },
  { n: 'עציץ תלוי קרמיקה', d: 'מגיע עם חבל תלייה מותאם וסוגר עליון. קל יחסית כדי לא להעמיס על התקרה.', c: 2, p: 99, w: 1_200, v: 'colorHome', s: 'a hanging ceramic planter with a rope' },
  { n: 'עציץ על רגליים', d: 'עציץ מוגבה על שלוש רגלי עץ — מרים צמח מהרצפה ומאוורר מתחת.', c: 2, p: 149, w: 2_800, v: 'colorHome', s: 'a plant pot raised on three wooden legs' },
  { n: 'אדנית מלבנית', d: 'אדנית ארוכה לשלושה עד ארבעה צמחים, עם ניקוז לאורך.', c: 2, p: 129, w: 3_400, v: 'sizeHome', s: 'a long rectangular planter box in pale concrete' },
  { n: 'עציץ בד גידול', d: 'בד נושם שמונע סיבוב שורשים ומקפל שטוח לאחסון. פופולרי לירקות.', c: 2, p: 45, w: 300, v: 'sizeHome', s: 'a fabric grow bag planter with handles' },
  { n: 'סט צלוחיות ניקוז', d: 'שלוש צלוחיות בגדלים תואמים לעציצים נפוצים, עם גב שלא משאיר סימן על פרקט.', c: 2, p: 49, w: 900, v: null, s: 'a set of three terracotta pot saucers in graduated sizes' },
  { n: 'מצע שתילה כללי', d: 'מצע מאוורר לרוב צמחי הבית והמרפסת. שק 20 ליטר.', c: 2, p: 39, w: 12_000, v: null, s: 'a bag of general purpose potting soil' },
  { n: 'מצע לקקטוסים', d: 'תערובת מנקזת עם חול ופרלייט. הדבר היחיד שמונע ריקבון בסוקולנטים.', c: 2, p: 35, w: 8_000, v: null, s: 'a bag of cactus and succulent potting mix' },
  { n: 'מצע לצמחי פנים', d: 'תערובת עשירה עם קוקוס וורמיקוליט ששומרת לחות בלי להיות כבדה.', c: 2, p: 42, w: 10_000, v: null, s: 'a bag of indoor plant potting mix' },
  { n: 'קומפוסט אורגני', d: 'קומפוסט מיוצב לשיפור אדמה קיימת. מערבבים שליש עם המצע.', c: 2, p: 45, w: 15_000, v: null, s: 'a bag of organic compost' },
  { n: 'פרלייט', d: 'מאוורר את המצע ומונע דחיסה. שקית שמספיקה להרבה עציצים.', c: 2, p: 29, w: 2_000, v: null, s: 'a bag of white perlite granules' },
  { n: 'חצץ דקורטיבי', d: 'שכבה עליונה שמסתירה את האדמה, מאטה אידוי ונראית מסודרת.', c: 2, p: 32, w: 5_000, v: 'colorHome', s: 'decorative gravel top dressing in a shallow dish' },
  { n: 'כדורי חרס מורחב', d: 'שכבת ניקוז בתחתית עציץ בלי חור, או מצע להידרופוניקה.', c: 2, p: 39, w: 3_000, v: null, s: 'a scoop of expanded clay pebbles' },
  { n: 'קליפות קוקוס דחוסות', d: 'לבנה שמתנפחת במים לתשעה ליטר מצע. נוחה לאחסון ולמשלוח.', c: 2, p: 25, w: 700, v: null, s: 'a compressed coco coir brick' },
  { n: 'עמוד טחב לטיפוס', d: 'עמוד עטוף טחב שמונסטרה ופילודנדרון נאחזים בו ומגדילים עלים.', c: 2, p: 79, w: 1_400, v: 'sizeHome', s: 'a moss pole for climbing plants' },
  { n: 'רשת ניקוז לעציץ', d: 'רשתות קטנות שמונעות מהמצע לצאת דרך חור הניקוז. עשר יחידות.', c: 2, p: 19, w: 100, v: null, s: 'small mesh drainage screens for pot holes' },
  { n: 'מגש טפטוף גדול', d: 'מגש רחב שאוסף מים מכמה עציצים יחד. מתאים למרפסת שירות.', c: 2, p: 59, w: 1_200, v: 'sizeHome', s: 'a large plastic plant drip tray' },

  // ── טיפול והזנה (c:3) ──────────────────────────────────────────────────────
  { n: 'דשן נוזלי לצמחי פנים', d: 'מדללים במים פעם בשבועיים באביב ובקיץ. בחורף מפסיקים לגמרי.', c: 3, p: 45, w: 600, v: null, s: 'a bottle of liquid houseplant fertilizer' },
  { n: 'דשן לצמחים פורחים', d: 'יחס אשלגן גבוה שמעודד פריחה ולא רק עלווה.', c: 3, p: 49, w: 600, v: null, s: 'a bottle of bloom fertilizer for flowering plants' },
  { n: 'דשן הדרים', d: 'תערובת ייעודית לעץ לימון או זית בעציץ, כולל ברזל ומגנזיום.', c: 3, p: 55, w: 900, v: null, s: 'a container of citrus tree fertilizer granules' },
  { n: 'טבליות דשן איטיות', d: 'נועצים באדמה ומשחררות הזנה לאורך שלושה חודשים. בלי לזכור כלום.', c: 3, p: 39, w: 300, v: null, s: 'slow release fertilizer tablets beside a plant pot' },
  { n: 'תרסיס נגד כנימות', d: 'על בסיס שמן, מטפל בכנימות ובאקריות. בטוח לשימוש בתוך הבית.', c: 3, p: 49, w: 700, v: null, s: 'a spray bottle of organic pest control for houseplants' },
  { n: 'מלכודות דביקות צהובות', d: 'לוכדות יתושי מצע לפני שהם מתרבים. עשר יחידות עם מקלות.', c: 3, p: 29, w: 200, v: null, s: 'yellow sticky fly traps stuck into plant pots' },
  { n: 'אבקת שורשים', d: 'מזרזת השתרשות של ייחורים. טובלים את הקצה ושותלים.', c: 3, p: 35, w: 150, v: null, s: 'a small jar of rooting hormone powder' },
  { n: 'מד לחות לאדמה', d: 'נועצים ורואים מיד אם צריך להשקות. פותר את הטעות הכי נפוצה — השקיית יתר.', c: 3, p: 45, w: 120, v: null, s: 'a soil moisture meter probe inserted in a plant pot' },
  { n: 'מרסס ערפל', d: 'ערפל עדין שמעלה לחות סביב שרכים וקלתיאות בלי להרטיב את האדמה.', c: 3, p: 55, w: 300, v: 'colorHome', s: 'a fine mist plant sprayer bottle in amber glass' },
  { n: 'מזלף פנים דק', d: 'זרבובית ארוכה ודקה שמגיעה מתחת לעלווה בלי לשפוך. ליטר וחצי.', c: 3, p: 89, w: 600, v: 'colorHome', s: 'a slim long-spout indoor watering can' },
  { n: 'טפטפות לחופשה', d: 'משחררות מים לאט לאורך שבוע. פתרון לשבוע חופש בלי שכנים.', c: 3, p: 39, w: 250, v: null, s: 'glass watering globes inserted into plant pots' },
  { n: 'מנורת גידול לצמחים', d: 'ספקטרום מלא לחדר בלי חלון טוב. טיימר מובנה לשתים־עשרה שעות.', c: 3, p: 189, w: 800, v: 'colorHome', s: 'a clip-on full spectrum grow light over a houseplant' },
  { n: 'מברשת ניקוי עלים', d: 'סיבים רכים שמסירים אבק מעלים גדולים — אבק על עלה חוסם אור.', c: 3, p: 29, w: 100, v: null, s: 'a soft leaf cleaning brush beside a monstera leaf' },
  { n: 'תרסיס הברקת עלים', d: 'מסיר אבק ומשאיר ברק טבעי בלי לסתום את הפיוניות.', c: 3, p: 39, w: 400, v: null, s: 'a leaf shine spray bottle' },
  { n: 'סיכות שתילה', d: 'מקבעות ייחור משתלשל לאדמה עד שהוא משריש. עשרים יחידות.', c: 3, p: 25, w: 150, v: null, s: 'small metal propagation pins' },
  { n: 'צנצנת השרשה', d: 'צנצנת זכוכית עם מתלה קיר לייחורים במים. אפשר לראות את השורשים מתפתחים.', c: 3, p: 69, w: 500, v: null, s: 'a glass propagation vase mounted on a wooden wall holder' },
  { n: 'חוט קשירה לצמחים', d: 'חוט רך מצופה שלא חותך גבעול. גליל של עשרים מטר.', c: 3, p: 22, w: 200, v: null, s: 'a roll of soft plant tie wire' },
  { n: 'יומן טיפול בצמחים', d: 'מחברת קטנה לרישום השקיה ודישון לכל צמח. נשמע מיותר עד שיש עשרה צמחים.', c: 3, p: 45, w: 300, v: null, s: 'a small plant care journal notebook beside a pot' },

  // ── כלי גינון (c:4) ────────────────────────────────────────────────────────
  { n: 'מזמרה מקצועית', d: 'להב מחושל עם מנגנון נעילה. חיתוך נקי שלא מוחץ את הגבעול.', c: 4, p: 119, w: 280, v: null, s: 'a pair of professional garden pruning shears' },
  { n: 'מספריים לצמחי פנים', d: 'מספריים קטנים וחדים לגיזום עדין ולקטיפת תבלינים.', c: 4, p: 49, w: 90, v: null, s: 'small precision plant snips' },
  { n: 'כף שתילה נירוסטה', d: 'נירוסטה מלאה עם ידית עץ אמיתית וסימוני עומק על הלהב.', c: 4, p: 69, w: 220, v: null, s: 'a stainless steel garden trowel with a wooden handle' },
  { n: 'מזלג ניכוש', d: 'משחרר אדמה דחוסה סביב שורשים בלי לפגוע בהם.', c: 4, p: 59, w: 200, v: null, s: 'a small garden hand fork with a wooden handle' },
  { n: 'סט כלי גינון מיני', d: 'שלושה כלים קטנים לעציצים ולטרריום, בנרתיק בד.', c: 4, p: 89, w: 400, v: null, s: 'a set of three miniature gardening tools in a canvas roll' },
  { n: 'כפפות גינון', d: 'כף יד מצופה שלא מחליקה ומגן פרק. שוטפות במים.', c: 4, p: 45, w: 120, v: 'colorHome', s: 'a pair of gardening gloves with coated palms' },
  { n: 'כפפות עמידות לקוצים', d: 'שרוול ארוך שמגן על האמה — לבוגנוויליה ולוורדים.', c: 4, p: 79, w: 220, v: null, s: 'long gauntlet thorn-proof gardening gloves' },
  { n: 'סינר גינון', d: 'סינר בד עבה עם שלושה כיסים לכלים ולחוט.', c: 4, p: 99, w: 400, v: 'colorHome', s: 'a canvas gardening apron with tool pockets' },
  { n: 'משטח שתילה מתקפל', d: 'משטח אטום שמקפל לתיבה — שותלים על השולחן בלי ללכלך.', c: 4, p: 79, w: 600, v: null, s: 'a foldable plant repotting mat with raised sides' },
  { n: 'מגרפה קטנה', d: 'מגרפת יד ליישור מצע ולאיסוף עלים מאדנית.', c: 4, p: 49, w: 180, v: null, s: 'a small hand rake for planters' },
  { n: 'מרסס לחץ 2 ליטר', d: 'שאיבת לחץ ידנית וריסוס רציף. לטיפולים על כל המרפסת בבת אחת.', c: 4, p: 89, w: 700, v: null, s: 'a 2 litre pressure garden sprayer' },
  { n: 'צינור השקיה מתארך', d: 'מתארך פי שלושה בלחץ מים ומתכווץ לאחסון. שבעה וחצי מטר.', c: 4, p: 129, w: 900, v: null, s: 'a coiled expandable garden hose' },
  { n: 'ממטרה לעציצים', d: 'ראש מקלחת עדין שמתחבר לצינור, לא שוטף את המצע.', c: 4, p: 59, w: 240, v: null, s: 'a gentle shower watering wand head' },
  { n: 'סל איסוף מתקפל', d: 'סל גמיש לעלים, לגיזום או ליבול. מתקפל שטוח לגמרי.', c: 4, p: 69, w: 500, v: 'colorHome', s: 'a collapsible garden tub for garden waste' },
  { n: 'תוויות שתילה', d: 'עשרים תוויות עץ עם עיפרון — כדי לזכור מה נשתל ומתי.', c: 4, p: 29, w: 150, v: null, s: 'wooden plant labels stuck into soil' },
  { n: 'מתלה כלי גינון לקיר', d: 'פס עם ווים לתלייה של כלים ושל כפפות במחסן או במרפסת שירות.', c: 4, p: 89, w: 900, v: 'colorHome', s: 'a wall-mounted garden tool rack with hooks' },
];
