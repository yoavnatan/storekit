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
 *  Deliberately SHORT. This block used to also carry "muted and desaturated",
 *  "generous negative space", "no props or clutter" — an attempt to spell out
 *  what expensive looks like, which instead spelled out what empty looks like
 *  and produced the dead catalog described at LIFE_DIRECTION below. What is left
 *  here is only the part that was actually doing work: quality of rendering, and
 *  the two things to stay away from. Everything about composition, light and
 *  content now lives in LIFE_DIRECTION, where it can be positive rather than a
 *  list of prohibitions. */
export const QUALITY_DIRECTION =
  'sophisticated and expensive-looking, editorial quality, photorealistic, high detail, '
  + 'nothing garish, nothing that looks like a discount flyer or clip art';

/**
 * LIFE. Added 2026-08-12 after the owner looked at the first full catalog and said the store felt
 * "מה זה מתה", then named exactly why — and he was right on all four counts:
 *
 *   "היעדר אלמנט אנושי או תנועה"      no hands, no wear, no sense of the object being used
 *   "פלטת צבעים מונוכרומטית ושטוחה"   beige on beige, no value separation, no depth
 *   "תאורה מלאכותית ואחידה"           soft and evenly diffused, no highlight, no shadow shape
 *   "עריכה סימטרית וסטרילית"          dead-centre, equal margins, catalogued rather than shot
 *
 * Every one of those was something the previous QUALITY_DIRECTION literally asked for, in those
 * words — "muted and desaturated rather than bright", "evenly diffused", "centred composition",
 * "generous even margin", "no props or clutter". That block was written to answer an earlier note
 * ("שיהיה sophisticated, לא זול") and it over-corrected: restraint was pushed until nothing was
 * left to look at. Both notes are real, and this is where they are held together — the sophistication
 * lives in the MATERIALS and the light quality, and the life lives in movement, asymmetry and
 * contrast. Expensive is not the same as empty.
 *
 * Hands and cropped figures are allowed and wanted; FACES stay out (see NEGATIVE_PROMPT) — a
 * generated face that resembles a real person is a likeness problem on a live commercial domain,
 * and a hand shows use just as well.
 */
export const LIFE_DIRECTION = [
  // 1. Human element — the single biggest one, per the owner's own list.
  'show the product in USE: worn on a cropped figure, held in a hand, or being reached for — for '
  + 'clothing and shoes, on a body rather than laid flat, so the fit and the drape are visible',
  // 3. Dynamic light.
  'directional natural light like late-afternoon sun through a window, with highlights and shadows '
  + 'that have real shape and fall across the surface — never flat, never evenly diffused',
  // 4. Depth of field.
  'shallow depth of field, the background falling gently out of focus behind the product, cinematic',
  // 2 + 5. Props that tell a story, chosen to CONTRAST in material.
  'styled with two or three small props that say how the product is lived with, deliberately in '
  + 'contrasting materials and textures — rough wood or stone against smooth fabric, a green plant '
  + 'against canvas — arranged casually as though someone just set them down',
  // 6. Accent colour against the neutral base.
  'keep the palette warm and natural but let ONE small element carry a real accent colour so the '
  + 'eye has somewhere to land',
  // The composition note that replaces "centred, generous even margin".
  'off-centre asymmetric composition at a natural angle, shot from a human viewpoint rather than '
  + 'square-on, some edges cropped by the frame',
  'alive, warm and inviting — the kind of picture that makes you want the thing',
].join('; ');

/** Shared by every prompt. Kept separate from the per-store direction because
 *  these are the rules that must hold no matter how the art direction changes —
 *  they are what keeps the output legally safe and visually usable as a product
 *  cell, not what makes it pretty. */
