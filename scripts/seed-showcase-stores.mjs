#!/usr/bin/env node
/**
 * Showcase-store seeder — the three platform-owned "חנות לדוגמה" stores
 * (GO_LIVE_CHECKLIST.md §6.2, src/lib/demo-stores.ts).
 *
 *   node scripts/seed-showcase-stores.mjs           # create/refresh the three
 *   node scripts/seed-showcase-stores.mjs --clean   # remove them
 *
 * Different from scripts/seed-demo-data.mjs in kind, not just in size: that one
 * builds a big fake catalog for DEVELOPMENT and gets wiped before launch. These
 * three are meant to be LIVE on the real site on day one, so that the first
 * seller has a finished store to look at and the homepage spotlight has more than
 * one slide to rotate. They carry `demo: true`, which keeps them out of the index,
 * out of the feeds, out of every store-count threshold, and out of checkout — see
 * lib/demo-stores.ts for the whole rule set.
 *
 * Three, each a different kind of store (apparel / electronics / home & kitchen),
 * because a prospective seller has to recognise his own case in at least one of
 * them, and because the spotlight carousel's arrows and auto-rotation are gated
 * on more than one slide. All three carry colour/size variants now (see
 * VARIANTS_BY_CATEGORY) — variants used to be an apparel-only prop, which left
 * two of the three stores unable to demonstrate the feature at all.
 *
 * Idempotent: a re-run removes the previous showcase set first (matched on
 * `demo: true` plus the platform seller account), so it never accumulates
 * duplicates and never touches a real seller's data.
 *
 * Product photos come from DummyJSON (free, keyless) exactly like the dev seeder
 * — real photos of real objects. Needs internet on the seeding run only; the
 * image URLs it writes are permanent.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const DATA = (f) => path.join(ROOT, 'data', f);
const read = (f, def) => { try { return JSON.parse(fs.readFileSync(DATA(f), 'utf8')); } catch { return def; } };
const write = (f, v) => fs.writeFileSync(DATA(f), JSON.stringify(v, null, 2));
const uuid = () => crypto.randomUUID();

/** The platform's own seller account. Every showcase store hangs off this one
 *  record so the whole set has a single owner to log in as / clean up by. */
