/**
 * The three showcase stores — identity and ART DIRECTION, in one place.
 *
 * This file is the single source for what the three stores ARE: name, palette,
 * category list, and the photographic language every one of their product images
 * is generated against. Two very different consumers read it and must never
 * disagree — `seed-showcase-stores.mjs` (which writes the rows) and
 * `generate-showcase-images.mjs` (which produces the pictures those rows point
 * at). When they disagreed, the symptom was a store whose palette said "warm
 * sand" and whose photos came back on a cold white sweep.
 *
 * ── Why these three, and not three others (owner, 2026-08-12) ────────────────
 * The brief was "the three that best demonstrate the site works for EVERY kind of
 * product", so the trio is chosen by what each one STRESSES, not by what it sells:
 *
 *   סהר      apparel — the variant matrix (size × colour), the hardest catalog
 *                      shape the platform has to render, plus galleries.
 *   שקמה     home    — bulk and weight: furniture and lighting are what exercise
 *                      shipping weight, self-pickup and a high per-item price.
 *   Teklar   tech    — precision: spec-led copy, exact stock, no decoration.
 *                      This is deliberately the SOLID one (owner asked for one).
 *
 * ── Why the names are coined, and in Latin script (owner, 2026-08-12) ────────
 * The first pass named them קומה / לופט / וולט and the third was struck out
 * immediately: וולט is Wolt, which every Israeli reads as the delivery company.
 * The rule that came out of it is the useful part — a showcase store's name must
 * not evoke a business that already exists, because the store sits on a live
 * commercial domain and a borrowed name is a trademark problem before it is a
 * taste problem.
 *
 * Two of the three are Hebrew, at the owner's correction the same day —
 * "אנחנו בישראל". סהר (crescent moon) and שקמה (sycamore) are ordinary Hebrew
 * words used as brands rather than as descriptions, which is how a good Israeli
 * small brand is actually named; neither says what the shop sells, and that is
 * the point. Teklar stays Latin so the trio is not uniform, and it is the tech
 * store because that is the one category where a coined Latin name reads native
 * here. All three are still worth 30 seconds of the owner's eyes before launch,
 * which is the row in GO_LIVE §6.2.
 *
 * ── The two style constraints, also the owner's, also 2026-08-12 ─────────────
 * 1. "אווירה של משהו כיפי, שמושך לקנות — לא חולצת משבצות משנות ה-90." The old
 *    catalog was stock photos of 90s plaid and refurbished iPhones; it read as a
 *    liquidation sale. Warmth, daylight and colour are therefore not decoration
 *    here, they are the requirement.
 * 2. "צריך להתאים לקהל היעד — עסקים קטנים/בינוניים." The viewer of these stores
 *    is a PROSPECTIVE SELLER, not a shopper. So each store has to look like the
 *    best version of a business he could plausibly BE — a good small Israeli
 *    brand — and never like a multinational he could not. That rules out both
 *    directions: no bargain-bin, and no luxury-house fantasy.
 *
 * ── No real brands, anywhere, and this one is not aesthetic ──────────────────
 * The previous catalog listed "אייפון 13 Pro", "מקבוק פרו" and "נייקי" beside
 * scraped photos of those exact products. On a live domain that is a trademark
 * problem and a Merchant Center "misrepresentation" problem — the class that
 * suspends the ACCOUNT, i.e. every seller's ads at once (memory
 * `project_ad_platform_account_risk`). Every product here is generic and
 * credible instead: "אוזניות קשת אלחוטיות", never a model number someone owns.
 * `NEGATIVE_PROMPT` enforces the same rule on the pictures.
 */

/** Israel, 2026 (owner, same day). This is a real constraint on the pictures and
 *  not a flourish: the default an image model reaches for is Nordic-minimal or
 *  American-mall, and both read as an import here. The Levantine version is warm
 *  daylight, sand and plaster, terracotta, olive and clay, natural stone and pale
 *  wood — the palette of a good Tel Aviv or Haifa shop, which is also what the
 *  three stores' `colors` were chosen from. It rides on every prompt. */
export const REGION_DIRECTION =
  'contemporary Israeli / Mediterranean 2026 aesthetic, warm natural daylight, '
  + 'sand, plaster, terracotta, olive and clay tones, nothing cold or Nordic-grey';