export const NEGATIVE_PROMPT = [
  'no text of any kind',
  'no watermark',
  'no logo, no brand mark, no label with a brand name',
  'not a real, identifiable commercial product',
  // Hands, arms and figures cropped above the shoulders are WANTED — they are most of what makes a
  // catalog look alive. Only the face is excluded, and for a specific reason rather than squeamish-
  // ness: a generated face that resembles a real person is a likeness problem on a live commercial
  // domain, and it buys nothing a hand does not.
  'no visible faces, crop above the shoulders if a person appears',
  'not flat, not evenly lit, not dead-centre, not sterile',
  'no collage, no split frame, single product only',
].join(', ');

/** Every image is generated square and delivered through `lib/cdn.ts`, which
 *  crops per surface. 2K rather than 1K because the banner and the product-page
 *  hero both render far larger than a grid cell, and upscaling is the pixelation
 *  the owner explicitly ruled out. */
/**
 * 2K everywhere, and this was MEASURED after getting it wrong once.
 *
 * Asked for a cheaper route, the first answer was to drop products to 1K on the reasoning that the
 * grid delivers at `w_400` and the product page at `w_600`–`w_800`. That reasoning stopped one
 * request short: the product page also asks for **`w_1600`** for the lightbox, and `lib/cdn.ts`
 * uses `c_limit`, which deliberately never upscales. A 1024px source therefore gets delivered into
 * a 1600px slot at its own size and the browser stretches it — soft, exactly the "low quality" the
 * owner reported. Saving $0.034 an image by making the biggest view the worst one is not a saving.
 *
 * The real saving is COUNT, not size: only some products carry a full gallery (`viewsForProduct`),
 * which took the run from ~1,600 images to ~724.
 */
export const IMAGE_SIZE = '2K';
export const BANNER_IMAGE_SIZE = '2K';
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
      'the corner of a sunlit fashion studio — a rail of clothes in soft focus, a linen curtain '
      + 'lifting in the light, a woven bag and a pair of sandals on a bentwood chair, warm plaster '
      + 'wall behind, one long shaft of afternoon sun across the floor',
    logoSubject: 'a single smooth arch form in terracotta on a warm cream ground',
    /** Warm sand studio. Not white — the owner asked for at least one store off
     *  plain white, and this is the softer of the two that are. */
    artDirection:
      'editorial fashion photograph in a sunlit Tel Aviv apartment — a warm sand-plaster wall, a '
      + 'linen curtain moving in the light, a corner of oak floor. Clothing is WORN by a cropped '
      + 'figure (never a face) so the cut and the drape read; bags and accessories are carried, '
      + 'held, or spilling their contents on a chair. Late-afternoon sun rakes across the frame and '
      + 'throws a shaped shadow. Styled with a couple of lived-in props — sunglasses, an open book, '
      + 'a coffee cup, a straw hat — chosen so their material contrasts with the fabric',
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
      'a lived-in Mediterranean living room — an oak table with a half-drunk coffee and an open '
      + 'book, hand-thrown ceramics catching the light, a linen throw over a chair arm, an olive '
      + 'branch in a clay vase, deep window light and long shadows across travertine',
    logoSubject: 'a single stylised olive leaf shape in muted sage green on a warm off-white ground',
    /** The explicitly non-white store. Objects sit in a real room on a real
     *  surface, which is also the only honest way to shoot furniture — a sofa on
     *  a white sweep has no scale. */
    artDirection:
      'warm interior lifestyle photograph, the object resting on a natural surface such as '
      + 'travertine stone, pale oak or raw linen, soft directional window daylight from the side, '
      + 'a long shadow with real shape, a palette of sage green, cream and warm clay lifted by one '
      + 'accent colour somewhere small, a room that is clearly LIVED IN — a hand pouring, setting '
      + 'down or reaching, crumbs and a folded napkin, a book left open, a plant leaning into frame. '
      + 'The product is the subject but the room is around it, '
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
    /** The only store that opts OUT of the full styling language — see RESTRAINED_LIFE_DIRECTION.
     *  Its whole point is to be the plain one, in its copy and in its pictures alike. */
    restrained: true,
    categories: ['שמע', 'מחשוב ועבודה', 'טעינה וחשמל', 'בית חכם', 'צילום ווידאו'],
    bannerSubject:
      'a working desk at blue hour — a monitor glow on graphite and brushed steel, a coiled cable, '
      + 'headphones resting on a notebook, one small warm lamp and a single green indicator light, '
      + 'crisp specular highlights along the metal edges',
    logoSubject: 'a single precise geometric mark of three stacked bars in deep blue on a light grey ground',
    /** The solid one. Cool grey rather than pure white: a true #fff sweep blows
     *  out a white product's own edge, which is exactly the case this store is
     *  full of. The grey keeps the silhouette. */
    artDirection:
      'the device on a real working desk in daylight — pale microcement or dark oak, a hand on it '
      + 'or reaching for it, a cable coiled nearby, a notebook or a coffee at the edge of frame. '
      + 'Cool daylight from one side with crisp specular highlights along the metal edges and a '
      + 'defined shadow; the palette stays graphite, steel and off-white with a single accent — a '
      + 'green indicator LED, a cable in colour. Precise and technical, but switched on and used, '
      + 'shot at a three-quarter angle with shallow depth of field',
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
      'a Tel Aviv balcony full of plants in hard morning sun — terracotta pots at several heights, '
      + 'a watering can and secateurs on a concrete ledge, soil on the surface, monstera and olive '
      + 'leaves cutting sharp graphic shadows across a pale wall',
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
      + 'green as the strongest colour against a concrete and clay palette. Someone is TENDING it — '
      + 'hands repotting, misting, or carrying the pot — with soil on the surface, a watering can or '
      + 'secateurs just set down, and other plants softly out of focus behind. Hard morning sun '
      + 'throws sharp graphic leaf shadows across the wall; shot slightly from above at an angle',
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