const OWNER_EMAIL = 'showcase@dezabin.com';
const OWNER_PASSWORD = 'showcase1234';
const OWNER_NAME = 'Dezabin';

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// Deterministic pseudo-random: a re-seed produces the same prices/stock, so a
// screenshot or a bug report from one run still matches the next.
let _s = 20260728;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.createHmac('sha256', salt).update(pw).digest('hex')}`;
};
const slugify = (s) => s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
const comboKey = (sel) => Object.keys(sel).sort((a, b) => a.localeCompare(b)).map((k) => `${k}=${sel[k]}`).join(',');

// ── Variants (CURRENT_TASK.md → סשן א׳ 2) ────────────────────────────────────
// Colour/size options are what a seller most needs to SEE working before he
// believes the platform handles his catalog, so they're picked per product TYPE
// rather than per store: a dress in S–XL, a shoe in 38–43, a phone in colour +
// storage, a bag in colour only. One blanket set per store (what this was until
// 2026-07-29) produced "מידה: XL" on a handbag, which demonstrates the feature by
// making it look wrong.
//
// Colour option names come from lib/color-variants.ts's COLOR_MAP — a name it
// doesn't know renders as a text chip instead of a swatch, so the storefront's
// colour picker only shows what it's meant to show if these match.
const SIZE_APPAREL  = { name: 'מידה', options: ['S', 'M', 'L', 'XL'] };
const SIZE_SHOES    = { name: 'מידה', options: ['38', '39', '40', '41', '42', '43'] };
const SIZE_KITCHEN  = { name: 'גודל', options: ['קטן', 'בינוני', 'גדול'] };
const STORAGE       = { name: 'נפח אחסון', options: ['128GB', '256GB', '512GB'] };
const COLOR_APPAREL = { name: 'צבע', options: ['שחור', 'לבן', 'כחול'] };
const COLOR_SHOES   = { name: 'צבע', options: ['שחור', 'לבן', 'אדום'] };
const COLOR_BAGS    = { name: 'צבע', options: ['שחור', 'חום', 'אפור'] };
const COLOR_TECH    = { name: 'צבע', options: ['שחור', 'כסף', 'כחול'] };
const COLOR_HOME    = { name: 'צבע', options: ['שחור', 'לבן', 'אפור'] };

// Keyed by the DummyJSON category the product was fetched from — that's the only
// reliable type signal in the source data. `null` is deliberate, not a gap: a
// showcase store that gives EVERY product a variant picker stops demonstrating
// the plain single-SKU product, which is most of what a real catalog holds.
const VARIANTS_BY_CATEGORY = {
  'mens-shirts':         [SIZE_APPAREL, COLOR_APPAREL],
  'tops':                [SIZE_APPAREL, COLOR_APPAREL],
  'womens-dresses':      [SIZE_APPAREL, COLOR_APPAREL],
  'mens-shoes':          [SIZE_SHOES, COLOR_SHOES],
  'womens-shoes':        [SIZE_SHOES, COLOR_SHOES],
  'womens-bags':         [COLOR_BAGS],
  'smartphones':         [COLOR_TECH, STORAGE],
  'laptops':             [COLOR_TECH, STORAGE],
  'mobile-accessories':  [COLOR_TECH],
  'home-decoration':     [COLOR_HOME],
  'kitchen-accessories': [SIZE_KITCHEN],
  'furniture':           null,
};

function buildVariantStock(variants) {
  const combos = variants.reduce(
    (acc, dim) => acc.flatMap((sel) => dim.options.map((o) => ({ ...sel, [dim.name]: o }))),
    [{}],
  );
  const out = {};
  // A couple of sold-out combos on purpose — the storefront's variant picker
  // greys those out, and a showcase store that never shows that state hides one
  // of the features it exists to demonstrate.
  for (const c of combos) out[comboKey(c)] = rnd() < 0.15 ? 0 : int(3, 18);
  return out;
}

// Hebrew catalog for the showcase stores. Key = the DummyJSON title (which is
// what identifies the photo); value = the Hebrew name + description we actually
// ship. A product with no entry here is DROPPED, so the storefront can never
// show an untranslated English row — that also makes this table the definition
// of the catalog, not just a translation of it.
//
// Fashion names are deliberately generic: the photos are stock, so labelling one
// "Prada" would be a claim we can't make. Electronics keep their model names —
// that's a factual identifier, and it's how a real Israeli shop lists them.
const HE_CATALOG = {
  // ── סטודיו לבוש ────────────────────────────────────────────────────────
  'Blue & Black Check Shirt':        ['חולצה מכופתרת משבצות כחול־שחור', 'חולצת כותנה נושמת בגזרה רגילה, משבצות כחול־שחור. נוחה ליומיום ומתאימה גם לערב.'],
  'Gigabyte Aorus Men Tshirt':       ['טי־שירט הדפס לגברים', 'טי־שירט כותנה עם הדפס קדמי, גזרה רגילה וצווארון עגול. נשמרת טוב בכביסה.'],
  'Man Plaid Shirt':                 ['חולצת פלנל משבצות', 'פלנל רך במשבצות אדום־שחור, שרוול ארוך עם כפתורים בשרוול. מושלמת לעונות המעבר.'],
  'Man Short Sleeve Shirt':          ['חולצה מכופתרת שרוול קצר', 'הדפס טרופי על בד קליל ואוורירי, גזרה משוחררת. חולצת הקיץ הבסיסית.'],
  'Men Check Shirt':                 ['חולצת משבצות קלאסית', 'משבצות עדינות בכחול ולבן, צווארון מכופתר וגזרה נוחה שלא מגבילה בתנועה.'],
  'Blue Frock':                      ['שמלת מיני כחולה', 'שמלה קצרה בכחול עז עם גזרה מחמיאה, בד נופל שלא מצריך גיהוץ.'],
  'Girl Summer Dress':               ['שמלת קיץ פרחונית', 'הדפס פרחים על בד קליל, כתפיות דקות ואורך מעל הברך. קלילה במיוחד ליום חם.'],
  'Gray Dress':                      ['שמלת מידי אפורה', 'אפור נקי בגזרה ישרה, מתאימה למשרד ולערב באותה מידה. בד עבה ואיכותי.'],
  'Short Frock':                     ['שמלה קצרה בגזרת A', 'גזרת A מתרחבת עם מותן מודגש, בד רך ונעים. אחת השמלות הכי נמכרות אצלנו.'],
  'Tartan Dress':                    ['שמלת טרטן משובצת', 'דוגמת טרטן קלאסית בגוונים חמים, שרוול ארוך וחגורה תואמת בחבילה.'],
  "Black Women's Gown":              ['שמלת ערב שחורה', 'שמלת ערב ארוכה בשחור מלוטש, גב פתוח וגזרה מחטבת. לאירועים.'],
  'Corset Leather With Skirt':       ['סט מחוך וחצאית', 'מחוך בגימור עור עם חצאית תואמת, סגירת רוכסן אחורית. סט שלם בפריט אחד.'],
  'Corset With Black Skirt':         ['מחוך עם חצאית שחורה', 'מחוך מובנה עם חצאית שחורה נופלת, מתאים לאירועי ערב ולצילומים.'],
  'Dress Pea':                       ['שמלת מידי אלגנטית', 'גזרה נקייה באורך מידי, בד עם נפילה יפה שמחזיק צורה לאורך היום.'],
  'Marni Red & Black Suit':          ['חליפת נשים אדום־שחור', 'ז׳קט מחויט וחצאית תואמת בשילוב אדום ושחור. סט שלם למראה מוקפד.'],
  'Nike Air Jordan 1 Red And Black': ['סניקרס גבוהות אדום־שחור', 'סניקרס גבוהות בשילוב אדום־שחור, סוליית אוויר ותמיכה טובה בקרסול.'],
  'Nike Baseball Cleats':            ['נעלי בייסבול מקצועיות', 'נעלי בייסבול עם פקקים לאחיזה מקסימלית בדשא, בד קל ונושם.'],
  'Puma Future Rider Trainers':      ['נעלי ספורט רטרו', 'עיצוב רטרו בשילוב צבעים, סוליה מרופדת ונוחה גם לשעות ארוכות על הרגליים.'],
  'Sports Sneakers Off White & Red': ['סניקרס ספורט לבן־אדום', 'סניקרס בגוון אוף־וייט עם פרטי אדום, מתאימות לריצה קלה וליומיום.'],
  'Sports Sneakers Off White Red':   ['סניקרס ספורט קלות', 'משקל נמוך במיוחד וסוליה גמישה — נעל אימון שמרגישה כמו כלום על הרגל.'],
  'Black & Brown Slipper':           ['כפכפי בית שחור־חום', 'כפכפים לבית עם ריפוד פנימי רך וסוליה מונעת החלקה.'],
  'Calvin Klein Heel Shoes':         ['נעלי עקב קלאסיות', 'עקב בגובה בינוני, גזרה מחודדת ורצועה מתכווננת. נוחות גם בעמידה ממושכת.'],
  'Golden Shoes Woman':              ['נעלי עקב בגימור זהב', 'גימור זהב מבריק עם עקב יציב, נעל ערב שמתאימה גם לאירועי יום.'],
  'Pampi Shoes':                     ['נעליים שטוחות לנשים', 'נעל שטוחה בעיצוב נקי, נוחה במיוחד להליכה ארוכה בעיר.'],
  'Red Shoes':                       ['נעליים אדומות', 'אדום עז בגימור חלק, עקב נמוך ונוח. פריט צבע לארון בסיסי.'],
  "Blue Women's Handbag":            ['תיק יד כחול', 'תיק יד בכחול עמוק עם רצועת כתף נשלפת ותאים פנימיים מסודרים.'],
  "Heshe Women's Leather Bag":       ['תיק עור לנשים', 'עור אמיתי בגימור רך, תא ראשי רחב וכיס פנימי לטלפון ולמפתחות.'],
  'Prada Women Bag':                 ['תיק כתף מעוצב', 'תיק כתף בקו נקי עם אבזם מתכת, מחזיק צורה ונכנס בו כל היומיום.'],
  'White Faux Leather Backpack':     ['תיק גב דמוי עור לבן', 'תיק גב בדמוי עור לבן עם תא מרופד למחשב נייד ורצועות מתכווננות.'],
  'Women Handbag Black':             ['תיק יד שחור', 'שחור קלאסי שמתאים להכל, סגירת רוכסן מלאה ובטנה עמידה.'],

  // ── טק ליין ────────────────────────────────────────────────────────────
  'iPhone 5s':                       ['אייפון 5s', 'מכשיר קומפקטי במצב חדש, מסך 4 אינץ׳ וסוללה שהוחלפה. אחריות שנה.'],
  'iPhone 6':                        ['אייפון 6', 'מסך 4.7 אינץ׳, זיכרון 32GB. מכשיר משופץ שעבר בדיקה מלאה במעבדה.'],
  'iPhone 13 Pro':                   ['אייפון 13 Pro', 'מסך Super Retina XDR בקצב 120Hz, מערך שלוש מצלמות ושבב A15. אחריות יבואן.'],
  'iPhone X':                        ['אייפון X', 'מסך OLED מקצה לקצה עם Face ID, זיכרון 64GB. מצב חיצוני מצוין.'],
  'Oppo A57':                        ['אופו A57', 'סוללה 5000mAh שמחזיקה יומיים, מסך 6.56 אינץ׳ וטעינה מהירה 33W.'],
  'Oppo F19 Pro Plus':               ['אופו F19 Pro Plus', 'תמיכת 5G, מסך AMOLED וטעינה מלאה בפחות מחצי שעה.'],
  'Oppo K1':                         ['אופו K1', 'חיישן טביעת אצבע בתוך המסך, מצלמה קדמית 25MP. מכשיר יומיומי משתלם.'],
  'Realme C35':                       ['ריאלמי C35', 'מסך 6.6 אינץ׳ מלא, גוף דק במיוחד וסוללה גדולה. מחיר כניסה.'],
  'Realme X':                        ['ריאלמי X', 'מצלמה קופצת ללא חריץ במסך, זיכרון 128GB ומעבד Snapdragon.'],
  'Realme XT':                       ['ריאלמי XT', 'מצלמה ראשית 64MP, מסך AMOLED וטעינה מהירה VOOC בקופסה.'],
  'Samsung Galaxy S7':               ['סמסונג גלקסי S7', 'עמיד במים IP68, מסך קעור ותמיכה בכרטיס זיכרון. מכשיר משופץ.'],
  'Samsung Galaxy S8':               ['סמסונג גלקסי S8', 'מסך Infinity אינסופי 5.8 אינץ׳, טעינה אלחוטית וזיהוי קשתית.'],
  'Samsung Galaxy S10':              ['סמסונג גלקסי S10', 'שלוש מצלמות אחוריות, מסך Dynamic AMOLED ו‑128GB אחסון.'],
  'Vivo S1':                         ['ויוו S1', 'מסך AMOLED 6.38 אינץ׳, מצלמה משולשת וסוללה 4500mAh.'],
  'Vivo V9':                         ['ויוו V9', 'מסך 6.3 אינץ׳ ביחס 19:9, מצלמה קדמית 24MP לסלפי חד.'],
  'Vivo X21':                        ['ויוו X21', 'חיישן טביעת אצבע מתחת למסך, גוף זכוכית וגימור פרימיום.'],
  'Apple MacBook Pro 14 Inch Space Grey': ['מקבוק פרו 14 אינץ׳', 'שבב M-series, מסך Liquid Retina XDR וסוללה ליום עבודה מלא. אפור חלל.'],
  'Asus Zenbook Pro Dual Screen Laptop':  ['אסוס זנבוק פרו Duo', 'מסך שני מובנה מעל המקלדת — מחשב לעורכי וידאו ומעצבים.'],
  'Huawei Matebook X Pro':           ['וואווי מייטבוק X Pro', 'מסך מגע 3K ביחס 3:2, גוף מתכת דק ומשקל מתחת לקילו וחצי.'],
  'Lenovo Yoga 920':                 ['לנובו יוגה 920', 'ציר 360 מעלות שהופך אותו לטאבלט, כולל עט דיגיטלי.'],
  'New DELL XPS 13 9300 Laptop':     ['דל XPS 13', 'מסגרת מסך דקה במיוחד, מקלדת מוארת וגוף אלומיניום. 13.4 אינץ׳.'],
  'Amazon Echo Plus':                ['רמקול חכם אמזון Echo Plus', 'רמקול חכם עם בקר בית חכם מובנה, שליטה קולית וצליל מלא.'],
  'Apple Airpods':                   ['אוזניות AirPods', 'אוזניות אלחוטיות עם כיסוי טעינה, חיבור מיידי וזיהוי אוזן אוטומטי.'],
  'Apple AirPods Max Silver':        ['אוזניות קשת AirPods Max', 'אוזניות קשת עם ביטול רעשים אקטיבי וכריות זיכרון. צליל מרחבי.'],
  'Apple Airpower Wireless Charger': ['משטח טעינה אלחוטי', 'טעינה אלחוטית לשני מכשירים במקביל, בלי כבלים על השולחן.'],
  'Apple HomePod Mini Cosmic Grey':  ['רמקול חכם HomePod Mini', 'רמקול חכם קומפקטי עם צליל 360 מעלות ושליטה קולית. אפור.'],
  'Apple iPhone Charger':            ['מטען מקורי לאייפון', 'מטען קיר מקורי עם כבל, טעינה מהירה ובטוחה למכשיר.'],
  'Apple MagSafe Battery Pack':      ['סוללת גיבוי MagSafe', 'נצמדת מגנטית לגב המכשיר ומטעינה תוך כדי תנועה. בלי כבל.'],
  'Apple Watch Series 4 Gold':       ['שעון Apple Watch Series 4', 'מסך רחב, מדידת דופק ו‑ECG, עמיד במים. גימור זהב.'],
  'Beats Flex Wireless Earphones':   ['אוזניות Beats Flex', 'אוזניות צוואר אלחוטיות עם 12 שעות האזנה וחיבור מהיר.'],

  // ── בית ומטבח ──────────────────────────────────────────────────────────
  'Decoration Swing':                ['נדנדת ישיבה תלויה', 'נדנדה תלויה עם כרית ישיבה מרופדת, מתאימה למרפסת ולגינה.'],
  'Family Tree Photo Frame':         ['מסגרת עץ משפחה', 'מסגרת קיר לעשר תמונות בצורת עץ, מגיעה עם ערכת תלייה.'],
  'House Showpiece Plant':           ['צמח נוי מלאכותי', 'צמח מלאכותי בעציץ, נראה אמיתי ולא דורש טיפול או שמש.'],
  'Plant Pot':                       ['עציץ קרמיקה', 'עציץ קרמיקה בגימור מט עם חור ניקוז וצלוחית תואמת.'],
  'Table Lamp':                      ['מנורת שולחן', 'מנורת שולחן עם אהיל בד וגוף יציב, אור חם ונעים לקריאה.'],
  'Annibale Colombo Bed':            ['מיטה זוגית מרופדת', 'מיטה זוגית עם ראש מיטה מרופד ובסיס עץ מלא. כולל הרכבה.'],
  'Annibale Colombo Sofa':           ['ספה תלת מושבית', 'ספה תלת מושבית בריפוד בד עמיד, מושבים עמוקים ונוחים.'],
  'Bedside Table African Cherry':    ['שידת לילה עץ', 'שידת לילה בגוון דובדבן עם שתי מגירות שקטות ומשטח עליון רחב.'],
  'Knoll Saarinen Executive Conference Chair': ['כיסא משרדי מרופד', 'כיסא ישיבות מרופד עם רגלי מתכת, תמיכה טובה לגב התחתון.'],
  'Wooden Bathroom Sink With Mirror': ['ארון אמבטיה עם מראה', 'ארון אמבטיה מעץ עם כיור משולב ומראה תואמת. עמיד ברטיבות.'],
  'Bamboo Spatula':                  ['מרית במבוק', 'מרית במבוק שלא שורטת מחבתות טפלון, ידית ארוכה ונוחה.'],
  'Black Aluminium Cup':             ['כוס אלומיניום שחורה', 'כוס אלומיניום קלה ועמידה, שומרת על טמפרטורה. מתאימה גם לטיולים.'],
  'Black Whisk':                     ['מטרפה שחורה', 'מטרפת סיליקון עמידה בחום, בטוחה לשימוש על כלים מצופים.'],
  'Boxed Blender':                   ['בלנדר שולחני', 'בלנדר עם קנקן זכוכית ולהבים מפלדת אל־חלד, שתי מהירויות ופולס.'],
  'Carbon Steel Wok':                ['ווק פלדת פחמן', 'ווק מקצועי שמתחמם מהר ומחזיק חום, מתאים לכל סוגי הכיריים.'],
  'Chopping Board':                  ['קרש חיתוך', 'קרש חיתוך עבה עם תעלת ניקוז היקפית ורגליות מונעות החלקה.'],
  'Citrus Squeezer Yellow':          ['מסחטת הדרים', 'מסחטה ידנית עם מסננת פנימית וכוס מדידה מובנית.'],
  'Egg Slicer':                      ['פורס ביצים', 'פורס ביצים עם חוטי נירוסטה דקים, פרוסות אחידות בלחיצה אחת.'],
  'Electric Stove':                  ['כירה חשמלית ניידת', 'כירה חשמלית חד־להבית עם ויסות חום רציף. פתרון נוח למטבח קטן.'],
  'Fine Mesh Strainer':              ['מסננת רשת דקה', 'מסננת נירוסטה ברשת צפופה, מתאימה גם לניפוי קמח.'],
  'Fork':                            ['מזלגות נירוסטה', 'סט מזלגות נירוסטה בגימור מלוטש, מתאימים למדיח.'],
  'Glass':                           ['כוסות זכוכית', 'סט כוסות זכוכית עבה עמידות לשבירה, מתאימות לחם ולקר.'],
  'Grater Black':                    ['פומפייה', 'פומפייה בארבעה גדלי גירוד עם ידית נוחה ובסיס יציב.'],
  'Hand Blender':                    ['בלנדר מוט', 'בלנדר מוט עם זרוע נירוסטה נשלפת לשטיפה, כולל כוס מדידה.'],
  'Ice Cube Tray':                   ['תבנית קרח סיליקון', 'תבנית סיליקון גמישה שמשחררת קוביות בקלות, עם מכסה אטום.'],
  'Kitchen Sieve':                   ['נפה למטבח', 'נפה עם ידית וווים לתלייה על סיר, נירוסטה מלאה.'],
  'Knife':                           ['סכין שף', 'סכין שף בלהב פלדה מחושל, איזון טוב וידית ארגונומית.'],
  'Lunch Box':                       ['קופסת אוכל אטומה', 'קופסה עם סגר הרמטי ומחיצה פנימית, מתאימה למיקרוגל ולמדיח.'],
  'Microwave Oven':                  ['מיקרוגל', 'מיקרוגל 20 ליטר עם תוכניות אוטומטיות וטיימר. פשוט להפעלה.'],
  'Mug Tree Stand':                  ['מתלה ספלים', 'מתלה שולחני לשישה ספלים, חוסך מקום בארון ונראה טוב על השיש.'],
};

// The three stores. `djCats` are DummyJSON category slugs — the products are real
// items with real photos, which is what makes the storefront read as a shop.
const SHOWCASE = [
  {
    slug: 'showcase-fashion',
    tag: 'אופנה',   // store-level label — /stores chips + homepage category grouping
    name: 'סטודיו לבוש',
    tagline: 'בגדי יומיום בגזרות נקיות',
    description: 'חנות לדוגמה של Dezabin — כך נראית חנות אופנה מלאה בפלטפורמה: מידות וצבעים לכל דגם, קטגוריות, וגלריית תמונות לכל מוצר.',
    hebCats: ['נשים', 'גברים', 'קולקציה חדשה'],
    djCats: ['mens-shirts', 'tops', 'womens-dresses', 'mens-shoes', 'womens-shoes', 'womens-bags'],
    colors: { primary: '#1f2937', accent: '#c2620d' },
    address: 'דיזנגוף 112, תל אביב',
  },
  {
    slug: 'showcase-tech',
    tag: 'אלקטרוניקה',   // store-level label — /stores chips + homepage category grouping
    name: 'טק ליין',
    tagline: 'אלקטרוניקה, בלי הפתעות',
    description: 'חנות לדוגמה של Dezabin — כך נראית חנות אלקטרוניקה בפלטפורמה: מפרט טכני לכל מוצר, בחירת צבע ונפח אחסון, מלאי מדויק ומשלוח מחושב אוטומטית.',
    hebCats: ['סמארטפונים', 'מחשבים', 'אביזרים'],
    djCats: ['smartphones', 'laptops', 'mobile-accessories'],
    colors: { primary: '#0f172a', accent: '#2563c9' },
    address: 'הרצל 40, חיפה',
  },
  {
    slug: 'showcase-home',
    tag: 'לבית',   // store-level label — /stores chips + homepage category grouping
    name: 'בית ומטבח',
    tagline: 'דברים טובים לבית',
    description: 'חנות לדוגמה של Dezabin — כך נראית חנות לבית ולמטבח בפלטפורמה: קטגוריות מסודרות, גדלים וצבעים לבחירה, תיאורים מלאים ואיסוף עצמי לצד משלוח.',
    hebCats: ['לבית', 'למטבח', 'עיצוב'],
    djCats: ['home-decoration', 'furniture', 'kitchen-accessories'],
    colors: { primary: '#14532d', accent: '#158a56' },
    address: 'ויצמן 8, רעננה',
  },
];

/** Page 1 of a store grid holds PRODUCTS_PAGE_SIZE (24, see lib/product-listing.ts).
 *  A showcase store carries MORE than that on purpose: the "טען עוד" button only
 *  renders when there's a second page, and a store where it never appears fails to
 *  demonstrate a feature the seller is being shown (user, 2026-07-28). Enforced by
 *  MIN_PRODUCTS_FOR_LOAD_MORE below — the seeder refuses to write a store that
 *  can't show it, rather than quietly producing a flatter demo. */
const PRODUCTS_PER_STORE = 30;
const MIN_PRODUCTS_FOR_LOAD_MORE = 25;
const SELECT = 'title,description,price,rating,stock,tags,images,thumbnail';

const djCache = new Map();
async function djProducts(slug) {
  if (djCache.has(slug)) return djCache.get(slug);
  let out = [];
  try {
    const r = await fetch(`https://dummyjson.com/products/category/${slug}?limit=40&select=${SELECT}`);
    if (r.ok) out = (await r.json()).products.filter((p) => p.images?.length);
    else console.log(`   ⚠️  DummyJSON HTTP ${r.status} for ${slug}`);
  } catch (e) {
    console.log(`   ⚠️  DummyJSON fetch failed for ${slug} (${e.message}) — is there internet access?`);
  }
  djCache.set(slug, out);
  return out;
}