/** "שיהיה קצת sophisticated, לא משהו שמרגיש זול" (owner, 2026-08-12).
 *
 *  This pulls AGAINST the "כיפי ומושך לקנות" note, and holding both at once is
 *  the actual brief. The resolution is that the warmth comes from LIGHT and
 *  MATERIAL, never from saturation or props: an image model asked for "fun"
 *  reaches for bright colour, confetti and a busy set, and that is precisely the
 *  cheap look. Restraint, negative space and one considered object read as
 *  expensive; a full frame reads as a discount flyer. So the fun is in the
 *  daylight and the palette, and the sophistication is in what is left out. */
export const QUALITY_DIRECTION =
  'sophisticated and restrained, editorial quality, considered composition with generous negative '
  + 'space, subtle and expensive-looking, muted and desaturated rather than bright, no props or '
  + 'clutter, nothing garish, nothing that looks like a discount flyer or clip art, '
  + 'photorealistic, high detail, crisp and clean';

/** Shared by every prompt. Kept separate from the per-store direction because
 *  these are the rules that must hold no matter how the art direction changes —
 *  they are what keeps the output legally safe and visually usable as a product
 *  cell, not what makes it pretty. */
export const NEGATIVE_PROMPT = [
  'no text of any kind',
  'no watermark',
  'no logo, no brand mark, no label with a brand name',
  'not a real, identifiable commercial product',
  'no human faces',
  'no collage, no split frame, single product only',
].join(', ');

/** Every image is generated square and delivered through `lib/cdn.ts`, which
 *  crops per surface. 2K rather than 1K because the banner and the product-page
 *  hero both render far larger than a grid cell, and upscaling is the pixelation
 *  the owner explicitly ruled out. */
export const IMAGE_SIZE = '2K';
/** Products and logos: square. `lib/cdn.ts` crops per surface and every product surface is either
 *  square or close to it, so a square source is never mostly discarded. */
export const IMAGE_ASPECT = '1:1';
/** The banner is NOT square, and generating it square wastes most of the frame — the store header
 *  is a 3/1 band (`BANNER_RATIO`), so a 1:1 source loses two thirds of its height to the crop and,
 *  worse, the composition the model actually balanced. 16:9 is the widest ratio the image API
 *  offers; cropping 16:9 to 3:1 trims a little top and bottom off a picture that was composed
 *  wide, which is a different thing from salvaging a band out of a square. */
export const BANNER_ASPECT = '16:9';