/**
 * The GALLERY. One picture per product is a spreadsheet, not a shop (owner, 2026-08-12: "צריך המון
 * תמונות על כל מוצר … הייתי יוצא ממנה כלקוח אחרי פחות מ-10 שניות").
 *
 * He is right, and it is also the feature the storefront is built for and was not demonstrating:
 * the product card cross-fades between images on hover, the card carries dots, the product page has
 * a carousel and a lightbox, and every one of those was inert with a single image. A showcase store
 * that cannot show its own gallery is failing at the one job it has.
 *
 * Four views, because they are four different QUESTIONS a shopper asks — what is it, what is it
 * made of, how big is it / how does it wear, and would it suit my place. Shooting the same object
 * four times from four angles answers "what is it" four times, which is what makes a gallery
 * boring; these deliberately change subject distance and context, not just camera position.
 *
 * `main` is first and is what every grid cell, the cart and the feed use — so it stays the clean,
 * legible one. The other three are the reward for clicking.
 */
export const PRODUCT_VIEWS = [
  {
    key: 'main',
    modifier: 'The primary catalog shot: the whole product clearly legible and filling most of the '
      + 'frame, styled and lit as described but never ambiguous about what is being sold',
  },
  {
    key: 'detail',
    modifier: 'A tight macro detail: the material itself — the weave, grain, glaze, stitching, '
      + 'seam, hinge or edge finish — filling the frame at close range with very shallow focus, so '
      + 'the quality of the thing is what you see',
  },
  {
    key: 'inuse',
    modifier: 'The product actually in use by a cropped figure (never a face) — worn and moving, '
      + 'held, poured from, carried, typed on, being planted — caught mid-gesture rather than posed',
  },
  {
    key: 'context',
    modifier: 'A wider lifestyle frame with the product smaller in a real room or street, giving '
      + 'its scale and the life around it, other things half in shot, the product still the subject',
  },
];

