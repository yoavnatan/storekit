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
/**
 * Rewritten 2026-08-12, and this is the clause that was making all four stores look like one shop.
 *
 * The owner's note: "הכל מרגיש לי כאילו דומה מדי אחד לשני … תחשוב על חנויות שהן לא בהכרח מעצבי על,
 * אלא אנשים פשוטים יחסית, אל תעשה את זה מכוער אבל חשוב שיהיה יחסית מחובר לקהל."
 *
 * "Sophisticated, expensive-looking, editorial" is a house style, and a house style applied to four
 * different businesses produces four pictures from the same magazine. Worse, it aims at the wrong
 * shop: the viewer here is a small Israeli seller deciding whether this platform is for people like
 * him, and a luxury campaign says no. It is also the second time this same block has over-corrected
 * (see LIFE_DIRECTION's header for the first, when "restraint" produced a dead catalog).
 *
 * So what is left is only what is true of a GOOD picture regardless of the shop's price point:
 * real, clean, well-lit, honest about the product. How expensive a store looks is now decided
 * store by store, in its own `artDirection`, which is where a difference between shops can actually
 * live.
 */
export const QUALITY_DIRECTION =
  'a well-made photograph for a real, independent shop — clean, honest and appealing, the kind a '
  + 'good small business would be proud of rather than a luxury brand campaign. Photorealistic and '
  + 'sharp on the product itself. Nothing garish, nothing that looks like a discount flyer or clip '
  + 'art, and equally nothing aloof, austere or intimidatingly high-fashion';

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
  // ── The rule that outranks every other clause in this list (owner, 2026-08-12) ──────────────
  // "אם יש תמונה של אלמנט, צריך שייראו את כל האלמנט … בהמון תמונות הם מסתירים את האלמנט או
  // שהאלמנט מוסתר בריבוי פרטים." Half this block used to actively cause that: it asked for two or
  // three props, for edges cropped by the frame, and for a human element in every single shot. On
  // a lifestyle photograph that reads as atmosphere; on a CATALOG CELL 400px wide it reads as a
  // product you cannot make out. This clause is first because when it conflicts with styling,
  // styling loses — a shopper who cannot see the thing does not buy the thing.
  'THE ENTIRE PRODUCT IS VISIBLE, whole and unobstructed, complete within the frame and never '
  + 'cropped by its edges. Nothing overlaps it, nothing passes in front of it, nothing rests on '
  + 'top of it. It is the largest and clearest thing in the picture',
  // Added after a rug came back with a third of it outside the frame (owner, 2026-08-12: "כמו
  // שהשטיח יצא בחלקו מחוץ לתמונה"). The clause above says "complete within the frame" and it was
  // not enough for the one shape it matters most for: a big flat thing photographed at an angle
  // fills the frame naturally, and the model reads "large in frame" as permission to run it off
  // the edge. Large flat goods therefore get the rule said again, in their own terms.
  'for a large flat item — a rug, a throw, a blanket, a tablecloth, a mat — the WHOLE item lies '
  + 'inside the frame with clear space on all four sides, every edge and corner visible',
  // Owner, 2026-08-12: "צריך הרבה פחות פוקוס על פרטים נוספים שהם לא המוצר."
  'everything that is not the product is quiet and secondary: soft, simple, low in contrast and '
  + 'well out of focus. No detailed shelves, no busy backgrounds, no second subject',
  // 1. Human element — kept, but conditional. It was unconditional, and that is how a hand ended
  // up across the front of objects nobody wears.
  'a person appears ONLY if they are actually wearing or using the product and only where that '
  + 'makes sense for this kind of goods — clothing, shoes, bags and jewellery are worn on a cropped '
  + 'figure so the fit and the drape read. Otherwise no person at all: no hand resting on it, no '
  + 'arm reaching across it, nobody holding it in a way that covers any part of it',
  // 3. Dynamic light.
  'directional natural light like late-afternoon sun through a window, with highlights and shadows '
  + 'that have real shape and fall across the surface — never flat, never evenly diffused',
  // 4. Depth of field.
  'shallow depth of field, the background falling gently out of focus behind the product, cinematic',
  // Props are GONE, not reduced (owner, 2026-08-12, with a reference photograph: a single mug on a
  // plain slab against a plain blurred wall, no second object anywhere). Three rounds of "at most
  // one prop, placed behind" produced three rounds of "the product is one of several things in the
  // picture" — because a prop that is allowed is a prop that gets drawn, and once it is drawn the
  // eye has somewhere else to go. The staging he is describing gives the product the stage alone.
  'NO props and NO second object of any kind. Nothing on the surface beside the product, nothing '
  + 'on the wall behind it, nothing entering the frame. Only the product, the surface it stands on '
  + 'and the plain backdrop behind',
  // 6. Accent colour against the neutral base.
  'keep the palette warm and natural but let ONE small element carry a real accent colour so the '
  + 'eye has somewhere to land',
  // The composition note. "Some edges cropped by the frame" is gone — see the first clause.
  'off-centre asymmetric composition at a natural angle, shot from a human viewpoint rather than '
  + 'square-on, with clean space around the product',
  'alive, warm and inviting — the kind of picture that makes you want the thing',
].join('; ');

/** Shared by every prompt. Kept separate from the per-store direction because
 *  these are the rules that must hold no matter how the art direction changes —
 *  they are what keeps the output legally safe and visually usable as a product
 *  cell, not what makes it pretty. */