export const SHOWCASE_STORES = [
  {
    slug: 'showcase-fashion',
    name: 'סהר',
    tag: 'אופנה',
    tagline: 'אופנה יומיומית שכיף ללבוש',
    description:
      'חנות לדוגמה של Dezabin — כך נראית חנות אופנה מלאה בפלטפורמה: מידה וצבע לכל דגם, '
      + 'קטגוריות מסודרות, גלריית תמונות לכל מוצר ומלאי שמתעדכן לפי הצירוף שנבחר.',
    colors: { primary: '#2b2118', accent: '#c4622d' },
    address: 'דיזנגוף 112, תל אביב',
    selfPickup: false,
    // Mutually exclusive on purpose: a product carries exactly ONE categoryId, so
    // a curated shelf like "קולקציה חדשה" cannot be a category here without
    // stealing products out of the real ones and leaving them half empty.
    categories: ['נשים', 'גברים', 'הנעלה', 'תיקים', 'תכשיטים ואביזרים'],
    bannerSubject:
      'a soft-focus wall of warm sand-coloured plaster in raking afternoon light, with the faint '
      + 'shadow of a linen curtain falling across it',
    logoSubject: 'a single smooth arch form in terracotta on a warm cream ground',
    /** Warm sand studio. Not white — the owner asked for at least one store off
     *  plain white, and this is the softer of the two that are. */
    artDirection:
      'professional e-commerce fashion photograph, single garment or accessory presented on an '
      + 'invisible mannequin or laid flat on warm natural linen, seamless warm sand-plaster '
      + 'backdrop in a soft beige tone, one soft key light from the upper left, gentle natural '
      + 'shadow falling to the lower right, warm and inviting 2026 editorial catalog styling, '
      + 'sharp focus, generous even margin around the subject, centred composition',
  },
  {
    slug: 'showcase-home',
    name: 'שקמה',
    tag: 'לבית',
    tagline: 'דברים יפים לבית, בלי להתאמץ',
    description:
      'חנות לדוגמה של Dezabin — כך נראית חנות לבית ולעיצוב בפלטפורמה: מוצרים גדולים וכבדים '
      + 'עם משקל למשלוח, איסוף עצמי לצד משלוח שליח, גדלים וגוונים לבחירה ותיאורים מלאים.',
    colors: { primary: '#1f2d28', accent: '#6f8f5f' },
    address: 'ויצמן 8, רעננה',
    selfPickup: true,
    categories: ['ריהוט', 'תאורה', 'קרמיקה וכלי הגשה', 'טקסטיל', 'עיצוב ואקססוריז'],
    bannerSubject:
      'a quiet corner of a Mediterranean interior — pale travertine, a sliver of olive foliage and '
      + 'soft window daylight, seen slightly out of focus',
    logoSubject: 'a single stylised olive leaf shape in muted sage green on a warm off-white ground',
    /** The explicitly non-white store. Objects sit in a real room on a real
     *  surface, which is also the only honest way to shoot furniture — a sofa on
     *  a white sweep has no scale. */
    artDirection:
      'warm interior lifestyle photograph, the object resting on a natural surface such as '
      + 'travertine stone, pale oak or raw linen, soft directional window daylight from the side, '
      + 'a long gentle shadow, muted palette of sage green, cream and warm clay, styled but '
      + 'uncluttered with plenty of empty space, calm modern Mediterranean interior, sharp focus, '
      + 'the product clearly the single subject and fully in frame, '
      // The owner floated a separate handmade-ceramics store and it was argued down — שקמה's
      // "קרמיקה וכלי הגשה" is already its largest category (22 rows), and a fifth store selling the
      // same goods makes the mall read thin rather than full. The LOOK he wanted is right, though,
      // so it lands here instead, at no cost: anything ceramic in this store is studio pottery, not
      // factory tableware. Uneven glaze and a hand-thrown lip are the whole difference.
      + 'any ceramic or stoneware item is hand-thrown studio pottery — a slightly irregular rim, '
      + 'visible throwing rings, an uneven reactive glaze that pools and breaks over the edges, '
      + 'quietly imperfect and clearly made by hand rather than mass produced',
  },
  {
    slug: 'showcase-tech',
    name: 'Teklar',
    tag: 'אלקטרוניקה',
    tagline: 'אלקטרוניקה, בלי הפתעות',
    description:
      'חנות לדוגמה של Dezabin — כך נראית חנות אלקטרוניקה בפלטפורמה: מפרט טכני לכל מוצר, '
      + 'בחירת צבע ונפח, מלאי מדויק לכל דגם ומשלוח שמחושב אוטומטית לפי כתובת.',
    colors: { primary: '#141a24', accent: '#2f6fe4' },
    address: 'הרצל 40, חיפה',
    selfPickup: false,
    categories: ['שמע', 'מחשוב ועבודה', 'טעינה וחשמל', 'בית חכם', 'צילום ווידאו'],
    bannerSubject:
      'a smooth dark graphite surface with one clean diagonal edge of soft light crossing it, '
      + 'minimal and precise',
    logoSubject: 'a single precise geometric mark of three stacked bars in deep blue on a light grey ground',
    /** The solid one. Cool grey rather than pure white: a true #fff sweep blows
     *  out a white product's own edge, which is exactly the case this store is
     *  full of. The grey keeps the silhouette. */
    artDirection:
      'precise studio product photograph on a seamless cool light-grey sweep, even diffused '
      + 'lighting with crisp controlled highlights, a subtle soft reflection directly beneath the '
      + 'product, restrained and technical, product-forward framing straight on or at a slight '
      + 'three-quarter angle, immaculately clean, sharp focus edge to edge, generous margin',
  },
  {
    slug: 'showcase-plants',
    name: 'אדנית',
    tag: 'משתלה',
    tagline: 'ירוק לבית ולמרפסת',
    description:
      'חנות לדוגמה של Dezabin — כך נראית משתלה אורבנית בפלטפורמה: צמחים חיים לפי גודל עציץ, '
      + 'הוראות טיפול לכל מוצר, איסוף עצמי מהחממה לצד משלוח, ומלאי שמשתנה עם העונה.',
    colors: { primary: '#243024', accent: '#4f9a52' },
    address: 'המלאכה 12, תל אביב',
    // The second self-pickup store, and for a different reason than שקמה's: a large plant is
    // awkward to ship rather than merely heavy, and "come and collect it" is what a real urban
    // nursery actually offers. Two stores using the same feature for two different reasons is a
    // better demonstration than one.
    selfPickup: true,
    categories: ['צמחי פנים', 'מרפסת וגינה', 'עציצים ומצעים', 'טיפול והזנה', 'כלי גינון'],
    bannerSubject:
      'a bright city balcony corner in raw concrete and pale microcement, several potted green '
      + 'plants at the edges casting crisp graphic leaf shadows across the empty middle',
    logoSubject: 'a single stylised sprout with two leaves in fresh green on a pale concrete ground',
    /** URBAN, and that word is doing the work. שקמה is already the warm-interior store, so a
     *  nursery shot on travertine and oak would read as the same shop with plants in it. Concrete,
     *  hard graphic daylight and sharp leaf shadows are a different world, and they are also the
     *  honest setting for a משתלה אורבנית — the customer's balcony, not a farmhouse. Living green
     *  is the only saturated colour anywhere in the four catalogs, which is what makes this store
     *  read instantly as a different kind of business. */
    artDirection:
      'a living plant or gardening object photographed in a bright modern urban setting, resting on '
      + 'raw concrete, pale microcement or a simple painted balcony ledge, strong directional '
      + 'daylight throwing crisp graphic leaf shadows, terracotta and stoneware pots, fresh living '
      + 'green as the only saturated colour in an otherwise muted concrete and clay palette, '
      + 'sharp focus, the plant clearly the single subject and fully in frame with generous margin',
  },
];