/**
 * A quieter LIFE_DIRECTION, for a store that should not be styled (owner, 2026-08-12: "חנות
 * אלקטרוניקה לא צריכה את כל הבלאגן העיצובי הזה, היא יכולה להיות הרבה יותר בסיסית").
 *
 * Right, and it is the same point the store's own entry already makes about its COPY — Teklar is
 * deliberately the solid one. Applying one styling language to all four undid that: a laptop stand
 * photographed with a straw hat and an open book beside it is not restraint, it is a lifestyle
 * brochure for a hardware shop, and a seller of technical goods would not recognise their business
 * in it.
 *
 * So this keeps the parts that fix DEAD — real light, depth, a hand, an angle — and drops the parts
 * that add STORY: no prop styling, no accent colour hunting, no room around the object.
 */
const RESTRAINED_LIFE_DIRECTION = [
  'the product in use or being handled — a hand on it or reaching for it — rather than posed alone',
  'directional daylight with crisp highlights along the edges and a shadow that has shape, never '
  + 'flat or evenly diffused',
  'shallow depth of field with the background falling out of focus',
  'off-centre at a natural three-quarter angle, shot from a human viewpoint',
  'clean and uncluttered — at most one secondary object, no styling props, no set dressing',
].join('; ');

/**
 * How many pictures THIS product gets (owner, 2026-08-12: "לא לכל ה-100 צריך להיות עוד תמונות, רק
 * מדגמי, לכמה מהמוצרים").
 *
 * Right on both counts. It is most of the cost — four views on every row is 1,600 images — and a
 * real shop does not have four photographs of every single item either: the hero pieces are shot
 * properly and the basics get one frame. Varying it is more convincing than uniformity, not less.
 *
 * Deterministic from the name, so a re-run asks for exactly the same set and never re-buys a
 * picture it already has. Roughly one in six gets the full gallery, one in three gets two, the rest
 * get one — which lands at about 1.7 pictures per product.
 */
export function viewsForProduct(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const bucket = h % 6;
  if (bucket === 0) return PRODUCT_VIEWS;              // full gallery
  if (bucket === 1 || bucket === 2) return PRODUCT_VIEWS.slice(0, 2);  // hero + one
  return PRODUCT_VIEWS.slice(0, 1);                    // just the hero
}

export function imagePrompt(store, subject, view = PRODUCT_VIEWS[0]) {
  const life = store.restrained ? RESTRAINED_LIFE_DIRECTION : LIFE_DIRECTION;
  return `${subject}. ${view.modifier}. ${FIDELITY}. ${store.artDirection}. ${life}. `
    + `${REGION_DIRECTION}. ${QUALITY_DIRECTION}. ${NEGATIVE_PROMPT}.`;
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
/**
 * The banner is a SCENE, not a texture (owner, 2026-08-12: "לא סתם פלקט עם SVG").
 *
 * The first version asked for an abstract textless surface with "the centre kept calm and
 * uncluttered, no focal object competing for attention" — which is a specification for wallpaper.
 * Laying a wordmark on wallpaper is exactly the placard he rejected: nothing in the picture was
 * allowed to be interesting, so nothing was.
 *
 * A real shop's hero image is a photograph of the shop's world with a quiet REGION for the name,
 * not a picture with nothing in it. So: a full editorial scene, composed so its visual weight sits
 * to one side and the other side falls into soft shadow or open surface — the way a magazine cover
 * leaves room for its masthead without the photograph going blank.
 */
export function bannerPrompt(store) {
  return `A wide editorial hero photograph for a shop's banner: ${store.bannerSubject}. `
    + `A real scene with depth and atmosphere, not a flat backdrop — foreground, middle and `
    + `background at different focal distances, strong directional daylight raking across it, `
    + `and genuine visual interest. Compose the weight to ONE side and let the opposite third `
    + `fall into soft shadow or open surface, so a name can sit there without covering anything. `
    + `${REGION_DIRECTION}. ${QUALITY_DIRECTION}. ${NEGATIVE_PROMPT}.`;
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
