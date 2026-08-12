/**
 * Teklar — the electronics showcase catalog (100 products).
 *
 * Row shape is identical to `catalog-fashion.mjs`; read that header for it.
 *
 * This is deliberately the SOLID store (owner, 2026-08-12 — he asked for one of
 * the three to be). Its copy is spec-led and flat: a number, what the number buys
 * you, and nothing else. No exclamation, no "מהפכני". That restraint is the
 * demonstration — a seller who sells technical goods has to see that the platform
 * renders a spec sheet as well as it renders a dress.
 *
 * **Not one real model name in here, and that is a hard rule, not a style choice.**
 * The catalog this replaced listed "אייפון 13 Pro" and "מקבוק פרו" next to scraped
 * photographs of those exact devices. See `identity.mjs` for why that is an
 * account-level ads risk and not merely an aesthetic one. Everything below is a
 * plausible generic device described by what it does.
 */

export const TECH_PRODUCTS = [
  // ── שמע (c:0) ──────────────────────────────────────────────────────────────
  { n: 'אוזניות קשת עם ביטול רעשים', d: 'ביטול רעשים אקטיבי, 40 שעות האזנה בטעינה מלאה וכריות זיכרון שלא לוחצות אחרי שעתיים.', c: 0, sub: 'אוזניות', p: 899, w: 280, v: 'colorTech', s: 'over-ear wireless headphones with memory foam ear cushions' },
  { n: 'אוזניות קשת לאולפן', d: 'תגובת תדר שטוחה וכבל נשלף באורך 3 מטר. חיבור 3.5 מ״מ ומתאם ג׳ק גדול בקופסה.', c: 0, sub: 'אוזניות', p: 649, w: 320, v: 'colorTech', s: 'wired studio monitor headphones with a coiled detachable cable' },
  { n: 'אוזניות אלחוטיות בתוך האוזן', d: 'שש שעות בכל אוזנייה ועוד עשרים בכיסוי, זיהוי אוזן שעוצר כשמוציאים.', c: 0, sub: 'אוזניות', p: 449, w: 60, v: 'colorTech', s: 'true wireless earbuds beside their charging case' },
  { n: 'אוזניות ספורט עם וו אוזן', d: 'עמידות בזיעה ובגשם, וו גמיש שלא זז בריצה.', c: 0, sub: 'אוזניות', p: 329, w: 70, v: 'colorTech', s: 'sport earbuds with flexible over-ear hooks' },
  { n: 'אוזניות הולכה עצמית', d: 'משאירות את האוזן פתוחה כדי לשמוע תנועה. לרכיבה ולריצה בעיר.', c: 0, sub: 'אוזניות', p: 599, w: 110, v: 'colorTech', s: 'open-ear bone conduction headphones' },
  { n: 'רמקול בלוטות׳ נייד', d: 'עמידות IPX7 מלאה למים, 20 שעות ניגון ורצועה לתלייה.', c: 0, sub: 'רמקולים ומערכות', p: 399, w: 640, v: 'colorTech', s: 'a portable cylindrical bluetooth speaker with a fabric grille and a wrist strap' },
  { n: 'רמקול בלוטות׳ קטן', d: 'נכנס לכיס ומחזיק יום שלם. מתאים למרפסת ולנסיעות.', c: 0, sub: 'רמקולים ומערכות', p: 199, w: 260, v: 'colorTech', s: 'a compact pocket bluetooth speaker' },
  { n: 'רמקול מדף לסלון', d: 'זוג רמקולים פסיביים עם דופן עץ, מתחברים למגבר קיים.', c: 0, sub: 'רמקולים ומערכות', p: 1_290, w: 6_800, v: 'colorTech', s: 'a pair of bookshelf speakers with wooden cabinets and fabric fronts' },
  { n: 'סאונדבר לטלוויזיה', d: 'שיפור ניכר על רמקולי הטלוויזיה בחיבור אחד, עם סאב אלחוטי נפרד.', c: 0, sub: 'רמקולים ומערכות', p: 1_190, w: 4_200, v: null, s: 'a slim soundbar with a separate wireless subwoofer' },
  { n: 'מגבר סטריאו קומפקטי', d: 'שני ערוצים בהספק אמיתי, כניסת בלוטות׳ וכניסת פטיפון מובנית.', c: 0, sub: 'רמקולים ומערכות', p: 1_490, w: 5_400, v: null, s: 'a compact stereo amplifier with a large volume knob and a brushed front panel' },
  { n: 'פטיפון עם מגבר מובנה', d: 'מחט מתחלפת ומגבר פנימי, מתחבר ישירות לרמקולים פעילים.', c: 0, sub: 'רמקולים ומערכות', p: 1_690, w: 5_600, v: null, s: 'a modern turntable with a built-in preamp on a wooden plinth' },
  { n: 'מיקרופון USB לשולחן', d: 'תבנית קרדיואידית שקולטת אותך ולא את החדר, כולל יציאת אוזניות לניטור.', c: 0, sub: 'מיקרופונים והקלטה', p: 549, w: 780, v: 'colorTech', s: 'a USB condenser desktop microphone on a small stand' },
  { n: 'מיקרופון דש אלחוטי', d: 'שני משדרים ומקלט אחד, לצילום ראיון בשני אנשים.', c: 0, sub: 'מיקרופונים והקלטה', p: 749, w: 220, v: null, s: 'a wireless lavalier microphone kit with two transmitters and a receiver' },
  { n: 'זרוע מיקרופון', d: 'זרוע מפרקית עם מהדק שולחן ומעבר כבלים פנימי.', c: 0, sub: 'מיקרופונים והקלטה', p: 269, w: 1_100, v: 'colorTech', s: 'an articulated microphone boom arm with a desk clamp' },
  { n: 'ממיר USB לאודיו', d: 'ממיר חיצוני שמשפר משמעותית אוזניות טובות מול כרטיס קול מובנה.', c: 0, sub: 'מיקרופונים והקלטה', p: 429, w: 90, v: null, s: 'a small external USB digital-to-analog audio converter' },
  { n: 'רמקול רטרו עם ידית', d: 'גוף מתכת וידית עור, בלוטות׳ מלא בפנים. נראה כמו רדיו ישן ומתנהג כמו רמקול חדש.', c: 0, sub: 'רמקולים ומערכות', p: 549, w: 980, v: 'colorTech', s: 'a retro-styled portable speaker with a metal grille, cream body and a leather carry handle' },
  { n: 'רדיו דיגיטלי למטבח', d: 'תצוגה ברורה, שעון מעורר ורמקול שמספיק למטבח שלם.', c: 0, sub: 'רמקולים ומערכות', p: 289, w: 720, v: 'colorTech', s: 'a small digital kitchen radio with a clear display' },
  { n: 'אוזניות לילדים עם הגבלת עוצמה', d: 'תקרת עוצמה מובנית של 85 דציבל וקשת מתכווננת.', c: 0, sub: 'אוזניות', p: 179, w: 190, v: 'colorTech', s: "volume-limited children's headphones in a bright colour" },
  { n: 'מעמד לאוזניות', d: 'מעמד שולחני עם בסיס כבד שלא נופל, שומר על צורת הכרית.', c: 0, sub: 'נגנים ואביזרים', p: 129, w: 620, v: 'colorTech', s: 'a headphone stand with a weighted base' },
  { n: 'נגן מוזיקה כיס', d: 'נגן קטן עם גלגל ניווט ומסך זעיר, בלי התראות ובלי אפליקציות. רק מוזיקה.', c: 0, sub: 'נגנים ואביזרים', p: 429, w: 90, v: 'colorTech', s: 'a small square pocket music player with a tiny screen and a circular scroll wheel' },

  // ── מחשוב ועבודה (c:1) ─────────────────────────────────────────────────────
  { n: 'מסך 27 אינץ׳', d: 'רזולוציית 2560×1440 ב-100Hz, גובה מתכוונן וסיבוב לאנכי.', c: 1, p: 1_290, w: 6_400, v: null, s: 'a 27 inch computer monitor on an adjustable stand, bezels very thin' },
  { n: 'מסך אולטרה־רחב', d: 'יחס 21:9 שמחליף שני מסכים בלי התפר באמצע.', c: 1, p: 2_290, w: 8_600, v: null, s: 'an ultrawide 21:9 curved computer monitor' },
  { n: 'מסך נייד 15 אינץ׳', d: 'מסך שני שנכנס לתיק המחשב ומתחבר בכבל USB-C יחיד.', c: 1, p: 899, w: 780, v: null, s: 'a slim portable second monitor with a folding cover stand' },
  { n: 'מקלדת מכנית אלחוטית', d: 'מתגים חלופיים בלי הלחמה, שלושה מכשירים מזווגים והחלפה בלחיצה.', c: 1, p: 649, w: 880, v: 'colorTech', s: 'a compact mechanical wireless keyboard with pale keycaps' },
  { n: 'מקלדת דקה שקטה', d: 'מהלך מקש נמוך ורעש מינימלי, מתאימה למשרד פתוח.', c: 1, p: 289, w: 480, v: 'colorTech', s: 'a slim low-profile quiet keyboard' },
  { n: 'עכבר ארגונומי אנכי', d: 'אחיזה אנכית שמורידה סיבוב של האמה, ארבעה כפתורים ניתנים להגדרה.', c: 1, p: 249, w: 130, v: 'colorTech', s: 'a vertical ergonomic computer mouse' },
  { n: 'עכבר אלחוטי שקט', d: 'לחיצה כמעט בלי קול וסוללה שמחזיקה חודשים.', c: 1, p: 149, w: 90, v: 'colorTech', s: 'a silent wireless mouse, small and rounded' },
  { n: 'משטח עכבר גדול', d: 'משטח שמכסה גם את המקלדת, עם תפר היקפי שלא נפרם.', c: 1, p: 89, w: 340, v: 'colorTech', s: 'a large desk mat mouse pad with stitched edges' },
  { n: 'מעמד למחשב נייד', d: 'אלומיניום מלא שמרים את המסך לגובה עיניים ומאוורר מלמטה.', c: 1, p: 199, w: 1_100, v: 'colorTech', s: 'an aluminium laptop stand raising a laptop to eye level' },
  { n: 'מעמד מחשב מתקפל לנסיעות', d: 'מתקפל שטוח לגמרי ונכנס לצד התיק, שמונה גבהים.', c: 1, p: 129, w: 420, v: 'colorTech', s: 'a folding travel laptop stand, flat when collapsed' },
  { n: 'תחנת עגינה USB-C', d: 'שתי יציאות מסך, שלוש USB, רשת קווית וכרטיס זיכרון בכבל אחד למחשב.', c: 1, p: 549, w: 320, v: null, s: 'a USB-C docking station with many ports along its edge' },
  { n: 'מפצל USB-C קומפקטי', d: 'שבע יציאות בגוף בגודל כרטיס אשראי, כולל העברת טעינה.', c: 1, p: 229, w: 90, v: 'colorTech', s: 'a compact USB-C hub the size of a credit card' },
  { n: 'כונן SSD חיצוני', d: 'קריאה מהירה בחיבור USB-C, גוף עמיד בנפילה ובגודל כרטיס.', c: 1, p: 449, w: 60, v: 'storage', s: 'a pocket-sized external SSD drive with a USB-C cable' },
  { n: 'כונן קשיח חיצוני', d: 'נפח גדול במחיר נמוך לגיבוי ארוך טווח, לא לעבודה שוטפת.', c: 1, p: 379, w: 240, v: 'storage', s: 'a portable external hard drive' },
  { n: 'כרטיס זיכרון מהיר', d: 'מהירות כתיבה שמספיקה לצילום וידאו רציף, עמיד למים ולטמפרטורה.', c: 1, p: 189, w: 10, v: 'storage', s: 'a fast SD memory card' },
  { n: 'מסך E Ink לשולחן', d: 'מסך נייר אלקטרוני שמראה יומן, מזג אוויר ומשימות. לא מאיר, לא מהבהב, מחזיק שבועות.', c: 1, p: 599, w: 340, v: 'colorTech', s: 'a small e-ink desk display in a wooden frame showing a simple calendar layout' },
  { n: 'מצלמת רשת 1080p', d: 'תיקון תאורה אוטומטי ומיקרוד כפול, מתאימה לפגישות בחדר לא מואר.', c: 1, p: 329, w: 160, v: null, s: 'a 1080p webcam clipped to the top of a monitor' },
  { n: 'תאורת מסך לשולחן', d: 'נתלית על המסך ומאירה את השולחן בלי בוהק על התצוגה.', c: 1, p: 279, w: 340, v: 'colorTech', s: 'a screen bar light mounted on top of a monitor' },
  { n: 'זרוע למסך', d: 'מהדק שולחן עם מעבר כבלים, נושאת מסך עד 32 אינץ׳ ומשחררת שטח.', c: 1, p: 399, w: 3_200, v: 'colorTech', s: 'a monitor arm with a desk clamp and internal cable routing' },
  { n: 'מארז נשיאה למחשב', d: 'ריפוד קשיח עם רוכסן היקפי ותא פנימי לכבלים.', c: 1, p: 179, w: 420, v: 'colorTech', s: 'a hard shell laptop carrying case' },
  { n: 'מדפסת תרמית מיני', d: 'מדפיסה מדבקות, פתקים ותמונות בלי דיו בכלל — הנייר עצמו מגיב לחום.', c: 1, p: 349, w: 420, v: 'colorTech', s: 'a small pocket thermal printer printing a paper strip, no ink cartridge' },
  { n: 'מסנן פרטיות למסך', d: 'מצמצם את זווית הצפייה, כדי שהמסך יהיה קריא רק מולך.', c: 1, p: 219, w: 300, v: 'sizeTech', s: 'a privacy filter screen fitted to a laptop display' },

  // ── טעינה וחשמל (c:2) ──────────────────────────────────────────────────────
  { n: 'מטען קיר 65W GaN', d: 'שלוש יציאות שמטעינות מחשב וטלפון יחד, בגוף קטן מהמטען הישן.', c: 2, p: 199, w: 140, v: 'colorTech', s: 'a compact 65W GaN wall charger with three ports' },
  { n: 'מטען קיר 30W קומפקטי', d: 'יציאה אחת בגודל של קובייה, מטעין טלפון במהירות מלאה.', c: 2, p: 99, w: 60, v: 'colorTech', s: 'a small single-port wall charger cube' },
  { n: 'מטען שולחני רב־יציאות', d: 'שש יציאות עם חלוקת הספק חכמה, מטעין את כל השולחן משקע אחד.', c: 2, p: 289, w: 420, v: null, s: 'a desktop multi-port charging station with six ports' },
  { n: 'סוללת גיבוי 10000', d: 'טעינה מלאה לטלפון ועוד חצי, עם תצוגת אחוזים אמיתית.', c: 2, p: 179, w: 210, v: 'colorTech', s: 'a slim 10000mAh power bank with a small percentage display' },
  { n: 'סוללת גיבוי 20000 מהירה', d: 'מספיקה לטיול של יומיים או לטעינת מחשב נייד קל.', c: 2, p: 299, w: 420, v: 'colorTech', s: 'a 20000mAh fast-charging power bank' },
  { n: 'סוללת גיבוי מגנטית', d: 'נצמדת לגב הטלפון ומטעינה תוך כדי הליכה, בלי כבל.', c: 2, p: 249, w: 130, v: 'colorTech', s: 'a magnetic wireless power bank attached to the back of a phone' },
  { n: 'משטח טעינה אלחוטית', d: 'משטח דק עם משטח סיליקון שלא מחליק, מטעין דרך כיסוי דק.', c: 2, p: 129, w: 120, v: 'colorTech', s: 'a flat circular wireless charging pad' },
  { n: 'מעמד טעינה אלחוטית', d: 'מעמד בזווית שמאפשרת לראות התראות תוך כדי טעינה.', c: 2, p: 169, w: 200, v: 'colorTech', s: 'an angled wireless charging stand holding a phone upright' },
  { n: 'תחנת טעינה 3 ב-1', d: 'טלפון, שעון ואוזניות על בסיס אחד, מתקפלת לנסיעות.', c: 2, p: 329, w: 340, v: 'colorTech', s: 'a folding 3-in-1 charging station for a phone, watch and earbuds' },
  { n: 'כבל USB-C קלוע', d: 'שריון קלוע ומחבר מחוזק, שני מטר, תומך בטעינה מהירה מלאה.', c: 2, p: 69, w: 90, v: 'colorTech', s: 'a braided USB-C cable, neatly coiled' },
  { n: 'כבל USB-C מגנטי', d: 'ראש מגנטי שמתנתק בלי למשוך את המכשיר מהשולחן.', c: 2, p: 89, w: 80, v: 'colorTech', s: 'a magnetic tip USB-C charging cable' },
  { n: 'פאנל טעינה סולארי מתקפל', d: 'נפרש בשמש וטוען טלפון או סוללת גיבוי ישירות. מתקפל לגודל של ספר.', c: 2, p: 449, w: 1_100, v: null, s: 'a folding solar charging panel partly unfolded on a stone surface' },
  { n: 'מטען לרכב שתי יציאות', d: 'מטעין שני מכשירים במקביל בהספק מלא, עם נורית עמומה שלא מסנוורת בלילה.', c: 2, p: 119, w: 60, v: 'colorTech', s: 'a dual-port car charger in a car socket' },
  { n: 'מפצל שקע חכם', d: 'ארבעה שקעים ושתי USB עם מגן נחשולים ומפסק מואר.', c: 2, p: 149, w: 640, v: null, s: 'a surge-protected power strip with four sockets and two USB ports' },
  { n: 'שקע חכם עם מדידה', d: 'מדליק ומכבה מהטלפון ומודד צריכת חשמל בפועל.', c: 2, p: 99, w: 120, v: null, s: 'a smart plug with energy monitoring' },
  { n: 'שואב שולחן נייד', d: 'שואב זעיר לפירורים ולאבק מקלדת, נטען ב-USB-C ומתרוקן בלחיצה.', c: 2, p: 179, w: 380, v: 'colorTech', s: 'a tiny cordless desktop vacuum cleaner, rounded and minimal' },
  { n: 'מתאם נסיעות עולמי', d: 'מתאים לרוב היעדים בשקע אחד, כולל שתי יציאות USB.', c: 2, p: 139, w: 210, v: null, s: 'a universal travel power adapter' },
  { n: 'מארגן כבלים לשולחן', d: 'תעלה נצמדת מתחת לשולחן שמעלימה את כל הכבלים מהעין.', c: 2, p: 109, w: 480, v: 'colorTech', s: 'an under-desk cable management tray' },
  { n: 'מברג חשמלי מדויק', d: 'עשרים ביטים בקופסת אלומיניום ותאורה בקצה. פותח שעון, משקפיים ומחשב נייד.', c: 2, p: 249, w: 480, v: 'colorTech', s: 'a precision electric screwdriver with an aluminium case of neatly arranged bits' },
  { n: 'משאבת אוויר ניידת', d: 'מזרימה לחץ מדויק לצמיג, לכדור או לגלגלי אופניים, ועוצרת לבד ביעד.', c: 2, p: 289, w: 540, v: 'colorTech', s: 'a compact cordless electric air pump with a small digital pressure display' },
  { n: 'סוללות נטענות AA', d: 'ארבע סוללות נטענות עם מטען, מחליפות מאות סוללות חד־פעמיות.', c: 2, p: 159, w: 260, v: null, s: 'four rechargeable AA batteries beside a small charger' },
  { n: 'פנס נטען חזק', d: 'קרן ממוקדת עם שלוש עוצמות, נטען ב-USB-C ועמיד בגשם.', c: 2, p: 149, w: 220, v: 'colorTech', s: 'a rechargeable aluminium flashlight' },

  // ── בית חכם (c:3) ──────────────────────────────────────────────────────────
  { n: 'רמקול חכם קומפקטי', d: 'שליטה קולית וצליל מלא לחדר בינוני, מתחבר לשאר המכשירים בבית.', c: 3, p: 379, w: 620, v: 'colorTech', s: 'a small fabric-covered smart speaker' },
  { n: 'מסך חכם למטבח', d: 'מסך 8 אינץ׳ עם מתכונים, טיימרים ושיחות וידאו. עומד לבד על השיש.', c: 3, p: 649, w: 1_100, v: 'colorTech', s: 'a small smart display screen standing on a kitchen counter' },
  { n: 'נורה חכמה מתחלפת גוונים', d: 'לבן חם עד קר וצבעים מלאים, בלי רכזת נפרדת.', c: 3, p: 89, w: 120, v: null, s: 'a smart colour-changing LED bulb' },
  { n: 'רצועת לד חכמה', d: 'חמישה מטר עם דבק חזק וחיתוך לפי סימון, נשלטת מהטלפון.', c: 3, p: 179, w: 340, v: null, s: 'a smart LED light strip in a coil' },
  { n: 'מצלמת אבטחה לבית', d: 'ראיית לילה, זיהוי תנועה והתראה לטלפון. אחסון מקומי בכרטיס.', c: 3, p: 299, w: 240, v: 'colorTech', s: 'a small indoor home security camera on a stand' },
  { n: 'מצלמת אבטחה לחוץ', d: 'עמידה בגשם ובשמש ישירה, עם זרקור שנדלק על תנועה.', c: 3, p: 499, w: 620, v: null, s: 'an outdoor weatherproof security camera with a spotlight' },
  { n: 'פעמון דלת עם מצלמה', d: 'רואה מי בדלת מהטלפון גם כשאין אף אחד בבית, כולל דיבור דו־כיווני.', c: 3, p: 599, w: 320, v: 'colorTech', s: 'a video doorbell mounted beside a door frame' },
  { n: 'חיישן דלת וחלון', d: 'מתריע כשנפתח, נדבק בלי קדיחה וסוללה שמחזיקה שנה.', c: 3, p: 89, w: 60, v: null, s: 'a small wireless door and window contact sensor' },
  { n: 'גלאי עשן חכם', d: 'מתריע גם לטלפון וגם בקול, עם בדיקה עצמית חודשית.', c: 3, p: 249, w: 220, v: null, s: 'a smart smoke detector mounted on a ceiling' },
  { n: 'חיישן נזילת מים', d: 'מונח מתחת לכיור או ליד המכונה ומתריע ברגע שיש מים.', c: 3, p: 119, w: 90, v: null, s: 'a small water leak sensor placed on a floor under a sink' },
  { n: 'שלט אוניברסלי חכם', d: 'מפעיל מזגן וטלוויזיה מהטלפון, גם כשאף אחד לא מוצא את השלט.', c: 3, p: 159, w: 110, v: null, s: 'a smart infrared universal remote hub, small and round' },
  { n: 'מנעול חכם לדלת', d: 'קוד, טלפון או מפתח רגיל. מתקין על הצילינדר הקיים.', c: 3, p: 1_190, w: 980, v: 'colorTech', s: 'a smart door lock with a keypad mounted on a door' },
  { n: 'תרמוסטט חכם למזגן', d: 'לומד את השעות שבהן הבית ריק ומוריד צריכה בלי לוותר על נוחות.', c: 3, p: 449, w: 260, v: null, s: 'a smart thermostat control panel on a wall' },
  { n: 'שואב רובוטי', d: 'ממפה את הדירה ומחזיר את עצמו לעמדה. עובד גם על שטיח נמוך.', c: 3, p: 1_490, w: 4_200, v: 'colorTech', s: 'a round robot vacuum cleaner beside its charging dock' },
  { n: 'מטהר אוויר לחדר', d: 'מסנן HEPA שמוריד אבק ואבקנים, שקט מספיק כדי לישון לידו.', c: 3, p: 899, w: 5_200, v: 'colorTech', s: 'a cylindrical HEPA air purifier in a bedroom corner' },
  { n: 'מד לחות וטמפרטורה', d: 'תצוגה ברורה עם היסטוריה בטלפון, קטן מספיק למדף.', c: 3, p: 99, w: 80, v: 'colorTech', s: 'a small digital temperature and humidity monitor' },
  { n: 'משקל חכם', d: 'מסתנכרן לטלפון ומזהה כמה משתמשים בבית לבד.', c: 3, p: 219, w: 1_800, v: 'colorTech', s: 'a glass smart bathroom scale' },
  { n: 'שעון מעורר זריחה', d: 'מאיר בהדרגה עשרים דקות לפני השעה ומעיר באור ולא בצפצוף. גם שעון לילה.', c: 3, p: 349, w: 620, v: 'colorTech', s: 'a rounded sunrise alarm clock lamp glowing softly warm on a bedside table' },

  // ── צילום ווידאו (c:4) ─────────────────────────────────────────────────────
  { n: 'חצובה לצילום', d: 'אלומיניום עם ראש כדורי ומפלס מובנה, מגיעה לגובה 165 ס״מ.', c: 4, p: 449, w: 1_800, v: null, s: 'an aluminium camera tripod with a ball head, legs extended' },
  { n: 'חצובה שולחנית', d: 'רגליים גמישות שנכרכות על מעקה או ענף, נושאת מצלמה קטנה או טלפון.', c: 4, p: 149, w: 380, v: 'colorTech', s: 'a flexible mini tripod with bendable legs' },
  { n: 'מייצב לטלפון', d: 'שלושה צירים שמייצבים וידאו בהליכה, מתקפל לגודל של בקבוק קטן.', c: 4, p: 649, w: 480, v: 'colorTech', s: 'a folding 3-axis smartphone gimbal stabiliser' },
  { n: 'תאורת טבעת לצילום', d: 'טבעת עם שלוש טמפרטורות אור וחצובה מתכווננת, כולל מחזיק טלפון.', c: 4, p: 249, w: 1_200, v: null, s: 'a ring light on a stand with a phone holder' },
  { n: 'פאנל תאורה נייד', d: 'פאנל לד קטן עם סוללה פנימית ועמעום רציף, לצילום בשטח.', c: 4, p: 379, w: 420, v: null, s: 'a compact battery-powered LED video light panel' },
  { n: 'מסך ירוק מתקפל', d: 'רקע ירוק שנפתח בשנייה ומתקפל לתיק שטוח.', c: 4, p: 289, w: 2_400, v: 'sizeTech', s: 'a collapsible green screen backdrop' },
  { n: 'רקע צילום מוצרים', d: 'משטח דו־צדדי בשני גוונים לצילום מוצרים קטנים, לא מחזיר אור.', c: 4, p: 129, w: 900, v: 'colorTech', s: 'a two-sided matte product photography backdrop board' },
  { n: 'אוהל צילום מואר', d: 'תיבה מתקפלת עם תאורת לד פנימית וארבעה רקעים. לצילום מוצרים לחנות.', c: 4, p: 399, w: 2_200, v: 'sizeTech', s: 'a foldable lightbox photo studio tent with internal LED lighting' },
  { n: 'עדשת מאקרו לטלפון', d: 'נצמדת בקליפס ומצלמת פרטים קטנים שהמצלמה לא תופסת.', c: 4, p: 179, w: 90, v: null, s: 'a clip-on macro lens for a smartphone' },
  { n: 'מסנן עדשה מקטב', d: 'מוריד השתקפות מזכוכית וממים ומעמיק את השמיים.', c: 4, p: 219, w: 70, v: 'sizeTech', s: 'a circular polarising camera lens filter' },
  { n: 'תיק מצלמה עם מחיצות', d: 'ריפוד עם מחיצות מתכווננות לגוף ולשתי עדשות, ופתח גישה מהיר מהצד.', c: 4, p: 449, w: 980, v: 'colorTech', s: 'a padded camera bag with adjustable dividers, opened to show compartments' },
  { n: 'רצועת מצלמה מרופדת', d: 'רצועה רחבה שמחלקת משקל על הכתף, עם חיבור מהיר.', c: 4, p: 169, w: 180, v: 'colorTech', s: 'a padded camera neck strap' },
  { n: 'מצלמת אקסטרים', d: 'עמידה במים בלי מארז, ייצוב אלקטרוני ווידאו ברזולוציה גבוהה.', c: 4, p: 1_290, w: 160, v: 'colorTech', s: 'a small rugged action camera' },
  { n: 'ערכת הרכבה למצלמת אקסטרים', d: 'שבעה מתאמים לקסדה, לכידון ולחזה, בקופסה אחת.', c: 4, p: 189, w: 640, v: null, s: 'an action camera mount accessory kit laid out flat' },
  { n: 'מקל צילום עם חצובה', d: 'מתארך ונפתח לחצובה קטנה, כולל שלט בלוטות׳ נשלף.', c: 4, p: 139, w: 240, v: 'colorTech', s: 'an extendable selfie stick that converts into a small tripod' },
  { n: 'מצלמה קומפקטית בסגנון פילם', d: 'גוף קטן עם חוגות אמיתיות ומראה תמונה בגימור פילם. מצלמה שמזמינה לצאת איתה.', c: 4, p: 1_490, w: 320, v: 'colorTech', s: 'a retro-styled compact digital camera with physical dials and a leatherette body' },
  { n: 'קורא כרטיסים מהיר', d: 'קורא שני סוגי כרטיסים במקביל בחיבור USB-C.', c: 4, p: 129, w: 70, v: null, s: 'a dual-slot USB-C memory card reader' },
  { n: 'ערכת ניקוי עדשות', d: 'מפוח, מברשת, נוזל ומטליות — כל מה שצריך בלי לגעת בזכוכית ביד.', c: 4, p: 99, w: 220, v: null, s: 'a camera lens cleaning kit with a blower, brush and cloths' },
];