/** The full prompt for one product image. Composed here rather than at either
 *  call site so the two never drift, and so the negative clause can never be
 *  forgotten on a new caller — that omission is what puts a brand logo into a
 *  picture nobody looks at again before it ships. */
/** The clause that makes the picture answerable to the COPY.
 *
 *  Found on the first real batch: the subject said "a midi A-line dress" and the model returned a
 *  floor-length maxi — beautiful, and wrong next to a Hebrew description that says the hem falls
 *  below the knee. On a demo store nobody measures a hem, but a listing whose photograph
 *  contradicts its own text is exactly the amateurish tell this catalog exists to avoid, and it
 *  costs one sentence to ask for. Applies to products only; a banner has nothing to contradict. */
const FIDELITY = 'render exactly what is described — the stated length, cut, material and colour, '
  + 'no substitutions and no embellishments beyond the description';

export function imagePrompt(store, subject) {
  return `${subject}. ${FIDELITY}. ${store.artDirection}. ${REGION_DIRECTION}. `
    + `${QUALITY_DIRECTION}. ${NEGATIVE_PROMPT}.`;
}

/** The store's own two brand images. Same art direction as its products — that is
 *  the whole point of generating them from this file rather than picking them —
 *  but a different subject, because neither is a product.
 *
 *  **Neither carries text, deliberately.** The store's name goes on the banner as
 *  real SVG text in `StoreDemoBanner.astro`, not baked into the picture: an image
 *  model renders Hebrew and Latin lettering unreliably at best, and a wordmark
 *  drawn as vector stays crisp at every width, survives a rename, and is readable
 *  to a screen reader and to Google. Asking the model for a "logo with the name"
 *  is how a showcase store ends up with a misspelt sign in its own banner. */
export function bannerPrompt(store) {
  return `An abstract, textless background image for a shop banner: ${store.bannerSubject}. `
    + `${REGION_DIRECTION}. ${QUALITY_DIRECTION}. Wide composition, the centre kept calm and `
    + `uncluttered so text can be laid over it, no focal object competing for attention. `
    + `${NEGATIVE_PROMPT}.`;
}

export function logoPrompt(store) {
  return `A minimal abstract emblem for a shop: ${store.logoSubject}. Flat, geometric, a single `
    + `simple form, centred on a plain background, generous margin, vector-like and clean, `
    + `${QUALITY_DIRECTION}. ${NEGATIVE_PROMPT}.`;
}

export function storeBySlug(slug) {
  const store = SHOWCASE_STORES.find((s) => s.slug === slug);
  if (!store) throw new Error(`unknown showcase store ${JSON.stringify(slug)}`);
  return store;
}