export const NEGATIVE_PROMPT = [
  // "no text of any kind" alone was not enough, measured on the first sample (2026-08-12): the
  // Teklar banner came back with "Hero Workspace" set in a serif over the picture and a garbled
  // English sub-line under it, and the אדנית plant food arrived with a printed bottle label. The
  // model reads a bare "no text" as being about watermarks and signage, and does not extend it to
  // the two places lettering actually appears — a magazine-style headline laid over the frame, and
  // print on the packaging of the product itself. Both are named now, separately.
  'no text of any kind, in any language',
  'no headline, no caption, no title, no masthead, no lettering laid over the image',
  'no printed labels, no packaging text, no writing on any object in the frame',
  'no watermark',
  'no logo, no brand mark, no label with a brand name',
  'not a real, identifiable commercial product',
  // Hands, arms and figures cropped above the shoulders are WANTED — they are most of what makes a
  // catalog look alive. Only the face is excluded, and for a specific reason rather than squeamish-
  // ness: a generated face that resembles a real person is a likeness problem on a live commercial
  // domain, and it buys nothing a hand does not.
  'no visible faces, crop above the shoulders if a person appears',
  // Owner, 2026-08-12: "יש בן אדם שחסר לו איברים! זה לא תקין", and separately a product "מחובר עקום
  // לחשמל". Both are the ordinary generative-image failure — a limb that dissolves at the frame
  // edge, a plug entering a socket at an angle no plug enters a socket. They are worth naming
  // explicitly because a picture with a three-fingered hand in it is not a styling problem, it is
  // a picture that cannot ship, and it is invisible until somebody looks.
  'anatomically correct: if any part of a person is in frame, every arm, hand, finger and leg is '
  + 'complete, whole, correctly shaped and in its natural position — never a missing, extra, '
  + 'merged, floating or deformed limb or hand',
  'every cable, plug, socket, hinge and join is physically correct and properly seated — nothing '
  + 'plugged in crooked, nothing connected to nothing, no impossible geometry',
  // Owner, 2026-08-12: "אין בתמונות אלמנטים מוזרים שלא מתאימים לשימוש בני אדם, כמו תיק עם יותר
  // מדי כתפיות". This is the failure that is hardest to catch by skimming, because each part looks
  // right — a bag with three straps is a photograph of a real-looking bag that no factory makes,
  // and it is the tell that an image was generated. Named now rather than after the full run,
  // because 724 pictures is far too many to audit one at a time.
  'the product is a REAL, manufacturable object that a person could actually use: the correct '
  + 'number of straps, handles, sleeves, legs, buttons, pockets, holes and openings for what it is '
  + '— never an extra strap, a duplicated handle, a second zip, a strap attached at one end only, '
  + 'a leg that does not reach the floor, or any part that serves no purpose',
  // Owner, 2026-08-12: "יש בעיה שאלמנטים מסויימים נראים ישנים או מרופטים, בעיקר בטקלר." An image
  // model reaching for "real" and "lived in" reaches for wear, and wear on a thing that is FOR SALE
  // reads as second-hand. Every one of these is a brand-new item in a shop.
  'the product is BRAND NEW and unused — pristine, factory-fresh, no scratches, no scuffs, no dust, '
  + 'no fraying, no fading, no patina, no dents, nothing worn, aged, vintage, refurbished or repaired, '
  + 'and nothing dirty, muddy, stained, chipped, cracked or broken anywhere in the frame',
  // Said LAST as well as first. The framing rule lives in LIFE_DIRECTION and in the view modifier,
  // and the product still came back cropped three rounds running — so it is also the final thing
  // in the prompt, where a model weights hardest.
  'NEVER crop or cut off the product: no part of it touches or crosses the edge of the frame, '
  + 'nothing runs off the side, bottom or top, and the whole item is inside the picture with room '
  + 'to spare',
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
/**
 * 2K, and the arithmetic is what settles it rather than caution.
 *
 * The banner was briefly 4K after the owner asked for "באנרים ברמה גבוהה, לא מפוקסלים", and he
 * then said 4K was not the point — good quality was. He is right, and the numbers agree: 2K at
 * 16:9 is 2048px wide, the band is cropped from the HEIGHT so the width survives intact, and the
 * store header renders at most 1400px. The source is comfortably larger than the slot at every
 * breakpoint, which is the whole definition of not pixelated.
 *
 * 4K also broke something on the way through: אדנית's came back at 10.7MB and Cloudinary's
 * unsigned upload rejects anything over 10MB, so a paid image was lost. The guard that catches
 * that now lives at `CLOUDINARY_MAX_BYTES` in the generator and stays, because the limit is real
 * whatever this constant says.
 */
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
    /** סהר is the crescent moon, so the mark is the word's own meaning — the one logo idea that
     *  needs no explaining to an Israeli and cannot be mistaken for another shop's. */
    logoConcept:
      'a single elegant crescent moon, drawn as one clean curved shape with a tapering tip, '
      + 'geometric and calm, no face, no stars, no ornament',
    /** The mark alone, no lettering (owner, 2026-08-13). A crescent is legible at 24px and needs no
     *  caption; the store's name sits beside the avatar everywhere the avatar appears anyway. */
    logoNameless: true,
    /** The FLAT VECTOR one. A fashion label's mark is printed on a swing tag and embroidered into a
     *  collar, so it has to survive being tiny and one colour — which is what flat vector is for. */
    /**
     * Colour and pattern on the clothes themselves (owner, 2026-08-12: "קצת יותר צבעים על הבגדים,
     * דוגמאות מעניינות, מודרניות, צורות, משהו יותר מעוצבי").
     *
     * Same mechanism as שקמה's, opposite register, and the difference is the point: שקמה's list is
     * folk craft — hand-painted, woven, traditional — while these are contemporary print and
     * colour-blocking, the things a 2026 label actually puts on a garment. Two stores using one
     * mechanism to arrive at two unmistakably different racks is exactly what the mechanism is for.
     *
     * The cool stone backdrop is what makes this safe: strong colour against a grey field reads as
     * designed, where the same colour in a warm room would read as busy.
     */
    colorways: [
      'a bold abstract brushstroke print in cobalt and cream',
      'colour-blocked panels of rust and soft grey',
      'a fine tonal stripe in ink blue and white',
      'a large-scale geometric print in ochre, black and ivory',
      'a single saturated colour — deep emerald green',
      'an irregular hand-drawn checkerboard in charcoal and bone',
      'a soft watercolour floral in dusty rose and sage, painterly rather than pretty',
      'a saturated tangerine, plain and confident',
      'a graphic wave pattern in navy and pale blue',
      'a warm terracotta with a contrast topstitch in ecru',
      'a monochrome op-art spiral in black and white',
      'a muted lilac with a single wide cream stripe',
      'a scattered small-scale dot print in mustard on slate',
      'deep plum, plain, with a tonal sheen to the fabric',
      'a bright cherry red with a clean white collar or trim',
      'an earthy olive with a subtle woven herringbone texture',
    ],
    /** The hero backdrop — see `PRODUCT_VIEWS.main`. Cool pale stone-grey: this is the store that
     *  was corrected off warm plaster, and a colour field states that in one look. */
    backdrop: 'a plain wall of deep cool graphite grey, like dark honed stone, softly out of focus '
      + 'and noticeably darker than the product, with a pale grey marble ledge to stand on — the '
      + 'contrast between the dark field and the light stone is the point',
    logoStyle:
      // No typography note here, deliberately: this store is `logoNameless`, and a style line that
      // describes how to set the name is an instruction to draw one. That contradiction is what put
      // "סהר" under the crescent on the first attempt even though the naming clause said MARK ALONE
      // — given two instructions, the model followed the more specific.
      'A flat vector logo artwork on a plain solid background — a digital design file, not a '
      + 'photograph, not a 3D render, not a sign on a wall: no perspective, no shadow, no texture, '
      + 'no mockup. ONE colour only, a soft warm terracotta on off-white, and the mark sits alone '
      + 'and generously spaced in the centre of the frame.',
    address: 'דיזנגוף 112, תל אביב',
    selfPickup: false,
    // Mutually exclusive on purpose: a product carries exactly ONE categoryId, so
    // a curated shelf like "קולקציה חדשה" cannot be a category here without
    // stealing products out of the real ones and leaving them half empty.
    categories: ['נשים', 'גברים', 'הנעלה', 'תיקים', 'תכשיטים ואביזרים'],
    bannerSubject:
      'a cool, quiet fashion studio in pale stone — a marble ledge, a rail of clothes softly out of '
      + 'focus, one hard shaft of daylight across a limestone wall, greys and bone whites',
    /** Its own region clause, because the shared one names terracotta, olive and clay — and this is
     *  the store that was corrected OFF that palette. With the shared clause it came back as שקמה's
     *  room twice out of two: warm plaster, an olive branch in a clay jug. Israeli-Mediterranean is
     *  still the world; the surfaces in it are the cool half of it. */
    region:
      'contemporary Israeli / Mediterranean 2026 aesthetic, bright natural daylight, but a COOL '
      + 'palette throughout — marble, limestone, grey concrete, bone white and soft grey. '
      + 'Absolutely no terracotta, no clay, no olive branches, no warm plaster, no beige linen',
    /** Warm sand studio. Not white — the owner asked for at least one store off
     *  plain white, and this is the softer of the two that are. */
    artDirection:
      // Owner, 2026-08-12: he wanted this store off the warm room entirely — "רקע ניטרלי או על רקע
      // של שיש או אבן". It is also the correction that breaks the beige: pale stone is cool and
      // clean where plaster was warm, so סהר stops reading as the same room as שקמה.
      // Owner, 2026-08-12: "סהר — קצת יותר תחכום, לא רק אבן, בטון, שיש, טקסטורות." Fair: the
      // correction that got this store off warm plaster named three materials and the store then
      // had nothing else. Stone stays as the GROUND, but a fashion shop's sophistication comes
      // from the fittings and the light — chrome, glass, a sheer curtain moving, a mirror — none of
      // which is a texture on a wall.
      'refined fittings alongside the stone: a slim polished chrome or brushed steel rail, clear or '
      + 'smoked glass, a sheer curtain catching the light, a mirrored edge, a thin bronze frame — '
      + 'one such element, never a collection of them. '
      + 'editorial fashion photograph against a NEUTRAL stone backdrop — pale marble, honed limestone '
      + 'or smooth grey concrete, cool and clean, with the veining visible but quiet. Clothing is '
      + 'WORN by a cropped figure (never a face) so the cut and the drape read; bags and accessories '
      + 'are carried or held. One hard shaft of daylight crosses the stone and throws a crisp shadow. '
      + 'At most one prop, in a material that contrasts with the stone. No wood, no plaster, no '
      + 'terracotta, no beige linen',
  },
  {
    slug: 'showcase-home',
    name: 'שקמה',
    tag: 'לבית',
    tagline: 'דברים יפים לבית, בלי להתאמץ',
    description:
      'חנות לדוגמה של Dezabin — כך נראית חנות לבית ולעיצוב בפלטפורמה: מוצרים גדולים וכבדים '
      + 'עם משקל למשלוח, איסוף עצמי לצד משלוח שליח, גדלים וגוונים לבחירה ותיאורים מלאים.',
    // Repalette 2026-08-12, same decision as the artDirection above and it has to move with it:
    // these two values are the store's brand colour in the APP (header, badges, banner wordmark),
    // so leaving them sage while every photograph turned teal would put the shop's own colour at
    // odds with its own pictures. Deep teal + the saffron that answers it — the same pairing the
    // photographs are built on, so header, badge and banner all read as one shop.
    colors: { primary: '#12444a', accent: '#c9762c' },
    /** שקמה is the sycamore. A leaf reads instantly at any size and says "home and green" without
     *  saying "nursery", which is אדנית's job. */
    logoConcept:
      'a sycamore leaf with a short stem, carved or routed into the sign — the leaf as a recess or '
      + 'a raised relief in the material itself rather than as printed graphic',
    /** The PHOTOGRAPHED one — a real shop sign, shot as a photograph. This is the store whose whole
     *  world is craft and material, so its logo being an object somebody made is the point. */
    /**
     * The only saturated field of the four, and the one that is a COLOUR rather than a material.
     *
     * It went oxblood for one round — the owner had asked for "עולם יותר אדמדם" and separately
     * said the teal in his reference photograph was only an example. Both were true and the
     * conclusion was still wrong: shown the oxblood he called it ugly and asked for the teal after
     * all. So this is the reference photograph's own colour, and the "more red" note is answered
     * where it actually belongs — in the PRODUCTS (see `artDirection`), warm against the cool
     * field, which is exactly the contrast that made his reference work.
     */
    backdrop: 'a plain wall of deep teal blue-green, mottled like painted lime plaster and softly '
      + 'out of focus, rich and saturated and clearly cooler than the product in front of it, '
      + 'with a plain dark slate shelf to stand on',
    /**
     * Shot CLOSE, and that is the correction (owner, 2026-08-13: "לא רואים שם את הכיתוב בכל, זה
     * רחוק ומרומז מדי"). "A hanging sign above a shop door" describes a street photograph, so the
     * model delivered one — sign small, name unreadable, brickwork and a window taking most of the
     * frame. The medium was right and the camera position was wrong: this is a photograph OF the
     * sign, not of the shopfront it hangs on.
     */
    /**
     * Third attempt, and each failure taught the same lesson: naming a "shop sign" summons the
     * shop. "Above a shop door" gave a street photograph; "no shopfront, no door" still gave chains,
     * a doorway and a stucco wall, because the object itself was still described as a hanging sign
     * and a hanging sign hangs from something. The owner's note — "רחוק מדי מהמילה ויותר מדי כהה
     * ואלמנטים שמעלימים את העין מהלוגו" — is all three symptoms of that one cause.
     *
     * So the object is no longer a sign on a building. It is a painted wooden PANEL photographed
     * flat, like a product on a table, which is a framing the model has no reason to put a street
     * behind. And the colour is lifted: a dark teal board photographed in shade is where "too dark"
     * came from.
     */
    logoStyle:
      'A flat-lay PHOTOGRAPH of a single painted wooden panel, shot from directly above on a plain '
      + 'pale background, filling the whole frame edge to edge with only a thin margin. It is a '
      + 'flat board and nothing else: no chains, no bracket, no hooks, no wall, no door, no '
      + 'building, no street, no room, no hands, no other object anywhere in the picture. '
      + 'The board is BRIGHT teal, clean and evenly lit in soft daylight so every letter reads '
      + 'clearly; the lettering and the mark are carved into it and painted in warm gold that '
      + 'contrasts strongly against the teal. The Hebrew name is LARGE, high-contrast and the '
      + 'unmistakable subject of the picture, in a warm slightly condensed serif with real weight.',
    address: 'ויצמן 8, רעננה',
    selfPickup: true,
    categories: ['ריהוט', 'תאורה', 'קרמיקה וכלי הגשה', 'טקסטיל', 'עיצוב ואקססוריז'],
    bannerSubject:
      'a calm living room with a deep teal-plastered wall — a dark walnut table, one brass lamp lit '
      + 'warm, a hand-woven kilim runner in terracotta and saffron, a piece of painted folk pottery '
      + 'catching the light, low raking window light and long shadows. No greenery, no beige',
    /** The explicitly non-white store. Objects sit in a real room on a real
     *  surface, which is also the only honest way to shoot furniture — a sofa on
     *  a white sweep has no scale. */
    artDirection:
      // Repalette, 2026-08-12: "שקמה ואדנית נראים אותו דבר, הצבעים שלהם דומים מדי … צריך לשקמה
      // עולם יותר אדמדם, שחור כחול." Both stores were built on green-and-clay, and once אדנית's
      // own direction was cleaned up they landed in the same room. Green belongs to the nursery —
      // it is the only saturated colour in that store and it is what makes it read as a nursery —
      // so שקמה is the one that moves. Oxblood, charcoal and deep blue is also simply a better
      // home-goods world: it reads evening and interior where sage read garden.
      // The colour lives on the GOODS, not on the room (owner, 2026-08-12: "שיהיה שם יותר צבע על
      // המוצרים עצמם, יותר שמח, יותר אווירה של מקסיקני או משהו כזה מנבאדה, אינדיאני מקסיקני").
      // That is a real and specific world — Oaxacan pottery, Navajo weaving, Talavera tile — and it
      // is the one thing that most separates this store from the other three, none of which has a
      // decorative tradition at all. It also finally gives שקמה something to BE, rather than being
      // "the warm one" defined by contrast with סהר.
      'warm interior lifestyle photograph, the object resting on a natural surface such as dark '
      + 'walnut, slate or raw clay, soft directional window daylight from the side, a long shadow '
      + 'with real shape. The GOODS carry the colour and the pattern, and they are joyful: a '
      + 'south-western and Mexican folk-craft spirit — Oaxacan and Talavera pottery, Navajo and '
      + 'kilim weaving — terracotta and saffron, burnt orange and ochre, deep teal and indigo, '
      + 'with bold geometric banding, zigzags, diamonds and hand-painted motifs where the object '
      + 'would really carry them. Nothing muted, nothing beige, nothing washed out. '
      + 'The room itself stays plain and calm so the pattern is the only busy thing in the frame. '
      + 'The product is the subject but the room is around it, '
      // The owner floated a separate handmade-ceramics store and it was argued down — שקמה's
      // "קרמיקה וכלי הגשה" is already its largest category (22 rows), and a fifth store selling the
      // same goods makes the mall read thin rather than full. The LOOK he wanted is right, though,
      // so it lands here instead, at no cost: anything ceramic in this store is studio pottery, not
      // factory tableware. Uneven glaze and a hand-thrown lip are the whole difference.
      + 'any ceramic or stoneware item is hand-thrown studio pottery — a slightly irregular rim, '
      + 'visible throwing rings, an uneven reactive glaze that pools and breaks over the edges, '
      + 'quietly imperfect and clearly made by hand rather than mass produced. '
      // Owner, 2026-08-12: "ריבוי פרטים מאחורה … מרגיש לי שזה קצת משעמם כרגע." Both at once, and
      // they are the same note: a wall of shelves full of books and bowls is busy AND monotone, so
      // it reads as clutter rather than as interest. The room loses its detail and gains a colour.
      + 'The room behind is SIMPLE and largely empty — a plain wall, a bare surface, at most one '
      + 'soft shape well out of focus. No shelves full of objects, no stacked books, no crowd of '
      + 'ceramics behind the product',
    /** The turquoise, and why it is only on some of them.
     *
     *  Owner, 2026-08-12: "הייתי שמח שם ליותר טאצ׳ תורכיז בחלק מהתמונות לא בכולן". The "not all"
     *  is the whole instruction — a colour on every single shot becomes the background and stops
     *  being an accent, which is exactly how this store got called boring in the first place.
     *  `accentFor` spends it on about one product in three, chosen deterministically from the
     *  name so a re-run never repaints a picture already paid for. */
    // The accent flipped WARM when the field went teal. On a teal wall a turquoise accent is
    // invisible; the thing that has to pop against this store's colour is saffron and burnt orange.
    accent: 'a real touch of saffron or burnt orange somewhere in the frame — a hand-painted band, '
      + 'a woven stripe, a glazed rim breaking warm over the edge',
    /**
     * A colourway per product, and this is what fixes "everything in this shop is beige".
     *
     * The cause was in the catalog, not the art direction: of שקמה's hundred image subjects, seven
     * say "natural", six "cream", six "linen", five "sand" — the English subject line is a beige
     * catalog and the pictures obeyed it. Two facts make this the right place to fix it rather than
     * the catalog. The subject line is never shown to a shopper, and of the hundred HEBREW
     * descriptions that a shopper does read, exactly one names a colour at all (and it is a bulb's
     * colour temperature). So the colour can be decided here, freely, without a word of the shop's
     * own copy changing or contradicting a picture.
     *
     * Assigned deterministically by product name, so a re-run repaints nothing already paid for.
     * The list is curated rather than generated: every entry is a combination that a real
     * south-western or Mediterranean maker actually produces, which is what keeps a hundred
     * colourful products from reading as a paint chart.
     */
    colorways: [
      'a deep teal glaze with a hand-painted band of white and saffron geometric motifs',
      'warm terracotta with concentric bands of indigo and cream painted by hand',
      'a rich saffron yellow with a black hand-drawn zigzag border',
      'burnt orange with an irregular reactive glaze breaking to cream at the rim',
      'indigo blue with small white Talavera-style flowers painted across it',
      'a soft dusty pink with a single wide band of ochre',
      'olive green with a cream diamond pattern and fine black outlining',
      'oxblood red with an unglazed sandy band around the base',
      'turquoise with a crackle glaze and a rust-coloured rim',
      'a natural undyed ground woven through with bold stripes of magenta, ochre and teal',
      'charcoal black with a chalk-white geometric fretwork pattern',
      'a warm mustard with hand-stitched cross-stitch banding in red and blue',
      'a bright coral with a matte white interior',
      'deep plum with a brushed copper detail',
      'a sun-bleached ochre with faded indigo ikat patterning',
      'grass green with a hand-thrown spiral in cream',
    ],
  },
  {
    slug: 'showcase-tech',
    name: 'Teklar',
    tag: 'אלקטרוניקה',
    tagline: 'אלקטרוניקה, בלי הפתעות',
    /** The banner says something different from the store's tagline (owner, 2026-08-13). The
     *  tagline is a promise and belongs in the copy; the banner line says what the shop SELLS,
     *  which is what a stranger reading a sign actually needs. Kept as a separate field so the
     *  site's own wording is untouched. */
    bannerTagline: 'טכנולוגיה ומוצרים נלווים',
    description:
      'חנות לדוגמה של Dezabin — כך נראית חנות אלקטרוניקה בפלטפורמה: מפרט טכני לכל מוצר, '
      + 'בחירת צבע ונפח, מלאי מדויק לכל דגם ומשלוח שמחושב אוטומטית לפי כתובת.',
    colors: { primary: '#141a24', accent: '#2f6fe4' },
    /** The one Latin name, so it gets the one letterform mark: a monogram. It is also the most
     *  engineered of the four ideas, which is the point — this store is the plain one. */
    logoConcept:
      'a geometric monogram of the letter T, built from two straight bars with square ends meeting '
      + 'at one right angle, precise and engineered',
    /** The 3D RENDER one, which is also this store's own language: everything Teklar sells is
     *  photographed as a clean object on white, so its logo is one too. */
    /** White, because this store's whole direction already IS the empty backdrop. Named anyway so
     *  the hero staging reads from one place for all four rather than from three plus an exception. */
    backdrop: 'a seamless white studio sweep falling very slightly to pale grey at the corners, '
      + 'and the same white surface to stand on',
    logoStyle:
      'A clean 3D render of the mark as a solid physical object standing on a seamless white studio '
      + 'surface — brushed anodised aluminium with a soft contact shadow beneath it and one crisp '
      + 'specular highlight along the top edge, shot straight on. Graphite and a single electric '
      + 'blue face. The Latin name is set beneath in a tight, technical, medium-weight grotesque, '
      + 'flat and matte against the render.',
    address: 'הרצל 40, חיפה',
    selfPickup: false,
    /** The only store that opts OUT of the full styling language — see RESTRAINED_LIFE_DIRECTION.
     *  Its whole point is to be the plain one, in its copy and in its pictures alike. */
    restrained: true,
    categories: ['שמע', 'מחשוב ועבודה', 'טעינה וחשמל', 'בית חכם', 'צילום ווידאו'],
    bannerSubject:
      'a bright, clean white studio arrangement of a few pieces of consumer electronics — headphones, '
      + 'a keyboard, a small speaker — spaced apart on a seamless white surface with soft shadows '
      + 'beneath each one, calm and evenly composed, no room and no background objects',
    /** Teklar opts out of the region clause almost entirely — see `artDirection`. There is no
     *  Mediterranean anything in a white studio sweep, and the store's whole point is that there
     *  is nothing in the frame except the product. */
    region:
      'a clean commercial product-photography studio, cool neutral daylight-balanced lighting, '
      + 'no location, no room, no setting of any kind',
    /** The solid one. Cool grey rather than pure white: a true #fff sweep blows
     *  out a white product's own edge, which is exactly the case this store is
     *  full of. The grey keeps the silhouette. */
    /**
     * WHITE STUDIO, and this replaces the working-desk direction entirely (owner, 2026-08-12):
     * "הרעיון היה ליצור המון תמונות על רקע לבן עם צל קל מתחת/מאחורי האלמנט, הרעיון זה להראות חנות
     * שכל התמונות שלה קיבלו הסרת רקע."
     *
     * That is a real and very common kind of Israeli electronics shop — every photo cut out on
     * white — and it is the sharpest possible contrast with the other three, which was the other
     * complaint the same day ("הכל דומה מדי אחד לשני"). It also solves the occlusion note for this
     * store for free: on an empty sweep there is nothing left to hide the product behind.
     *
     * The one thing carried over from the old direction is why the white is not `#fff`: a pure
     * white sweep blows out a white product's own edge, and this store is full of white chargers
     * and speakers. The fix is a sweep that stays white but falls very slightly toward grey at the
     * corners, so the silhouette survives — a real studio does this with a gradient, not paint.
     */
    artDirection:
      'a clean e-commerce product photograph on a seamless WHITE studio background, of the kind '
      + 'where the background has been removed — the product alone, complete, centred and large in '
      + 'the frame, shot straight on or at a very slight angle. '
      // Owner, 2026-08-12: "פחות אור וצל, יותר לבן עם צל ממש עדין ברקע … יותר חנות של רקע ניטרלי."
      // The previous wording asked for a contact shadow, a grey falloff at the corners and crisp
      // specular highlights — three separate instructions to put drama in a frame whose whole job
      // is to have none. A cut-out catalog is lit flat on purpose; the shadow is there to stop the
      // product floating, and nothing more.
      + 'The lighting is FLAT, soft and even, like a lightbox — no dramatic highlights, no strong '
      + 'reflections, no hard light, no visible light direction. One barely-there soft grey shadow '
      + 'sits directly under the product so it does not float; there is no other shadow anywhere. '
      + 'The background is plain neutral white, clean and uniform edge to edge. '
      + 'NOTHING else in the frame: no desk, no room, no hands, no cables coiled beside it, '
      + 'no props, no plants, no coffee, no texture, no background whatsoever',
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
    /** אדנית is a planter, so the mark is the object itself — the most literal of the four, and
     *  correctly so: a nursery's sign should be readable from across the street. */
    logoConcept:
      'a tapered planter pot seen straight on with two or three leaves rising out of it, drawn with '
      + 'a visible brush or pen line rather than as a perfect geometric shape',
    /** The HAND-DRAWN one. A neighbourhood nursery's sign is painted by a person, and an
     *  illustrated mark is the furthest thing in the set from Teklar's machined render — which is
     *  what keeps these two from reading as one house style. */
    /** Warm putty, deliberately the lightest and warmest of the four fields — living green is this
     *  store's only saturated colour and a pale neutral is what lets it be the loudest thing in
     *  the frame. It also puts maximum daylight between this store and שקמה's deep teal. */
    backdrop: 'a plain sunlit wall of warm sand-coloured plaster in bright outdoor daylight, '
      + 'lightly out of focus, with one crisp diagonal shadow falling across it, and a pale raw '
      + 'concrete ledge to stand on — light, warm and clearly OUTSIDE',
    logoStyle:
      'A hand-drawn illustrated logo, painted in ink and gouache on warm off-white paper — visible '
      + 'brush strokes, slightly uneven line weight, the small imperfections of something drawn by '
      + 'hand. Not vector, not geometric, not a photograph, no 3D. Two greens and a soft terracotta. '
      + 'The Hebrew name is HAND-LETTERED in the same brush, warm and informal, never a typeface.',
    address: 'המלאכה 12, תל אביב',
    // The second self-pickup store, and for a different reason than שקמה's: a large plant is
    // awkward to ship rather than merely heavy, and "come and collect it" is what a real urban
    // nursery actually offers. Two stores using the same feature for two different reasons is a
    // better demonstration than one.
    selfPickup: true,
    categories: ['צמחי פנים', 'מרפסת וגינה', 'עציצים ומצעים', 'טיפול והזנה', 'כלי גינון'],
    bannerSubject:
      'a very simple, calm composition: three or four potted plants of different heights standing '
      + 'on a plain concrete ledge against a bare pale wall in clean morning sun, generous empty '
      + 'wall around them, one clear leaf shadow — quiet and uncluttered, only a few plants',
    /** URBAN, and that word is doing the work. שקמה is already the warm-interior store, so a
     *  nursery shot on travertine and oak would read as the same shop with plants in it. Concrete,
     *  hard graphic daylight and sharp leaf shadows are a different world, and they are also the
     *  honest setting for a משתלה אורבנית — the customer's balcony, not a farmhouse. Living green
     *  is the only saturated colour anywhere in the four catalogs, which is what makes this store
     *  read instantly as a different kind of business. */
    /**
     * Rewritten 2026-08-12. The owner's note was the sharpest one of the six: "העציצים בלתי נראים
     * כמעט … צריך הרבה יותר כבוד למוצר. תראה איך נראית חנות של משתלה."
     *
     * He was right, and the old direction is why. It asked for hands repotting, soil scattered on
     * the surface, a watering can and secateurs just set down, AND other plants out of focus
     * behind — so the single plant being sold was one green thing among six, half of it behind a
     * forearm. A real nursery photographs one plant in one pot, close, with room around it; the
     * balcony is the backdrop, not the subject.
     *
     * The wall behind is deliberately varied rather than fixed — plaster, stone, a hint of garden,
     * a doorway — because a hundred products against one identical wall reads as a template, and
     * the whole reason this store exists is to look like a shop somebody actually runs.
     */
    artDirection:
      // "ONE plant in ONE pot" stood here and was wrong for two of this store's five categories
      // (owner, 2026-08-12: "אני רוצה גם כלים נלווים, כמו אביזרים לגינה, כלי עבודה"). כלי גינון
      // and טיפול והזנה are secateurs, trowels, watering cans and feed — real rows in the catalog,
      // and a direction that only describes plants photographs a trowel as if it were one.
      'ONE item as the clear subject — a single plant in its pot, or a single piece of garden '
      + 'equipment: secateurs, a trowel, a watering can, gloves, a bottle of plant feed. Whichever '
      + 'it is, it is photographed complete and unobstructed with clear space around it on every '
      + 'side. A tool is shot as the clean, sharp object it is, with the same care as a plant — not '
      + 'as a prop lying beside one. Clean directional daylight and one soft shadow. '
      + 'Terracotta and stoneware pots, living green as the strongest colour where there is a plant. '
      // Owner, 2026-08-12: "שהעציצים עצמם יהיו נקיים לא מלוכלכים ולא שבורים." A nursery's own stock
      // photograph is of a pot fresh off the shelf, not one that has been through a season.
      + 'The pot is CLEAN and intact — no dried soil down the sides, no water stains, no moss, no '
      + 'chips or cracks, no dust — and the plant is healthy with no yellow, curled or dead leaves. '
      + 'NO hands, no people, no scattered soil, no tools, no second plant competing for attention',
    /**
     * Three settings, rotated per product (owner, 2026-08-12: "אני רוצה חלק בתוך בית, חלק מחוץ
     * לבית, חלק בפני עצמם ברקע כלשהו ניטרלי").
     *
     * This is also the honest way a nursery shoots: a fiddle-leaf fig sells on how it looks in a
     * living room, a rosemary on how it looks on a balcony, and a bag of feed on nothing at all. A
     * single setting for all hundred rows is what made this store read as one long photograph.
     * Deterministic per product name, same as `viewsForProduct` and `accentFor`, so a re-run never
     * moves a plant that has already been paid for into a different room.
     */
    /**
     * A little life in the background, on some of them (owner, 2026-08-12: "עוד אלמנטים של חיות,
     * אולי קצת פרפרים, חתולים, כלבים, ברקע, יושבים ליד העציצים לפעמים … משהו יותר נחמד בחלק
     * מהתמונות").
     *
     * "בחלק" is doing the work, and it is why this is a separate list on a separate hash rather
     * than a line in `artDirection`: a cat in every frame is a cat shop. Roughly one plant in four
     * gets a companion, and each one is explicitly BEHIND and small, because this store's whole
     * correction was that the plant kept losing the frame to something else in it.
     */
    companions: [
      'a butterfly resting on one of the leaves',
      'a calm tabby cat sitting on the floor behind the pot, well out of focus',
      'a small dog lying down in the blurred background',
      'two small birds on a railing far behind, softly out of focus',
    ],
    settings: [
      'INDOORS in a bright, simply furnished living room — a plain painted wall, a corner of a '
      + 'wooden floor or a side table, everything behind it soft and out of focus',
      'OUTDOORS on a sunny balcony or by a garden step — a raw concrete ledge or a painted railing, '
      + 'open sky or a softly blurred garden behind, hard clean daylight',
      'ON ITS OWN against a plain NEUTRAL studio backdrop — a smooth pale grey or warm off-white '
      + 'seamless, no room, no props, just the pot and a soft shadow beneath it',
    ],
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
 * What the picture is FOR, stated before anything else (owner, 2026-08-12: "זה מוצרים *לחנויות
 * אינטרנטיות* חשוב להדגיש את זה בפרומפטים, לא תמונת אווירה, מוצרים!").
 *
 * Every other clause in this file describes how the picture should LOOK, and none of them said
 * what job it does. Without that, "warm directional light, a prop in a contrasting material,
 * off-centre composition" is a brief for an interiors magazine — and that is what came back: mood
 * photographs that happened to contain a product. The brief is an e-commerce listing image, where
 * the shopper's only question is "what exactly am I buying", and it goes FIRST because a model
 * weights the opening of a prompt as the subject and everything after it as treatment.
 */
const PURPOSE_DIRECTION =
  'A PRODUCT PHOTOGRAPH for an online shop listing — a picture whose job is to sell this one item '
  + 'to someone deciding whether to buy it. It is not a mood photograph, not an interiors shot and '
  + 'not a lifestyle scene: the product is the subject, it is what the frame is built around, and '
  + 'a shopper must be able to see exactly what it is, what it is made of and what shape it is.';

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
    // "Filling most of the frame" stood here for three rounds and it is the reason products kept
    // getting cut off (owner, 2026-08-12, three times: a shirt, then a rug, then both again). Every
    // other clause in this file says "complete, never cropped" — and then this one, the modifier
    // closest to the subject, asked for the opposite. A model given "fill the frame" and "stay
    // inside the frame" resolves it by filling. The framing instruction is now stated as MARGIN.
    /**
     * The hero, and it is now a specific and deliberate STAGING, described from the owner's own
     * reference photograph (2026-08-12): one object on a plain slab, a plain wall of flat colour
     * softly out of focus behind it, nothing else in the picture at all. The product occupies
     * roughly half the frame and is surrounded by empty space on every side.
     *
     * Two things this fixes at once. It ends the cropping — a subject sized at half the frame
     * cannot run off the edge — and it is where the four stores are told apart, because the one
     * variable left in the picture is the BACKDROP COLOUR (`store.backdrop`). A colour field is a
     * far stronger signal of "different shop" than a different tabletop, and it is the reason the
     * reference reads as a brand rather than as a room.
     */
    modifier: 'CAMERA POSITION: eye level, straight on or at a gentle three-quarter angle. '
      + 'The primary catalog shot, staged simply and deliberately: the product stands alone '
      + 'on a plain, simple surface, with a plain wall of flat colour softly out of focus behind '
      + 'it. The product is centred and takes up roughly HALF the frame — no more — with clear '
      + 'empty space above it, below it and on both sides. The ENTIRE product is inside the frame; '
      + 'stand further back rather than closer, and if in doubt zoom OUT. Nothing else is in the '
      + 'picture: no props, no objects, no room, no scenery',
  },
  /*
   * ── Why each view now NAMES a camera position ──────────────────────────────────────────────
   * Owner, 2026-08-13, with a screenshot of three lamp photographs that differ only in the colour
   * of the wall behind them: "מה זה בהקשר, בשימוש? כל התמונות אותו דבר."
   *
   * He is right, and the cause is structural rather than verbal. Every gallery view is generated
   * with the finished main image attached (see `SAME_ITEM_CLAUSE`), and a reference image is an
   * enormous pull toward reproducing its composition. Asking for "a clearly different angle" —
   * which the previous round did, emphatically — loses that tug of war, because "different" is a
   * judgement the model can satisfy by changing the backdrop and calling it done.
   *
   * A NAMED CAMERA POSITION cannot be satisfied that way. "Directly overhead, looking straight
   * down" is either obeyed or visibly not; there is no way to copy the reference and still be
   * looking down at it. So each view below now specifies where the camera stands, and the four
   * positions are mutually exclusive by construction.
   */
  {
    key: 'detail',
    // Rewritten 2026-08-13. "Filling the frame at close range" is a crop by definition, and the
    // owner's rule is that a product is never cut off — he accepts a תקריב but not a fragment. So
    // this is now a close shot that still shows a whole, recognisable PART with its edges intact:
    // the sleeve and cuff rather than a rectangle of weave, the rim and handle rather than glaze.
    modifier: 'CAMERA POSITION: very close, almost touching, angled down at about 45 degrees onto '
      + 'ONE part of the product — a sleeve and its cuff, a rim and its handle, a corner and its '
      + 'joint. That part fills the frame, complete and unbroken inside it, and the rest of the '
      + 'product falls away out of focus. This is a macro shot: the material, the stitching, the '
      + 'glaze or the grain is the subject, not the whole object',
  },
  {
    key: 'inuse',
    // "Caught mid-gesture" is gone: a gesture is a hand moving across the object, which is the
    // occlusion the owner rejected. In use now means SHOWN IN USE, statically and legibly.
    modifier: 'CAMERA POSITION: LOW — the lens is at or below the level of the product, looking '
      + 'slightly UP at it from one side, so it stands tall against the background. If the product '
      + 'is worn, it is on a cropped figure (never a face) seen from this low angle. Nothing covers '
      + 'any part of it. This must not be an eye-level three-quarter view',
  },
  {
    key: 'context',
    // Rewritten 2026-08-12. "Smaller in a real room … other things half in shot" is precisely the
    // frame where the product disappears, and on a 400px catalog cell it is unreadable. A scale
    // shot still has to be a picture OF the product.
    modifier: 'CAMERA POSITION: HIGH — the lens is well above the product looking DOWN on it, close '
      + 'to straight overhead where the shape allows, so the plan of it reads and the surface it '
      + 'stands on is visible around it. Wider than the other views, showing where it is used, with '
      + 'the product still the clear subject, complete and unobstructed. This must not be an '
      + 'eye-level view',
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
  // The first line used to ask for "a hand on it or reaching for it". It is gone (owner,
  // 2026-08-12: "בטקלר אין צורך בבני אדם אלא אם המוצר לביש"), and it had to go: this store's whole
  // direction is now an empty white sweep, so a hand entering the frame is both the only thing
  // that could obscure the product and the only thing that could break the cut-out look.
  'the product alone and complete — NO people, no hands, no arms, no fingers anywhere in the '
  + 'frame. The only exception is a product genuinely worn on the body, such as headphones or a '
  + 'watch, which may be shown worn on a cropped figure with no face',
  'crisp, even studio lighting with clean highlights along the edges and a soft grounding shadow',
  'the product sharp end to end — no shallow-focus blur across the product itself',
  'a natural three-quarter angle, the product large and centred in the frame',
  'nothing else in the picture at all — no secondary object, no props, no set dressing, no surface '
  + 'detail, no background',
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

/**
 * The store's own palette clause, and it goes LAST for a reason (measured 2026-08-12).
 *
 * In the first sample, all four stores came back in terracotta-and-olive: סהר's banner was a warm
 * plaster room with an olive branch in a clay jug — practically שקמה's banner — and Teklar's
 * monitor was photographed beside an olive tree on warm plaster, in a store whose whole direction
 * is graphite and steel. That is the beige collapse this file was already corrected for once, back
 * in a different form.
 *
 * The cause was ORDER, not wording. `REGION_DIRECTION` names terracotta, olive and clay, it rides
 * on every prompt, and it sat AFTER the store's own art direction — so the last thing the model
 * read about palette was the shared clause, and the shared clause won four times out of four. The
 * per-store direction is now the final word, and the two stores whose world is genuinely not
 * terracotta carry their own `region` instead of the shared one.
 */
const regionFor = (store) => store.region ?? REGION_DIRECTION;

/**
 * A store's optional accent colour, spent on roughly one product in three.
 *
 * Same hashing trick as `viewsForProduct`, and for the same reason: the decision has to be
 * DETERMINISTIC, or a re-run would repaint pictures the manifest has already paid for. `% 3 === 0`
 * is the "some, not all" the owner asked for — enough that a shopper notices the colour, rare
 * enough that it still reads as an accent when they do.
 */
const hashOf = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

function accentFor(store, subject) {
  if (!store.accent) return '';
  return hashOf(subject) % 3 === 0 ? ` ${store.accent}.` : '';
}

/** One of the store's `settings`, chosen per product — see אדנית's entry for why they rotate. */
function settingFor(store, subject) {
  if (!store.settings?.length) return '';
  return ` ${store.settings[hashOf(subject) % store.settings.length]}.`;
}

/**
 * A background companion on roughly one product in TEN — see אדנית's `companions`.
 *
 * It was one in four for about an hour, and the owner's reaction on hearing the number was the
 * right one: "נשמע לי מלא". He is correct twice over. It only ever applies to gallery views (the
 * hero shot uses the store's plain backdrop and never reaches this function), אדנית has roughly
 * ninety of those, and one in four would have put a cat or a butterfly in more than twenty of
 * them — which stops being a nice surprise and becomes the store's theme. At one in ten it lands on
 * 8 of אדנית's 89 gallery images and on none of its hero shots — measured, not assumed, because the
 * hash is not uniform over a hundred Hebrew names and the divisor alone does not tell you the rate.
 */
function companionFor(store, subject) {
  if (!store.companions?.length) return '';
  const h = hashOf(`${subject}#pet`);
  if (h % 10 !== 0) return '';
  return ` Somewhere in the soft background, small and clearly behind the product without ever `
    + `overlapping it: ${store.companions[h % store.companions.length]}.`;
}

/**
 * The product's colourway — see שקמה's `colorways` for why this exists and why it lives here.
 *
 * It deliberately OVERRIDES the colour named in the catalog subject, and says so, because `FIDELITY`
 * a few clauses earlier forbids substitutions and would otherwise win. A different hash multiplier
 * from `viewsForProduct`/`accentFor` so the three decisions do not correlate — with the same hash,
 * every product that got a full gallery would also get the same colour.
 */
function colorwayFor(store, subject) {
  if (!store.colorways?.length) return '';
  const h = hashOf(`${subject}#colour`);
  return ` This particular piece is finished in ${store.colorways[h % store.colorways.length]} — `
    + 'use this colour and pattern rather than any neutral colour named in the description above, '
    + 'and let it be genuinely saturated and cheerful rather than muted.';
}

/**
 * The prompt for one product image.
 *
 * **The hero and the gallery are built differently, and that split is the whole design.** The
 * `main` view is the staging in the owner's reference photograph — the product alone on a plain
 * field of the store's own colour, nothing else in frame — so it takes `store.backdrop` and skips
 * the store's room entirely. It is the shot that has to be unambiguous, and it is the one every
 * grid cell, the cart and the ad feed read.
 *
 * The other three views are where the store's WORLD lives: `store.artDirection`, and for a store
 * that has them, the rotating indoor/outdoor/neutral `settings`. That is what stops the catalog
 * being a hundred objects on a hundred identical walls, without letting a room ever compete with a
 * product on the one image that matters most.
 */
/**
 * The clause that makes a gallery a gallery instead of four similar products.
 *
 * Owner, 2026-08-12: "חשוב שכמה תמונות של אותו מוצר יהיו של אותו המוצר! שלא יהיה בלבול." He is
 * right, and until now nothing prevented it: each view was generated independently from the same
 * sentence of English, so "a tall ceramic vase" produced four different vases, and a shopper
 * clicking through the carousel would see a product change shape between frames.
 *
 * Text cannot fix this — a description short enough to be a catalog line is never specific enough
 * to pin a shape. So the other three views are generated with the FINISHED main image attached as
 * a reference (see `generate-showcase-images.mjs`), and this clause tells the model what it is
 * looking at. That is also why the gallery views must run after the mains rather than beside them.
 */
export const SAME_ITEM_CLAUSE =
  'The attached image shows the EXACT product to photograph. This must be the same single physical '
  + 'item: identical shape, proportions, colour, pattern, material and finish, down to the details. '
  + 'Do not redesign it, do not restyle it, do not change its colour and do not substitute a '
  + 'similar product. '
  // The other half of the instruction, added 2026-08-13 after the owner looked at the finished
  // gallery: "כל התמונות שהן הנוספות לאותו המוצר הן באותה הזווית אחת של השניה, אין שם שום הבדל".
  // He is right, and the cause is this clause working too well. Told to keep everything identical
  // and change "only the camera", the model kept everything identical and barely moved the camera —
  // so the gallery repeated the hero instead of adding to it. A reference image is a strong pull
  // toward reproduction, and the difference has to be demanded as explicitly as the sameness.
  + 'BUT THE PHOTOGRAPH ITSELF MUST BE CLEARLY DIFFERENT. Move the camera to a genuinely new '
  + 'position — a different side, a different height, a different distance — so that at a glance '
  + 'this reads as a second photograph from a real shoot rather than a copy of the first. Never '
  + 'reproduce the reference image, its angle, its distance or its background.';

export function imagePrompt(store, subject, view = PRODUCT_VIEWS[0]) {
  const life = store.restrained ? RESTRAINED_LIFE_DIRECTION : LIFE_DIRECTION;
  const world = view.key === 'main' && store.backdrop
    ? `Behind and beneath it: ${store.backdrop}.`
    : `${store.artDirection}.${settingFor(store, subject)}${companionFor(store, subject)}${accentFor(store, subject)}`;
  // A gallery view is generated FROM the main image, so it opens by naming that reference — and it
  // drops the colourway, which is already visible in the picture it is being shown.
  const opening = view.key === 'main'
    ? `The product: ${subject}.${colorwayFor(store, subject)}`
    : `${SAME_ITEM_CLAUSE} For reference the product is: ${subject}.`;
  return `${PURPOSE_DIRECTION} ${opening} `
    + `${view.modifier}. ${FIDELITY}. `
    + `${regionFor(store)}. ${life}. ${QUALITY_DIRECTION}. ${world} ${NEGATIVE_PROMPT}.`;
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
/**
 * How the shop's name is spelled INTO a picture, and in which script.
 *
 * Tested on eight real images 2026-08-12, after the owner said the model handles Hebrew and he was
 * right: four of eight came back perfectly spelled — שקמה and אדנית on both banner and plaque —
 * against two single-letter misses (סהר → "שהר", שקמה → "שקמד") and two that were my own fault,
 * because the prompt said "the Hebrew name" for all four and Teklar is a Latin name, so it was
 * dutifully transliterated to "תקלר". Hence `script`: a name is set in the alphabet it is written
 * in. The residual miss rate is a per-image coin-flip nobody can prompt away, and it does not need
 * to be — there are eight of these in the whole project, they are checked by eye in a minute, and
 * a re-roll costs $0.134.
 */
const nameClause = (store) => {
  // U+0590–U+05FF is the whole Hebrew block, so the maqaf (־) and the gershayim (״) are already in
  // it — naming them separately is what the duplicate-character-class rule catches.
  const script = /^[֐-׿\s'"]+$/.test(store.name) ? 'Hebrew' : 'Latin';
  return script === 'Hebrew'
    ? `The shop name "${store.name}" appears in the scene, spelled EXACTLY "${store.name}" — `
      + `four-square Hebrew letters read right to left, clean modern Hebrew typography, `
      + `correctly formed, well spaced and clearly legible. No other writing anywhere.`
    : `The shop name "${store.name}" appears in the scene, spelled EXACTLY "${store.name}" in `
      + `LATIN letters — do not translate it, do not transliterate it into Hebrew or any other `
      + `alphabet. Clean modern typography, correctly formed and clearly legible. `
      + `No other writing anywhere.`;
};

export function bannerPrompt(store) {
  // The name is now IN the picture, as physical signage (owner, 2026-08-12: "חייב כיתוב על
  // הבאנרים, זה לא יכול להיות סתם תמונה משעממת"). This reverses the SVG-overlay decision recorded
  // below, and it reverses it on evidence: the eight-image test showed the model spells a Hebrew
  // shop name correctly most of the time, and eight images is a set a person can check by eye.
  //
  // What does NOT come back is the old opening line. "A wide editorial hero photograph for a
  // shop's banner" is what printed "Hero Workspace" across Teklar in a serif with a garbled English
  // sub-line under it — naming a banner, a hero and an editorial describes a LAYOUT, and a layout
  // has a headline. So the name is asked for as a physical object in the world — letters on a
  // wall, a painted sign — which the model renders as photography rather than as typesetting.
  return `A wide photograph, shot on a full-frame camera: ${store.bannerSubject}. `
    + `${nameClause(store)} It is real, physical signage inside the scene — cut metal or painted `
    + `letters mounted on a wall, lit by the same light as everything else and casting its own `
    + `small shadow — never text laid over the photograph. `
    // The tagline, at the owner's request 2026-08-12 ("אני רוצה גם משפט קצר על החנות בבאנר"). It
    // is the one place a SECOND line of lettering is asked for anywhere in this file, and it is
    // deliberately described as smaller and subordinate: two lines at equal weight is a poster,
    // and it also doubles the chance of a misspelling on the line nobody is looking at.
    + `Directly beneath the name, in noticeably smaller and lighter letters on the same wall, the `
    + `line "${store.bannerTagline ?? store.tagline}" — spelled exactly that way, correctly formed `
    + `and legible, clearly secondary to the name above it. No other words anywhere in the picture. `
    // The banner is DELIVERED as a 3:1 band cropped from this 16:9 frame, so the top and bottom
    // sixths are thrown away — and שקמה's name was sitting in the part that gets cut (owner,
    // 2026-08-13: "הבאנר של שקמה חתוך מלמעלה"). Lettering placed near an edge of the source is
    // lettering placed outside the finished banner.
    + `Place the name and its line in the MIDDLE THIRD of the frame vertically — well away from the `
    + `top and bottom edges, with generous clear space above and below the whole block, because the `
    + `picture will be cropped to a wide band and anything near an edge will be cut off. `
    + `The lettering itself is bright and rich in colour against its wall — polished brass, warm `
    + `gold or a saturated painted colour that stands out — never flat grey and never low contrast. `
    + `A real scene with depth and atmosphere, not a flat backdrop — foreground, middle and `
    + `background at different focal distances, strong directional daylight raking across it, `
    + `and genuine visual interest. Compose the weight to ONE side and give the sign a calm, `
    + `uncluttered wall of its own to sit on. `
    // Owner, 2026-08-12: "התמונה בבאנר של סהר ממש מטושטשת." The depth-of-field language above is
    // what did it — asked for three focal distances and atmosphere, the model softened the whole
    // frame. A banner is displayed 1400px wide and is the first thing anyone sees, so sharpness is
    // named explicitly and beats the atmosphere clause.
    + `The photograph is TACK SHARP and in crisp focus across the frame, especially the sign — `
    + `high resolution, fine detail, no motion blur, no soft-focus haze, no overall blur. `
    + `${regionFor(store)}. ${QUALITY_DIRECTION}. ${NEGATIVE_PROMPT}.`;
}

/**
 * The store's logo, as a photographed physical sign.
 *
 * `logoPrompt()` was deleted once (the note below this function says why): asked for "a minimal
 * abstract emblem", the model returned a photograph of a terracotta arch, which in a 56px circle
 * read as a smudge rather than a mark. The owner asked for it back as an image on 2026-08-12 and
 * the eight-image test says he is right — but only because the ASK changed. It is no longer an
 * emblem; it is the shop's name on a plaque, photographed. That is a picture of letters, which is
 * legible at any size, and it is what the four test plaques actually produced.
 */
/** The only prohibitions that mean anything for a logo — see the note at its call site. */
const LOGO_NEGATIVE = [
  'no watermark, no signature, no border, no frame',
  'no photograph of a real place, no stock-photo look',
  'nothing cropped or running off the edge of the frame',
  'no gradients, no drop shadows, no 3D bevels unless the style above explicitly asks for them',
  // "No second mark" was not enough on its own: סהר came back with a faint duplicate crescent
  // behind the real one, like an echo. A model asked for a single shape will sometimes draw its
  // own construction lines, so the singularity has to be spelled out as a count.
  'exactly ONE of the shape described and nothing else — no duplicate, no echo, no ghost copy, '
  + 'no faded second version behind it, no reflection, no outline of it anywhere',
  'no extra symbols, no decorative flourishes',
].join(', ');

export function logoPrompt(store) {
  // ── Two corrections live here, and the second is the interesting one ────────────────────────
  //
  // 1. `${store.tag}` used to sit in the opening sentence as an aside about what the shop sells.
  //    The model read it as more sign copy and carved it on: שקמה's plaque came back reading
  //    "שקמה" over a second line, "לבית,", comma and all.
  //
  // 2. All four came back as THE SAME LOGO (owner, 2026-08-12: "לבנה אלכסונית בלי שום תחכום …
  //    העתק של השני עם שינוי טקסטורה"). He is right and the cause is structural: the prompt
  //    specified the ARTEFACT — a plaque, photographed at an angle, lit from one side — and left
  //    only the material to vary. Four shops given one art-directed object produce one object in
  //    four materials.
  //
  //    So the artefact is gone. What is asked for now is a flat vector logo, and the IDEA in it is
  //    each store's own (`logoConcept`) — a crescent, a leaf, a monogram, a planter. That is also
  //    the thing a shop logo actually is, and it answers the size problem that killed the first
  //    `logoPrompt()`: flat graphic shapes stay legible in a 56px circle in a way a photograph of
  //    a stone slab never did.
  // ── Round three: the MEDIUM has to differ too, not just the drawing ─────────────────────────
  // Owner, 2026-08-12: "שוב כל הלוגואים דומים אחד לשני, פשוט בדרך אחרת … התכוונתי שכל לוגו יהיה
  // בסגנון שונה, אחד וקטורי, אחד מצולם, אחד ריאליסטי כמו שלט של חנות אמיתית. בטח שלא כולם באותו
  // פונט עברי."
  //
  // He is right twice over. The previous fix varied the IDEA (crescent, leaf, monogram, pot) and
  // left the medium fixed at "flat vector on a plain background" — so four different drawings came
  // back as one house style, exactly as four different materials had come back as one plaque the
  // round before. This is the same mistake at one level up, and the lesson is that whatever this
  // prompt holds CONSTANT is what will make the four look alike.
  //
  // So nothing is constant now except legibility. `logoStyle` carries the medium, the lettering
  // and the palette together, because a typeface that suits a hand-painted nursery sign is not the
  // one that suits an engineered monogram — asking for four styles while dictating one font would
  // just relocate the sameness again.
  // A store may carry its mark ALONE (owner, 2026-08-13: "סהר יכול להישאר רק עם הציור של הירח,
  // בלי כיתוב"). That is a real and common choice — a symbol strong enough to stand without the
  // name is the better logo, and the name is already beside it everywhere it appears on the site.
  // It also removes this store from the one failure mode this file cannot fully control, which is
  // a misspelt Hebrew word.
  const naming = store.logoNameless
    ? 'The logo is the MARK ALONE, with no lettering of any kind — no name, no words, no letters '
      + 'anywhere in the image. Just the symbol, centred.'
    : `${nameClause(store)} The name is a PROMINENT part of the logo, set large and bold directly `
      + `below the mark and immediately readable at a glance — not small, not subtle, not distant, `
      + `not implied. It should be the second thing you notice after the mark itself.`;

  return `A LOGO for a shop called "${store.name}". ${store.logoStyle} `
    + `The mark itself: ${store.logoConcept}. `
    + `${naming} `
    + `Centred with generous even margins, complete inside the frame, nothing cropped. `
    + `The logo of a good independent shop: simple enough to recognise at a glance, distinctive `
    // NOT `NEGATIVE_PROMPT`. That list is written for product photographs and half of it is either
    // meaningless or actively wrong here: it forbids "no logo, no brand mark" (a logo IS a brand
    // mark), it demands "not dead-centre" when a logo must be exactly centred, and it spends four
    // clauses on limbs, plugs and factory-fresh packaging that no logo has. A prompt that argues
    // with itself gets obeyed selectively, which is how "MARK ALONE" lost to a typography note.
    + `enough to remember. ${LOGO_NEGATIVE}.`;
}

/* `logoPrompt()` stood here and is gone (2026-08-12). Asking an image model for "a minimal abstract
   emblem" reliably returns a PHOTOGRAPH of an object — a terracotta arch, a leaf — and the avatar
   renders in a circle, so what arrived was a cropped photo of a thing, soft at 56px and reading as
   a picture rather than a mark. The showcase stores draw their logos instead:
   `src/components/StoreDemoMark.astro`. Removed rather than left unused, so nobody re-wires it and
   re-learns this. */

export function storeBySlug(slug) {
  const store = SHOWCASE_STORES.find((s) => s.slug === slug);
  if (!store) throw new Error(`unknown showcase store ${JSON.stringify(slug)}`);
  return store;
}