/** Opening hours: a normal Israeli week (short Friday, closed Saturday). */
function weekHours() {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return Object.fromEntries(days.map((d) => [
    d,
    d === 'sat'
      ? { closed: true, open: '09:00', close: '18:00' }
      : { closed: false, open: '09:00', close: d === 'fri' ? '14:00' : '19:00' },
  ]));
}

async function main() {
  const clean = process.argv.includes('--clean');

  let sellers = read('sellers.json', []);
  let stores = read('stores.json', []);
  let products = read('store-products.json', []);
  let categories = read('store-categories.json', []);

  // Purge the previous showcase set — matched on the flag itself plus the platform
  // account, so it works even if a slug was edited by hand. Real data is untouched:
  // no real store carries `demo: true` and no real seller uses OWNER_EMAIL.
  const owner = sellers.find((s) => s.email === OWNER_EMAIL) ?? null;
  const staleStoreIds = new Set(
    stores.filter((s) => s.demo === true || (owner && s.sellerId === owner.id)).map((s) => s.id),
  );
  if (staleStoreIds.size) {
    stores = stores.filter((s) => !staleStoreIds.has(s.id));
    products = products.filter((p) => !staleStoreIds.has(p.storeId));
    categories = categories.filter((c) => !staleStoreIds.has(c.storeId));
  }

  if (clean) {
    sellers = sellers.filter((s) => s.email !== OWNER_EMAIL);
    write('sellers.json', sellers);
    write('stores.json', stores);
    write('store-products.json', products);
    write('store-categories.json', categories);
    console.log(`\n🧹 Removed ${staleStoreIds.size} showcase store(s) + the platform seller account. Real data untouched.\n`);
    return;
  }

  // Reuse the existing platform account when there is one (its password and any
  // orders/messages against it survive a re-seed); create it on the first run.
  const ownerId = owner?.id ?? uuid();
  if (!owner) {
    sellers.push({
      id: ownerId,
      email: OWNER_EMAIL,
      passwordHash: hashPassword(OWNER_PASSWORD),
      name: OWNER_NAME,
      createdAt: iso(NOW),
    });
  }

  const taken = new Set(stores.map((s) => s.slug));
  let added = 0;
  let productTotal = 0;

  console.log(`\n🏬 Seeding ${SHOWCASE.length} showcase stores (demo: true) with real photos from DummyJSON...`);

  for (const spec of SHOWCASE) {
    if (taken.has(spec.slug)) {
      console.log(`   ⚠️  slug "${spec.slug}" is taken by a real store — skipping this showcase store.`);
      continue;
    }
    // The source category rides along on each product — it's what VARIANTS_BY_CATEGORY
    // keys off, and flattening the fetches would otherwise throw it away.
    const catalog = (await Promise.all(
      spec.djCats.map(async (djCat) => (await djProducts(djCat)).map((p) => ({ ...p, djCat }))),
    )).flat();
    if (!catalog.length) {
      console.log(`   ⚠️  no products fetched for ${spec.name} — skipping.`);
      continue;
    }

    const storeId = uuid();
    const createdAt = iso(NOW - int(20, 60) * DAY);
    const catIds = spec.hebCats.map((name, order) => {
      const id = uuid();
      categories.push({ id, storeId, name, parentId: null, order, createdAt });
      return id;
    });

    // Only products we have Hebrew copy for. An Israeli mall's flagship demo store
    // showing English product names undoes the whole point of it, so a missing
    // entry drops the product instead of falling back to the source title.
    const chosen = catalog.filter((dj) => HE_CATALOG[dj.title]).slice(0, PRODUCTS_PER_STORE);
    const storeProducts = chosen.map((dj, n) => {
      const [heName, heDesc] = HE_CATALOG[dj.title];
      const p = {
        id: uuid(),
        storeId,
        // Slug stays latin (from the source title): Hebrew yields an empty slug
        // through slugify(), and a store URL has to stay ASCII-clean anyway.
        slug: `${slugify(dj.title) || 'product'}-${n + 1}`,
        name: heName,
        description: heDesc,
        price: Math.max(9, Math.round(dj.price * (0.95 + rnd() * 0.2))),
        // Placeholder — overwritten below for a variant product, where the app's
        // invariant is `stock` = the SUM of variantStock (see /api/product.ts
        // patch-variant-stock). Leaving it 0 makes every storefront card render
        // "אזל מהמלאי" while the combo picker shows plenty in stock.
        stock: Math.max(1, dj.stock ?? int(4, 30)),
        images: dj.images.slice(0, 4),
        categoryId: pick(catIds),
        tags: (dj.tags ?? []).slice(0, 5),
        createdAt: iso(NOW - int(1, 45) * DAY),
      };
      const variants = VARIANTS_BY_CATEGORY[dj.djCat] ?? null;
      if (variants) {
        p.variants = variants;
        p.variantStock = buildVariantStock(variants);
        p.stock = Object.values(p.variantStock).reduce((a, b) => a + b, 0);
      }
      return p;
    });

    if (storeProducts.length < MIN_PRODUCTS_FOR_LOAD_MORE) {
      console.log(`   ⚠️  ${spec.name}: only ${storeProducts.length} translated products — under the ${MIN_PRODUCTS_FOR_LOAD_MORE} needed for "טען עוד". Add entries to HE_CATALOG. Skipping.`);
      continue;
    }

    products.push(...storeProducts);
    productTotal += storeProducts.length;

    stores.push({
      id: storeId,
      sellerId: ownerId,
      slug: spec.slug,
      name: spec.name,
      tagline: spec.tagline,
      description: spec.description,
      colors: spec.colors,
      categories: [spec.tag],
      demo: true,
      // No bannerImage on purpose. The dev seeder reuses a product photo as the
      // banner, which crops to a giant close-up of one shirt and is the first
      // thing a prospective seller sees — the bannerless header reads cleaner,
      // and inventing a fake brand banner would be worse.
      profileImage: (storeProducts[1] ?? storeProducts[0]).images[0],
      // Self-pickup on for one of the three, so the checkout's pickup path is
      // actually reachable in a showcase store rather than only described.
      shipping: { selfPickup: spec.slug === 'showcase-home' },
      address: spec.address,
      addressVisible: true,
      hours: weekHours(),
      hoursVisible: true,
      createdAt,
    });
    taken.add(spec.slug);
    added++;
    console.log(`   ✓ ${spec.name} (/${spec.slug}) — ${storeProducts.length} products`);
  }

  if (!added) {
    console.error('\n❌ Nothing seeded — no products fetched (check internet access). Files unchanged.\n');
    process.exit(1);
  }

  write('sellers.json', sellers);
  write('stores.json', stores);
  write('store-products.json', products);
  write('store-categories.json', categories);

  console.log(`\n✅ ${added} showcase store(s), ${productTotal} products.`);
  console.log(`   They are noindex, out of the sitemap/feed/IndexNow, uncheckoutable, and`);
  console.log(`   leave the shopper surfaces on their own once there are 5 real stores.`);
  console.log(`   Platform account: ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
  console.log(`   Remove with:  node scripts/seed-showcase-stores.mjs --clean\n`);
}

main().catch((e) => { console.error('showcase seed failed:', e); process.exit(1); });
