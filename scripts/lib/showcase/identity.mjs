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
  // "crop above the shoulders" meant "cut the person off above the shoulder line", and reads just
  // as easily as "leave everything above the shoulders in" — which is how it was read, on two shots
  // out of four on 2026-08-17 (a jaw, then a mouth). It names the cut LINE now instead of a
  // direction, and says the same thing `LIMB_SAFETY` says.
  'no visible faces: if a person appears, the top edge of the frame cuts their head off at the chin '
  + 'or lower, so no mouth, nose, eyes or hair are in the picture',
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

/**
 * Where a figure may be cut, so that nothing is ever cut BADLY.
 *
 * The anatomy line in `NEGATIVE_PROMPT` has been there since 2026-08-12, written for this exact
 * complaint, and on 2026-08-17 the owner reported it again from the new sample: "יש דוגמנים שחסרים
 * להם איברים! פתאום אין כפות רגליים או משהו כזה... נראה נורא". Restating a prohibition that has
 * already failed once is not a fix.
 *
 * The prohibition fails because it is unachievable as posed. A cropped figure must end SOMEWHERE,
 * and every generated limb approaching the frame edge is a chance to end wrong — a foot half in
 * frame, an ankle fading into the floor. Told "no missing limbs" while also being told to crop a
 * person, the model has to resolve a contradiction, and it resolves it at random.
 *
 * So this names the crop instead of banning the failure: the cut happens at a JOINT and well
 * inside the frame, and the parts most often mangled — feet, ankles, hands at the very edge — are
 * simply never in the picture. What is in frame is whole because there is less of it.
 */
export const LIMB_SAFETY =
  // "crop above the shoulders" in NEGATIVE_PROMPT turned out to be read as "anywhere above them",
  // so the first sky sample came back with a jaw and a mouth in frame on two shots out of four. A
  // partial face is the likeness problem the face rule exists to avoid, only harder to notice.
  'The head is cut off by the top of the frame at or below the CHIN: no mouth, no nose, no eyes and '
  + 'no part of a face is ever visible. '
  + 'If a person appears, they are cropped DELIBERATELY and cleanly: the frame cuts them off at the '
  + 'upper thigh, the waist or the chest, and the cut edge is a clean straight edge of the '
  + 'photograph, not a body part that fades, dissolves or tapers away. Feet, ankles and lower legs '
  + 'are NEVER in the picture at all — not partly, not blurred, not at the bottom edge. Whatever '
  + 'part of the body IS shown is complete and correctly formed within the frame, with both hands '
  + 'either fully visible and whole or entirely outside the picture. Never a stump, never a limb '
  + 'that ends in nothing, never a foot without a leg';

/**
 * The garment is presented, not discarded.
 *
 * Owner, 2026-08-17, on the first sky-adjacent sample: "יש בגדים מקומטים או שיושבים לא טוב על
 * האנשים". Both halves are one failure — a model asked for "real" and "natural" produces cloth
 * that has been sat in. A shop photographs stock, and stock has been steamed.
 */
export const PRESSED =
  'The garment is shop-fresh and perfectly presented: freshly steamed and pressed, clean and '
  + 'straight with no creases, no wrinkles, no rumpling, no bunching and no fold lines anywhere. '
  + 'It FITS the body it is on properly — the shoulder seam sits on the shoulder, the sleeves are '
  + 'the right length, the waist sits where it should, nothing is twisted, pulling, gaping, '
  + 'sagging or hanging off. Every fastening is done up as it is meant to be worn. '
  // ── How an UNWORN garment is held up, added 2026-08-17 with the sky ──────────────────────────
  // Told only that there is no floor and no surface, the model solved the problem the way a person
  // would: it pegged the trousers to a washing line strung across the sky. Owner: "לא בגדים תלויים
  // על חוט, לא בגדים מקומטים, ברורים, זה אמור להיות תמונה מאוד מחמיאה למוצר." A garment on a line
  // is laundry, and laundry is the one thing a catalogue photograph must never look like.
  // The positive half of the same note. "Flattering" is a real instruction to a photographer and
  // the model responds to it, where "no wrinkles" only tells it what to avoid.
  + 'The photograph FLATTERS the product: it is the most appealing, most desirable version of this '
  + 'item, crisp and clearly lit, every seam, button and texture sharp and easy to read, and it '
  + 'makes someone want to own it. '
  // ── "חייב שהבגדים יהיו יותר יפים" (2026-08-17), and what that turned out to mean ──────────────
  // Said after a sample of quiet, correct, entirely unremarkable basics — a grey tee, a grey knit,
  // a plain sweatshirt. It is the fourth pass on this axis and the first one that is not about
  // colour: loud was rejected, then muted was "משעמם", then the colours were fixed and the clothes
  // were still dull. What was missing was never saturation, it was DESIGN. A plain grey tee in a
  // prettier grey is still a plain grey tee.
  + 'The garment itself is BEAUTIFUL and clearly designed — a piece someone chose, not a blank '
  + 'basic. It is cut with intent and finished with care: a considered neckline or collar, a real '
  + 'sleeve shape, a soft pleat or gather where it flatters, a neat cuff or hem, a well-placed '
  + 'seam, a quality trim. The fabric looks expensive and hangs beautifully, with a soft natural '
  + 'drape and a subtle richness to its surface. Elegant and desirable, never plain, never cheap, '
  + 'never a flat shapeless rectangle of jersey';

/**
 * The garment on an invisible body — see `presentationFor` for when this is chosen.
 *
 * Written after a model, told only that there was no floor and no surface, hung the trousers from
 * a washing line strung across the sky. Owner: "לא בגדים תלויים על חוט". A garment with nothing
 * under it has to be told what holds its shape, or the model invents something that does.
 */
export const GHOST_PRESENTATION =
  'NOBODY is wearing it and no person appears anywhere in the picture. It is presented on an '
  + 'INVISIBLE body: filled out and holding its exact worn shape in mid-air — shoulders square, '
  + 'sleeves rounded, trouser legs full — as if the person inside it had been erased. It is never '
  + 'flat, never limp, never folded and never draped over anything. Nothing holds it up and nothing '
  + 'is attached to it: no washing line, no rope, no string, no wire, no pegs, no clips, no hook, '
  + 'no hanger, no rail, no stand, no mannequin and no hands';

/**
 * How a thing that is not clothing sits in a sky.
 *
 * The case that had no clause at all, and the one the owner found: *"יש לי שם כמה תמונות עם רקע
 * שחור נוראי (מגפי קרסול עם עקב, סניקרס פלטפורמה) זה לא שמיים. צריך להיות עקבי."*
 *
 * It is a contradiction, like the others, rather than an omission. `PRODUCT_VIEWS.main` says the
 * product "stands alone on a plain, simple surface" — the staging that stopped this catalog cropping
 * its own products — and `backdrop` now says there is no surface anywhere. A garment resolves it by
 * being worn or filled out. A boot cannot be worn by nobody, so the model resolved it the only way
 * left: it built a plinth and put a dark wall behind it, which is what a product photographer does.
 *
 * A sweep of all 112 heroes (top-strip average colour, brightness and blue-dominance) found 22 that
 * had drifted this way — dark grey walls, an olive field, a cream room with a wooden table. Five
 * were egregious; the rest were quietly not-sky, which is exactly the kind of thing that is only
 * visible once someone scrolls the whole grid.
 */
export const OBJECT_PRESENTATION =
  'The product FLOATS in the open sky, held up by nothing and resting on nothing. There is no '
  + 'surface under it of any kind — no table, no plinth, no pedestal, no block, no box, no ledge, '
  + 'no shelf, no stand and no floor — and no wall behind it. It hovers, upright and clearly '
  + 'presented, with a soft shadow of its own beneath it in the air. Sky fills the entire frame '
  + 'behind and below it';

/** The garment worn by a cropped figure — the other half of `presentationFor`. */
export const WORN_PRESENTATION =
  'It is WORN by a cropped figure so the cut and the drape read on a real body. The figure is '
  + 'cropped tightly: the picture holds the garment and little else, and whatever the person is '
  + 'wearing below it is plain and quiet so it never competes';

/**
 * Worn by somebody, or worn by nobody — decided per product rather than per store.
 *
 * Owner, 2026-08-17, shown the two side by side: "גם וגם, חלק עם גוף וחלק בלי גוף, רק שהפריטים לא
 * יצאו מהפריים." Both readings of that are load-bearing and they pull opposite ways, so the split
 * is a rule rather than a preference:
 *
 *   **The mix** is real and deterministic — a hash, like `colorwayFor` and `backdropFor`, so the
 *   same product is presented the same way every run and the ratio is a known one rather than
 *   whatever the model felt like that call.
 *
 *   **The frame** decides who is eligible. A full-length garment worn by a person is a person from
 *   the chin to the shoes, and that picture cannot both fit the product in frame and keep feet out
 *   of it — the attempt on 2026-08-17 put legs, shoes, ground and a horizon back in a picture that
 *   is supposed to be sky. So anything reaching past the knee is never worn, and the coin is only
 *   tossed for garments that end at the hip.
 *
 * Matching on the English subject is deliberate: `s` in the catalog always names the garment type
 * in plain words, and it is the same string every other hash here keys on. A garment this misses
 * simply falls through to the object case and is photographed as an object, which is safe.
 *
 * MEASURED over סהר's 112 rows, the way `companionFor` and `backdropFor` record theirs: 17 worn by
 * a figure, 46 on the invisible body, 49 photographed as plain objects (every shoe, bag, hat and
 * piece of jewellery, which was never a candidate). So one garment in four is on a person — a real
 * mix, weighted to the safe side by the frame rule rather than by taste.
 */
const LONG_GARMENT = /trouser|jean|chino|jogger|skirt|dress|short|legging|swim/i;
const UPPER_GARMENT = /shirt|top|tee|t-shirt|sweater|sweatshirt|hoodie|jacket|blazer|coat|cardigan|knit|polo|henley|jumper/i;
/**
 * The hero staging, for a store whose backdrop has no surface in it.
 *
 * **This is where three rounds of fixes were quietly losing.** `PRODUCT_VIEWS.main` opens by saying
 * the product "stands alone on a plain, simple surface, with a plain wall of flat colour softly out
 * of focus behind it" — the staging, copied from the owner's own reference photograph, that stopped
 * this catalog cropping its products. סהר's backdrop then says there is no surface and no wall
 * anywhere, only sky. Every clause added to resolve that (`GHOST_PRESENTATION`,
 * `OBJECT_PRESENTATION`) was arguing with the view modifier from further down the prompt, and the
 * modifier kept winning where the product was small and heavy: after the object rule went in, a
 * boot still came back on concrete and a signet ring on a linen cloth.
 *
 * A contradiction is not fixed by adding a third voice. The store now REPLACES the sentence.
 * Everything else about the staging — half the frame, generous margin, the whole product inside the
 * edges, nothing else in the picture — is why that modifier exists and is repeated here word for
 * word, because those clauses are load-bearing against cropping and are not what went wrong.
 */
const SURFACELESS_MAIN =
  'CAMERA POSITION: eye level, straight on or at a gentle three-quarter angle. '
  + 'The primary catalog shot, staged simply and deliberately: the product hangs ALONE IN OPEN AIR '
  + 'with nothing under it and nothing behind it — no surface, no table, no plinth, no ledge, no '
  + 'ground and no wall of any kind, anywhere in the frame. The product is centred and takes up '
  + 'roughly HALF the frame — no more — with clear empty space above it, below it and on both '
  + 'sides. The ENTIRE product is inside the frame; stand further back rather than closer, and if '
  + 'in doubt zoom OUT. Nothing else is in the picture: no props, no objects, no room, no scenery';

/** The main view's modifier for this store — the shared one, or the surfaceless replacement. */
const mainModifier = (store, view) =>
  (view.key === 'main' && store.backdropSurfaceless ? SURFACELESS_MAIN : view.modifier);

export function presentationFor(subject) {
  if (LONG_GARMENT.test(subject)) return ` ${GHOST_PRESENTATION}.`;
  // Everything that is not clothing — shoes, bags, jewellery, hats, belts — used to return '' and
  // fall through to whatever the model made of "a plain, simple surface" in an empty sky. It made
  // plinths. See `OBJECT_PRESENTATION`.
  if (!UPPER_GARMENT.test(subject)) return ` ${OBJECT_PRESENTATION}.`;
  return hashOf(`${subject}#worn`) % 2 === 0 ? ` ${WORN_PRESENTATION}.` : ` ${GHOST_PRESENTATION}.`;
}

/**
 * Modest dress, absolutely and everywhere.
 *
 * Owner, 2026-08-17: "בלי מחשופים, בלי דברים לא צנועים וחושפניים מדי. אני אדם דתי", and the frame
 * he gave for the whole catalog — "בגדים שמתאימים לאנשים שומרי מסורת".
 *
 * It is stated as a property of the GARMENT rather than of the photograph on purpose. A styling
 * rule can be satisfied by choosing an angle; this has to hold from every angle, in every gallery
 * view, on every model, which means it is really a rule about what the shop sells. Its other half
 * therefore lives in `catalog-fashion.mjs`, where the products that could not satisfy it were
 * replaced rather than re-shot.
 */
export const MODESTY =
  'MODEST dress throughout, without exception: necklines are high and closed, shoulders and upper '
  + 'arms are covered, hems fall below the knee, and the midriff, back, chest and cleavage are '
  + 'never exposed or suggested. Nothing sheer, nothing see-through, nothing tight-fitting or '
  + 'body-hugging, nothing cropped short, nothing low-cut, nothing with an open back and nothing '
  + 'with thin or bare straps. If a person wears or holds the item they are dressed modestly by '
  + 'the same rule, including whatever else they have on';

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
/**
 * 21:9, and this is the fix for a whole CLASS of complaint rather than a preference.
 *
 * The banner is delivered as a 3:1 band (`BANNER_RATIO`), cropped out of whatever is generated
 * here — and the crop is `g_auto`, so Cloudinary picks the band by saliency, not by obeying the
 * careful "keep it in the middle" the prompt asks for. At 16:9 that crop throws away 41% of the
 * height, and every banner complaint so far has been something that fell into it: שקמה's name off
 * the top (2026-08-13), אדנית's pots off the bottom and then a white letterbox band (2026-08-14),
 * and finally שקמה's tagline cut clean off the sign even though the sign was dead centre in the
 * source. Prompt wording cannot beat a saliency crop; a narrower crop can.
 *
 * At 21:9 the same 3:1 band keeps 78% of the height instead of 59% — about a ninth off each edge
 * instead of a fifth — so there is far less for `g_auto` to get wrong, and what it does take is
 * background either way.
 *
 * **"16:9 is the widest ratio the image API offers" stood here and was wrong.** Probed live
 * against `gemini-3.1-flash-image` on 2026-08-14: `aspectRatio: '21:9'` is accepted and returns
 * 1584x672 at `imageSize: '1K'`. Nothing was measured before it was written down the first time,
 * which is the only reason it survived three rounds of the bug it was causing.
 *
 * `g_auto` itself is deliberately NOT changed: `cdnBand` serves every real seller's uploaded
 * banner too, and for an arbitrary photograph saliency is the right chooser. This store's pictures
 * are the ones we control, so this is the end that moves.
 */
export const BANNER_ASPECT = '21:9';
/**
 * The ratio the banner is STORED at, which is not the ratio it is generated at.
 *
 * 21:9 narrowed the crop; it could not remove it, because no image model offers 3:1. So the
 * generator takes the last step itself — centre-crop to this ratio before the upload — and the
 * asset the manifest points at is already the shape the page shows. `cdnBand` then crops nothing.
 * The mechanism, and why Cloudinary rather than a local image library, is at
 * `cropToDeliveredRatio()` in `generate-showcase-images.mjs`.
 *
 * This is CONFORMING to the site's contract rather than special-casing around it: a real seller's
 * banner is already 3:1 by the time it is stored, because the dashboard's crop tool produces it
 * that way (`cdn.ts`'s `BANNER_RATIO` note). The generated stores were the only banners on the
 * site entering delivery at some other shape, which is exactly why they were the only ones losing
 * their edges.
 *
 * It must equal `BANNER_RATIO` in `src/lib/cdn.ts` — the same number in two places that cannot
 * import each other (a `.mjs` build script and a TypeScript module). `tests/showcase-banner-ratio`
 * fails if they drift, because drift here is silent: the banner would simply start being cropped
 * again, which is the bug this exists to end.
 */
export const BANNER_DELIVERED_RATIO = 3;

export const SHOWCASE_STORES = [
  {
    slug: 'showcase-fashion',
    name: 'סהר',
    tag: 'אופנה',
    /** Was "אופנה יומיומית שכיף ללבוש" — owner, 2026-08-17: "משפט מאוד מטומטם". It is painted into
     *  the banner photograph rather than laid over it, so this line and that picture change
     *  together or the shop says two different things. */
    tagline: 'בגדים שטוב ללבוש',
    description:
      'חנות לדוגמה של Dezabin — כך נראית חנות אופנה מלאה בפלטפורמה: מידה וצבע לכל דגם, '
      + 'קטגוריות מסודרות, גלריית תמונות לכל מוצר ומלאי שמתעדכן לפי הצירוף שנבחר.',
    /**
     * The shop's colour in the APP — header, badges, the wordmark drawn over the banner.
     *
     * It was `#2b2118` / `#c4622d`, a warm near-black and a terracotta, and it had been wrong
     * since 2026-08-12 without anybody noticing: that was the day this store was corrected OFF
     * warm plaster, and its own `region` clause has banned terracotta by name ever since. שקמה got
     * the matching repalette the same day (see its `colors`) and סהר did not, so the header wore
     * a colour its own photographs were forbidden to contain.
     *
     * Now it follows the sky the pictures are made of: the deep blue of the mark against the pale
     * field, and the warm gold that is the only other colour in that sky at the end of the day.
     */
    colors: { primary: '#1c3f6e', accent: '#d99a3f' },
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
     * folk craft — hand-painted, woven, traditional — while these are what a 2026 label actually
     * puts on a garment. Two stores using one mechanism to arrive at two unmistakably different
     * racks is exactly what the mechanism is for.
     *
     * ── Rewritten 2026-08-17, and the swing between the two rounds is the lesson ──
     *
     * The first list answered "more colour" with PRINT: an op-art spiral, a hand-drawn
     * checkerboard, a large-scale geometric, a graphic wave, a watercolour floral. The owner
     * looked at the finished rack and said the clothes themselves were the worst part of it —
     * "כל מיני פאטרנים לא הגיוניים ולא לבישים… צעקני מדי" — and named the register he wanted
     * instead: "אופנה של סקייטרים: דגמחים, חולצות אוברסייז, מחויטות ספורט אלגנט, לא גרפיטי ולא
     * פסיכדלי מדי".
     *
     * The correction to that was then over-corrected in turn, and he caught it in one word:
     * a rack of quiet solids is "משעמם". The brief that survived both is narrow and worth
     * stating exactly, because either edge of it has now been walked off once:
     * young and hipster-ADJACENT rather than hipster, stripes and a 90s memory read through
     * 2026, a LIGHT illustration on some pieces and not most, wearable throughout — and
     * "שעדיין יזכיר קצת את הבגדים שכן ישנם", so eight of the sixteen below are the wearable
     * half of the old list, kept verbatim, and the rack does not become a different shop.
     *
     * The counts are the brief made countable, and are the thing to preserve in any future
     * edit: 3 illustration entries (one printed, one embroidered, one repeating small), 4
     * stripes of different widths and eras, 9 plain colours carried by finish and trim rather
     * than by pattern. Nothing here is a full-surface graphic, because that is what "צעקני"
     * turned out to mean.
     */
    colorways: [
      // ── Kept from the first list: the wearable half, so the rack still reads as סהר ──
      'colour-blocked panels of rust and soft grey',
      'a fine tonal stripe in ink blue and white',
      'deep emerald green, plain — rich and grown-up, never bright or neon',
      'a warm terracotta with a contrast topstitch in ecru',
      'a muted lilac with a single wide cream stripe',
      'deep plum, plain, with a tonal sheen to the fabric',
      'an earthy olive with a subtle woven herringbone texture',
      // ── The 90s memory: two more stripe widths, and one clean contrast trim ──
      // ⚠️ None of these may describe the cloth as faded, washed, worn or vintage, however well it
      // reads as a brief: `NEGATIVE_PROMPT` bans exactly those words ("no fading, no patina,
      // nothing worn, aged, vintage") to keep the catalog looking like new stock, and a colourway
      // that fights it is resolved by the model at random. Say it as the DYE and the finish.
      'a wide 90s rugby stripe in soft forest green and bone, the green chalky and low in saturation',
      'a narrow vertical pinstripe in charcoal and chalk, the cloth relaxed and unstructured rather than formal',
      // Was "a bright cherry red with a clean white collar or trim" and it is gone for cause: it
      // landed on מכנסי מטען רחבים, which is one of the four products the HOMEPAGE store card
      // draws, and the owner's verdict on the result was "צבע אדום מזעזע … צבעים לא אנושיים כאלו"
      // (2026-08-17). The trim idea survives; the shout does not.
      'a dusty brick red, low in saturation and matte rather than bright, with a clean bone-white trim',
      // ── Light illustration, on three of sixteen — the owner asked for "איורים קלים על חלק מהבגדים" ──
      'soft cream with ONE small hand-drawn line illustration printed high on the chest — a crescent '
        + 'moon and a few loose lines, no more than a palm wide — in a single ink-blue colour, the '
        + 'rest of the garment completely plain',
      // Was "a soft grey marl …" and grey marl is what a sample of it looked like: correct, quiet
      // and forgettable. Same embroidery idea, on a colour worth photographing.
      'a soft powder blue with one small line drawing embroidered at the chest in thread-thin '
        + 'single-colour stitching, small enough to be missed at a glance',
      'a bone ground with a small hand-drawn 90s motif repeating quietly across it — a simple five-petal '
        + 'flower, drawn by hand and printed small enough to read as texture from a step away, never as a print',
      // ── Plain, but each one carrying a reason to look: a wash, a trim, a sheen ──
      'a deep soft charcoal in a heavy cotton with a low sheen, plain but beautifully cut',
      'a mid indigo blue, plain, with the seams and topstitching a shade lighter than the cloth',
      'soft chalky butter yellow, plain and low in saturation, with a fine cream rib at the collar and cuffs',
    ],
    /**
     * What the colour clause says AFTER naming the colourway — see `colorwayFor`, whose default
     * ends "genuinely saturated and cheerful rather than muted".
     *
     * That default is right for שקמה and wrong here, and it is half of why this rack went loud:
     * every colourway, however quiet its wording, arrived with an instruction to push it. סהר
     * needs the opposite pressure — the colour is real, the piece stays wearable — so it says so
     * in its own data rather than by editing a sentence three other stores depend on.
     */
    colorwayTone:
      'let it read as a real chosen colour rather than a beige default, but the piece must stay '
      + 'genuinely WEARABLE — nothing psychedelic, no graffiti, no full-surface graphic and no '
      + 'busy all-over print. Skate-adjacent and sport-elegant: cargo trousers, oversized shirts, '
      + 'relaxed unstructured tailoring. '
      // The other half of the same correction, and the one that produced the worst single image in
      // the store: the colour must be a colour a person actually wears, not the pure hue the model
      // reaches for when a colour is merely named.
      + 'The colour itself must be HUMAN and wearable — dyed cloth that has been washed and worn, '
      + 'slightly muted and slightly dusty. Never neon, never fluorescent, never a pure primary at '
      + 'full strength, never the loud saturated version of the colour named. '
      // The rack has to look like it came from the shop in the banner and was made by the label the
      // logo belongs to — owner, 2026-08-17: "אהבתי את הבאנר והלוגו, אז שאיכשהו הבגדים כן יתכתבו
      // איתם". The mark is flat blocks of cobalt, deep navy, orange and violet on cream, so those
      // are the colours the rack should keep answering, whatever the individual colourway says.
      + 'This label\'s own colours are cobalt blue, deep navy, warm orange and violet on cream, and '
      // He drew the line himself, and it is the whole difficulty of this store in one sentence:
      // "הבאנר הוא על תקן קונספט, כלומר הבגדים צריכים להיות פחות צעקניים ממה שיש בו באמת, אבל יותר
      // מזכירים אותו" (2026-08-17). The banner is a rail of twenty saturated pieces seen together
      // from across a room, which is a mood; one of them alone, filling half a frame, is a shout.
      + 'this piece should clearly belong to that family — but ONE garment on its own is seen much '
      + 'closer and much larger than a whole rail of them, so it wears a calmer, softer version of '
      + 'those colours than the rail does. Related to them, never as loud as them',
    /**
     * The hero backdrop — see `PRODUCT_VIEWS.main`.
     *
     * It was "deep cool graphite grey, like dark honed stone … noticeably darker than the product,
     * with a pale grey marble ledge to stand on", and 98 of this store's 112 hero shots are that
     * wall. The owner's reaction to the finished shop, 2026-08-17, was "סהר נראה בעצם כמו בית
     * קברות" — which is a fair reading of the specification rather than a failure to follow it: a
     * dark stone field, a pale stone slab, one object centred on it, and `PRODUCT_VIEWS.main`'s own
     * "nothing else is in the picture". Every element of a headstone was asked for by name.
     *
     * Marble is out for the same reason and in his words — "הויטראז׳ והשיש מזכירים לי קונוטציות לא
     * טובות".
     *
     * What replaces it is not invented, and that is the point of this round. In the same breath he
     * said the one thing he DID like: "דווקא *כן* אהבתי את הבאנר והלוגו, אז שאיכשהו הבגדים כן
     * יתכתבו איתם". So the hero is now taken FROM the banner instead of designed against it — the
     * banner is a rail of clothes against a pale sunlit limestone-block wall, bright and warm and
     * cheerful, and it is the only picture of this store that has ever survived a review.
     *
     * The limestone that replaced it lasted one sample. It read as אדנית — "רקע של אור יום, חום,
     * אבנים ואדמה. אני חייב שהחנות הזאת תהיה מאוד שונה מאדנית, מאוד" — which is true and was
     * predictable: אדנית's own backdrop is warm sand plaster in bright daylight, and two stores
     * cannot both be the sunlit stone one.
     *
     * ── Sky, and why it is the answer to four separate complaints at once ──
     *
     * His idea, 2026-08-17: "אולי רקעים של שמיים, כחול יותר, עננים. משהו על גבול הלא אמיתי", then
     * "שמיים נקיים" when asked to choose. It is the only field left that no other showcase store
     * can be confused with, and each of the four is now taken by something incompatible:
     *
     *   אדנית  warm sand plaster, daylight, stone   → the graveyard's replacement collided here
     *   שקמה   deep teal, saturated, painted plaster → ⚠️ THE ONE TO STAY AWAY FROM, in his words
     *          "*שלא יהיה דומה לשקמה!!!!*" — so this sky is PALE and washed out, never a rich or
     *          saturated blue, and never anything that could be called teal or blue-green
     *   Teklar seamless white studio sweep          → rules out the plain white he also considered
     *   סהר    ← open sky
     *
     * It also answers the missing feet. The hero had a floor, a figure stood on it, and the model
     * kept ending legs where the floor met the frame ("יש דוגמנים שחסרים להם איברים! פתאום אין
     * כפות רגליים"). A sky has no floor and no horizon, so there is no place for a body to be cut
     * off against — see `LIMB_SAFETY` for the half of that fix that is not the backdrop's job.
     */
    /** There is no surface in this store's hero, so the shared staging sentence — which names one —
     *  is replaced rather than argued with. See `SURFACELESS_MAIN`. */
    backdropSurfaceless: true,
    backdrop: 'open SKY and nothing else — a soft pale sky blue, washed-out and light like a hazy '
      + 'morning, going almost white toward the bottom of the frame, with one or two thin wisps of '
      + 'high white cloud. There is no wall, no floor, no ground, no horizon line and no surface of '
      + 'any kind: the product simply hangs in clear open sky with a soft shadow of its own beneath '
      + 'it. Clean and quiet like a studio, but the studio is the sky — slightly dreamlike, just on '
      + 'the edge of unreal. The blue is PALE and airy: never a deep, rich or saturated blue, never '
      + 'turquoise, never teal, never blue-green, and never a dark or dramatic sky. '
      // Measured on the first sky sample, 2026-08-17: the flat-lay shots obeyed "no horizon"
      // perfectly and the WORN ones put the model on a hilltop, because a person standing against
      // sky is a person standing somewhere and the model supplies the somewhere. Naming the sky is
      // not the same as banning the ground.
      + 'Sky is the ONLY thing behind the product: no hills, no mountains, no landscape, no rooftops, '
      + 'no trees, no scenery and no ground of any kind, not even far away and out of focus',
    /**
     * The stained-glass room, on roughly one hero shot in nine (owner, 2026-08-14, about his own
     * banner: "זה גם כל כך יפה שעשית מאחורה עם הויטראז׳ … אי אפשר לעשות מעט מוצרים עם כזאת אווירה
     * מאחורה?").
     *
     * It is described as LIGHT and not as a window, and that is what makes it safe rather than a
     * violation of `PRODUCT_VIEWS.main` — whose whole design is one object on a plain field with
     * "no props, no objects, no room, no scenery", and which is the rule that stopped this catalog
     * cropping its own products. Coloured light falling across a plain wall adds no object to the
     * frame, cannot crowd the garment and cannot be cut off. The wall is still a plain wall.
     *
     * "מעט" is the whole brief, so it is a minority and not a new house style: the plain sweep is
     * what tells this store apart from the other three at a glance in the grid, and a shopper who
     * meets the coloured light on every third product stops seeing it.
     *
     * Rarer as of 2026-08-17, one in twelve rather than one in nine: "זה בסדר בנגיעות, זה חייב
     * להיות מאוזן".
     *
     * And it is no longer stained glass at all. That whole idea died the same day — "הויטראז׳ והשיש
     * מזכירים לי קונוטציות לא טובות" — and it was never the coloured light he objected to, it was
     * the church the limestone and the marble built around it. So the exception stays an exception
     * in LIGHT and drops the room: the same open sky as every other hero, at the end of the day
     * instead of the morning. Same world, different hour, no second location to explain.
     */
    /**
     * Products that ALWAYS get the stained-glass light, whatever the hash says (owner, 2026-08-14:
     * "רוצה לפחות 2 מוצרים עם ויטראז׳ על גבי כרטיסיית חנות כמוצרים לדוגמא").
     *
     * These are the four thumbnails the homepage store card draws, and the card takes them by rule
     * rather than by choice: `getStorePreviews` returns the first image of the four NEWEST visible
     * products that have a photo. Nothing chooses them — not the owner, not a seller — so a
     * one-in-nine hash landing on any of them was pure luck, and it did not (0 of 4).
     *
     * Naming them here is honest about what it is: the store card is the only picture of this shop
     * a stranger sees on the homepage, so for a SHOWCASE store — an exhibit, whose whole job is to
     * show what the platform can look like — it is staged deliberately rather than left to a
     * `created_at` ordering. Two of the four, not all four, so the card still shows the store's
     * ordinary plain sweep beside it and the coloured light still reads as the exception.
     *
     * ⚠️ It is a NAME LIST, so it breaks silently in one specific way: rename a product and the
     * entry stops matching and simply stops applying. `tests/showcase-catalog-integrity` fails if
     * a name here is not in the catalog.
     *
     * Only the blazer is here for the card's sake — `cardProducts`'s other stained-glass slot,
     * סניקרס רטרו, is picked by the hash already and needs no entry. The dress is no longer on the
     * card at all (owner, 2026-08-14: "לא אהבתי שהראשון שם זה שמלה פרחונית, אני מעדיף במקום איזה
     * נעליים"); it stays in this list only because its picture was already made this way and
     * spending a generation to undo a good image buys nothing.
     */
    // Renamed with their catalog rows on 2026-08-17 ('ז׳קט בלייזר לא מובנה' → 'בלייזר רך'). This is
    // the silent-break case the ⚠️ above describes, caught only because the rename and this list
    // were edited in the same sitting; `tests/showcase-catalog-integrity` is what catches the time
    // they are not.
    backdropAccentAlways: ['בלייזר רך', 'שמלת קיץ פרחונית'],
    /**
     * What the homepage store card shows, in order — see `cardAt()` in the showcase seeder for how
     * a name here becomes a `created_at`, and why the alternative was not stable enough to stage.
     *
     * The soft V-neck top leads (owner, 2026-08-14: "במקום הנעליים שים למעלה חולצת מחשוף V רכה
     * שיש שם, היא יפה יותר" — it replaced סניקרס רטרו, which had replaced the floral dress).
     *
     * Two of the four still carry the stained-glass light — the V-neck by the hash, the blazer by
     * `backdropAccentAlways` — and two carry the store's ordinary graphite field, which is the mix
     * that makes the coloured light read as an exception rather than as this shop's default. That
     * the swap kept the count is luck, not design: if a future swap lands on two plain products,
     * the replacement's name goes in `backdropAccentAlways` and its picture is regenerated.
     *
     * The four are also deliberately four DIFFERENT things — a top, a jacket, a trouser, an
     * accessory. A card of four tops says less about a clothes shop than four categories do, and
     * this is the only picture of the store a stranger meets on the homepage.
     */
    cardProducts: ['חולצה רכה בצווארון עגול', 'בלייזר רך', 'מכנסי מטען רחבים', 'חגורת עור קלאסית'],
    backdropAccent:
      'the same open sky with no wall, floor, ground or horizon anywhere — but at golden hour '
      + 'instead of morning: a soft gradient of pale apricot and warm gold low in the frame rising '
      + 'into light blue above, with one or two long thin clouds catching warm light along their '
      + 'edges. Warm, soft and hazy, still pale rather than saturated, and still just on the edge '
      + 'of unreal. The product hangs in it exactly as it does in the plain sky, lit warmly from '
      + 'the side. No sun disc in frame, no dramatic red sunset, no dark sky, nothing else at all',
    logoStyle:
      // No typography note here, deliberately: this store is `logoNameless`, and a style line that
      // describes how to set the name is an instruction to draw one. That contradiction is what put
      // "סהר" under the crescent on the first attempt even though the naming clause said MARK ALONE
      // — given two instructions, the model followed the more specific.
      // Repalette 2026-08-14, owner: "את הלוגו עצמו צריך להחליף לצבע כחול או אפור כהה ויותר צבעים
      // נלווים מבחינת הירח עצמו." Two separate asks and they are easy to collapse into one by
      // accident: the mark's OWN colour becomes deep blue, and the moon stops being a single flat
      // shape — it carries two or three more colours inside its own silhouette. Written as flat
      // areas with crisp edges rather than as a gradient, because a gradient is the one thing a
      // 56px circle turns to mud, and `LOGO_NEGATIVE` bans them for that reason anyway.
      // ── The two crescents faced opposite ways, and the BANNER's is the one that stays ────────
      // Owner, 2026-08-14: "בבאנר שמת חצי ירח אחד ובלוגו אחד אחר, כל אחד פונה לכיוון אחר, צריך
      // שיהיה אחיד" — then, on being asked which: "יותר אהבתי את הסהר של הבאנר אז אולי תתאים אותו
      // ללוגו."
      //
      // The cause is worth keeping, because it will recur the next time two pictures share a mark.
      // The banner was generated WITH the logo attached as a reference, which fixes a shape but
      // says nothing about its handedness — a reference image constrains what a thing looks like,
      // not which way round it is drawn, and a crescent is the one shape where those are different
      // questions. Nothing in either prompt named a direction, so both were free, and they landed
      // on opposite answers.
      //
      // So the direction is now WORDED rather than merely referenced, in the one place that can be
      // checked by eye — and the reference runs the other way (`logoRefKey`), because the picture
      // he chose is the banner's.
      // ── A WHOLE-BANNER reference was tried here and failed; a CROPPED one is the answer ──────
      // Owner, three rounds running, ending in "הלוגו של סהר לא נראה כמו בבאנר! צריך להיות *בדיוק*
      // אותו הסהר" (2026-08-14).
      //
      // First attempt: `logoRefKey: '__banner'` with no crop. What came back was a soft blurred
      // copy of the whole shop — the rail of clothes, the room — with no mark in it at all. A model
      // shown a picture reproduces the PICTURE; "redraw only the small object on the right, flat"
      // loses to a photograph of a room. Second attempt: no reference at all, the crescent
      // described in words. That produced a good crescent facing the right way and NOT the same
      // crescent — words can carry direction and palette, they cannot carry a specific division of
      // a shape into five wedges.
      //
      // `logoRefCrop` fixes the premise instead of arguing with it: the reference is cut down to
      // the mark alone before it is sent, so the target IS the reference's whole subject — which
      // is the condition under which a reference has worked every time here (שקמה's emblem is the
      // middle of its own banner; אדנית's lettering is inside its own illustration). The words
      // stay, because they carry what a reference cannot pin: handedness, and the fact that the
      // output is flat vector rather than a photograph of a painted panel on a wall.
      'A flat vector logo artwork on a plain solid background — a digital design file, not a '
      + 'photograph, not a 3D render, not a sign on a wall: no perspective, no shadow, no texture, '
      + 'no mockup, no wall behind it and no lighting on it. The reference image is this shop\'s '
      + 'existing mark, photographed. Reproduce it EXACTLY as a flat drawing: the same crescent, '
      + 'the same proportions, the same wedge divisions in the same places, the same colours in '
      + 'the same order. DIRECTION, which matters most of all: the crescent\'s solid body is on '
      + 'the RIGHT and its two tapering horns point to the LEFT, so it opens leftward like a '
      + 'backwards C — never mirrored, never flipped, never opening to the right. The moon is deep '
      // The same repalette as `bannerLettering`, and it has to be stated in both: the logo is drawn
      // FROM the banner's mark, so if only one of the two moved, the reference and the words would
      // disagree and the model would settle it on its own.
      + 'navy blue, and across its width it is cut by straight radial lines into flat wedges of '
      + 'warm gold, light sky blue, soft violet, warm gold and light sky blue again, with the navy '
      + 'remaining at the top and bottom tips — every division a crisp straight edge, never a '
      + 'gradient, never a blend, never a glow. The background is a soft off-white, and the mark '
      + 'sits alone and generously spaced in the centre of the frame.',
    /** The banner, cropped to the crescent alone — see `logoStyle` for why the crop is the whole
     *  point and what happened without it. Fractional geometry so it survives the banner being
     *  re-rendered at another size; it does NOT survive the banner being regenerated with the mark
     *  somewhere else, which is why the crescent is also described in words.
     *
     *  ⚠️ **These numbers are measured off one specific picture and do not survive a new banner.**
     *  Three things are cut out of `__banner` by fractional geometry — this crop, and the two in
     *  `lockupUrl` that take the word and the mark for the header lock-up — and a regenerated
     *  banner puts the sign somewhere slightly different every time. So a banner regeneration is
     *  never one job: generate it, LOOK at the result, re-measure all three crops against it, and
     *  only then regenerate the logo and recompose the lock-up. Skipping the middle step produces a
     *  logo that is a blurry piece of wall, which is exactly what happened on 2026-08-14 and cost
     *  three paid attempts to work out. */
    // `logoRefKey`/`logoRefCrop` stood here and are deliberately GONE. This store's avatar is no
    // longer GENERATED from a reference at all — it is cut straight out of the banner, which is the
    // only construction under which "exactly the same mark" is a property rather than a hope. Four
    // rounds of evidence for that are in `markCutUrl`.
    //
    // The rectangle survives, because measuring it was the one part of the old route that worked.
    // Re-measured twice on 2026-08-17, once per banner — which is the point of the ⚠️ above:
    //   original  x_0.852,y_0.24 ,w_0.095,h_0.44   the banner this store launched with
    //   sky v1    x_0.820,y_0.20 ,w_0.125,h_0.54   the plain-sky banner
    //   sky v2    below                            the stained-glass banner
    // The reliable way to find them, rather than guessing: crop the whole sign area wide
    // (x_0.60,y_0.10,w_0.40,h_0.85), read the mark's edges off THAT at a known scale, convert back.
    logoCut: {
      key: '__banner',
      crop: 'c_crop,x_0.860,y_0.272,w_0.101,h_0.436,g_north_west',
      tolerance: 35,
      /** The banner wall's own cream, so the avatar still reads as the sign it was cut from. */
      pad: 'f7f3ee',
    },
    /**
     * The header lock-up — see `lockupUrl`. The NAME is cut from the banner's wall sign, which is
     * the only place it exists: this store is `logoNameless`, so its avatar is the bare crescent
     * and the word has never been drawn anywhere else. The MARK is cut from that avatar rather
     * than from the wall beside the word, even though the two sit together there, because the
     * avatar is the flat vector one — and the two appear within 200px of each other in the store
     * header, the mark in the tab strip and the lock-up in the bar. A photographed carved sign
     * beside a flat mark reads as two logos.
     *
     * The word crop stops short of the tagline beneath it (`h_0.31` reaches y≈0.57, the sub-line
     * starts at ≈0.60). It has to be cut geometrically rather than left to the trim, because the
     * tagline is the same ink as the name and `e_trim` stops at ink, not at meaning.
     *
     * Tolerance 55 on the word: the wall is photographed limestone with real variation in it, and
     * a tolerance tight enough for a flat colour leaves the stone behind as a grey haze. 25 on the
     * mark, which sits on a printed flat off-white and needs no more.
     */
    lockup: {
      // Re-measured with the stained-glass banner, and the right edge is the whole difficulty every
      // time this picture is remade: the ס ends around x=0.866 and the crescent's navy tip begins
      // around 0.872, so the rectangle has six thousandths of the frame to land in. Narrower clips
      // the ס; wider pulls in a navy sliver of the mark, which `e_trim` would then trim TO. Measured
      // by eye at five candidates, never estimated.
      word: { key: '__banner', crop: 'c_crop,x_0.617,y_0.285,w_0.251,h_0.310,g_north_west', tolerance: 55 },
      // No crop: the avatar IS the bare crescent on an empty field, so there is nothing to cut out
      // of it and a rectangle here would only be a thing to keep in step with a re-render.
      //
      // Tolerance 25 → 10 on 2026-08-17, and the cause is the repalette rather than the number.
      // 25 was measured against a mark whose panes were cobalt, violet and tangerine — all far from
      // the off-white ground. The sky palette put LIGHT sky blue next to that ground, and
      // `e_make_transparent` at 25 took it for background: the first lock-up composed after the
      // repalette had a crescent with the blue and violet panes punched out of it and only the gold
      // left. A cut-out's tolerance belongs to the colours it is cutting, not to the shape.
      mark: { key: '__logo', tolerance: 10 },
      // Nearly equal: this mark is a crescent, so it is already taller than it is wide, and giving
      // it the extra height a squarer mark wants would make it tower over its own name.
      wordHeight: 240,
      markHeight: 250,
    },
    address: 'דיזנגוף 112, תל אביב',
    selfPickup: false,
    // Mutually exclusive on purpose: a product carries exactly ONE categoryId, so
    // a curated shelf like "קולקציה חדשה" cannot be a category here without
    // stealing products out of the real ones and leaving them half empty.
    categories: ['נשים', 'גברים', 'הנעלה', 'תיקים', 'תכשיטים ואביזרים'],
    /**
     * COLOUR, and it is a correction rather than a preference (owner, 2026-08-14: "שהבאנר יהיה
     * יותר צבעוני, הוא כרגע רק אפור וזה משעמם … משהו יותר חי. משהו כיפי").
     *
     * The old subject was "a cool, quiet fashion studio in pale stone — greys and bone whites",
     * which is the store's PRODUCT direction restated. That is the mistake: the cool stone field
     * exists so a garment photographed against it reads as designed rather than busy (see
     * `region`), and a banner has no garment to protect — it inherited the restraint and kept none
     * of the reason for it. The colour the products carry one at a time (`colorways`) is all in
     * this one frame at once, which is also the honest picture of what this shop sells.
     *
     * The pale stone stays as the GROUND, so the banner is still recognisably this store and not
     * שקמה's warm room. What changes is what stands on it.
     */
    // MENSWEAR is named explicitly (owner, 2026-08-14: "חסר לי שם טאצ׳ של בגדי גברים בבאנר"), and
    // the omission was structural rather than careless: "a rail of clothes" is read by an image
    // model as womenswear every time, so a store that sells both had a banner that advertised
    // half of itself. The catalog has had a גברים category since 2026-08-13.
    /**
     * ── Rewritten 2026-08-17, and it is the only picture in this store being CHANGED rather than
     *    replaced ──
     *
     * The owner likes this banner ("דווקא *כן* אהבתי את הבאנר והלוגו") and it is the reference the
     * rest of the shop is now built from, so the room, the rail and the composition all stay. Three
     * things move, each from something he said in the same breath:
     *
     * 1. The rail sells what the shop sells: "שהבגדים בבאנר יהיו יותר דגימה של הבגדים שבאמת מוצעים
     *    אצלנו". It listed colours; it now lists garments that are rows in `catalog-fashion.mjs`.
     * 2. Every piece on it is MODEST, by the same rule as the catalog — a banner is the one picture
     *    a stranger sees first, and a sleeveless dress in it makes the rule a lie.
     * 3. The saturation comes down a step. "הבאנר הוא על תקן קונספט, כלומר הבגדים צריכים להיות פחות
     *    צעקניים ממה שיש בו באמת" — a whole rail seen from across a room can carry more colour than
     *    one garment can, but the gap between banner and rack still has to be a step and not a
     *    different shop.
     *
     * The marble ledge is gone with all the other marble, and an open view of SKY comes in through
     * the far end — the one thread that ties this room to the product photographs, which have no
     * room at all.
     */
    // MENSWEAR is named explicitly (owner, 2026-08-14: "חסר לי שם טאצ׳ של בגדי גברים בבאנר"), and
    // the omission was structural rather than careless: "a rail of clothes" is read by an image
    // model as womenswear every time, so a store that sells both had a banner that advertised
    // half of itself. The catalog has had a גברים category since 2026-08-13.
    /**
     * ── Round two, 2026-08-17: the stained glass comes back, and this time as the banner's ──
     *
     * Three notes in one breath, and they are one note: *"בבאנר תוסיף לי כן ויטראז׳ שם מאחורה,
     * משהו חסר לי"*, *"חסר לי אפקט וואו"*, *"משהו בבאנר ובלוגו מרגיש לי מעט מת מבחינת סטורציה"*.
     *
     * He is not contradicting the earlier ruling. Stained glass was pulled OUT of the product
     * photographs because a coloured pool on grey marble read as a church behind a single garment
     * ("קונוטציות לא טובות"), and it stays out of them. A banner is the opposite case: it is one
     * picture, seen once, whose whole job is to be the thing you remember about this shop — and the
     * one time he volunteered enthusiasm about anything here, it was for stained glass in exactly
     * this frame (2026-08-14). The room is what carries it safely, because there is a rail of
     * clothes and a sunlit doorway in the picture and the colour is an event inside a shop rather
     * than the entire world of a boot.
     *
     * The saturation note is the same instruction from the other side, and it belongs here rather
     * than in the products: the rack stays a step calmer than this picture ON PURPOSE
     * (`colorwayTone`), so raising the banner does not raise the clothes with it.
     */
    bannerSubject:
      'a bright, cheerful fashion room, RICH and saturated in colour, with a real wow factor: a '
      + 'long rail of clothes hung close together against a pale stone wall, and at the far end a '
      + 'tall STAINED-GLASS window in deep cobalt, violet, amber and emerald, lit from behind by '
      + 'the sun so that it glows and throws broad pools of coloured light across the pale stone '
      + 'floor and up the wall. The coloured light is the drama of the picture and it is generous — '
      + 'but it falls on the FLOOR and the far wall, never washing over the clothes on the rail, '
      + 'which stay true to their own colours. Beyond the window, clear pale SKY. '
      + 'On the rail, the shop\'s actual range and all of it MODEST — a floral midi dress with '
      + 'short sleeves, a soft unstructured blazer, a long trench coat, an oversized heavy shirt, a '
      + 'denim jacket, a fine knit sweater and wide-leg cargo trousers — with a definite section of '
      + 'MENSWEAR on broader hangers so it reads at a glance as a shop for both. Every garment has '
      + 'a high closed neckline, sleeves, and a hem below the knee; nothing sleeveless, nothing '
      + 'cropped, nothing low-cut. The colours are rich but WEARABLE and a step calmer than a '
      + 'poster: indigo, dusty brick red, emerald, soft lilac, olive, warm gold and cream. Below, '
      + 'a few bags and shoes set out on a simple pale wooden bench, and a striped rug on the '
      + 'floor. Clean bright daylight from the open end, alive and inviting, with deep saturated '
      + 'colour and real contrast — never washed out, never pale and flat, never grey, never '
      + 'monochrome, never austere, never empty, and no marble anywhere',
    /** The banner's own medium. Photographic, like the products, because this is a clothes shop and
     *  a shopper wants to see cloth — but the raking-daylight-and-atmosphere language that used to
     *  be hardcoded in `bannerPrompt` is gone, since that is what softened this exact banner
     *  (owner, 2026-08-12: "ממש מטושטשת") and what greyed it. */
    bannerStyle:
      // WHERE the sign hangs is the whole of this note. Three attempts put it high on the wall
      // above the rail, which is where a sign goes in a real shop and is also the top third of the
      // frame — so the delivered band cut the name in half twice. Telling the model "the middle
      // third" does not beat what it knows about shops; giving it a different PLACE for the sign
      // does. A name painted on the wall beside the rail, at eye level, is just as real and lands
      // where the crop can reach it.
      'A wide photograph, shot on a full-frame camera, in bright even daylight with everything in '
      + 'focus. Contemporary Israeli 2026: a pale stone or plaster room used as a CANVAS for '
      + 'strong saturated colour. Colourful, cheerful and inviting, the kind of shop you want to '
      + 'walk into. Composed left to right across the width: the clothes fill one side, and the '
      + 'sign has a clear calm panel of empty wall to itself on the other side. The sign hangs LOW '
      + 'on that wall, at eye level and at the exact vertical CENTRE of the picture — level with '
      + 'the middle of the clothes rail, never above it, never up near the ceiling, never in the '
      + 'top third of the frame. There is as much wall visible above the name as there is below it.',
    /** Not gold. The lettering colour is now the LOGO's, which is the pairing שקמה's own note
     *  argues for — its logo and banner were repainted to one palette because side by side they
     *  read as two different shops. סהר's mark went deep ink blue today, so its sign does too. */
    bannerLettering:
      // The letterform, round two (owner, 2026-08-14: "הפונט גם פשוט מדי"). What came back was a
      // plain even-weight sans, which is the shape a model defaults to when it is told a colour
      // and a material and nothing about the drawing. This store is `logoNameless`, so unlike
      // אדנית there is no logo lettering to copy — the type has to be specified instead, and what
      // makes a fashion label's name look designed is stroke contrast and spacing, not a font name.
      // THE MARK, beside the name (owner, 2026-08-14: "עשית לי את השם שלו אבל בלי הסמל של הסהר,
      // צריך להיות ליד הסמל"). It was never asked for: this store is `logoNameless`, so the crescent
      // and the name have only ever existed in two different pictures — the avatar carries the mark
      // and the banner carried the word, and neither one showed the shop's actual lock-up. The logo
      // now comes in as a reference image (`bannerRefKey`) so the crescent on the wall is the same
      // crescent, rather than a second, similar moon.
      'Mounted on the wall immediately beside the name — to the right of it, at the same height, '
      + 'sized to match the letters — is the shop\'s own mark: a crescent moon, its solid body on '
      + 'the right and its two tapering horns pointing to the LEFT, opening leftward. It is deep '
      // Repalette 2026-08-17, with everything else: "תתאים לצבעים של השמיים את הלוגו ואת הבאנר".
      // The wedges were cobalt, violet and tangerine — a good mark for a stone room and a slightly
      // hot one for a shop whose every product photograph is now pale sky. Same three positions,
      // moved onto the sky's own colours: the blue of it, the violet of its shadows, the gold of
      // its last hour. The navy body does not move; it is the mark's identity and the app's
      // `colors.primary`.
      // Deepened 2026-08-17: "משהו בבאנר ובלוגו מרגיש לי מעט מת מבחינת סטורציה". The panes were
      // written as "light" and "soft" to sit beside a pale sky, and pale beside pale is what read
      // as dead. Same three hues, at full strength — the sky family is the constraint, not the
      // paleness, and a mark is 56px in a header where a washed-out colour is simply not seen.
      + 'ink navy blue, and inside its own shape it carries flat blocks of vivid sky blue, rich '
      + 'violet and deep warm gold — clean saturated colour, never pale, washed out or pastel — '
      + 'divided by crisp straight edges. Cut as a solid panel and fixed to '
      + 'the wall. Exactly one crescent, and it and the name read as one sign together. '
      + 'Both are real, physical signage inside the scene — cut or painted letters mounted on the '
      + 'wall, lit by the same light as everything else and casting its own small shadow, never '
      + 'text laid over the photograph. The letterform is elegant and distinctive, the wordmark of a real '
      + 'fashion label: high stroke contrast between thick and hairline-thin strokes, refined '
      + 'tapered terminals, generous letter-spacing, drawn with real character — never a plain, '
      + 'even-weight, default-looking sans-serif. The letters are a rich DEEP INK BLUE, the same '
      + 'blue as the shop\'s own mark, standing out clearly against the pale wall behind them — '
      + 'never gold, never brass, never metallic, never grey.',
    /* `bannerRefKey: '__logo'` stood here and is deliberately GONE (2026-08-14). The banner is now
       the source of this store's mark and the logo is drawn from it (`logoRefKey`), so pointing the
       banner back at the logo would close a cycle in which neither picture is authoritative and a
       regeneration of either could quietly redefine the other. The crescent is therefore described
       in words in `bannerLettering` — including the direction, which is the thing a reference image
       never pinned and which is why the two disagreed in the first place. */
    /** Its own region clause, because the shared one names terracotta, olive and clay — and this is
     *  the store that was corrected OFF that palette. With the shared clause it came back as שקמה's
     *  room twice out of two: warm plaster, an olive branch in a clay jug. Israeli-Mediterranean is
     *  still the world; the surfaces in it are the cool half of it. */
    /**
     * Rewritten 2026-08-17, together with `backdrop`, and for the same reason.
     *
     * It read "a COOL palette throughout — marble, limestone, grey concrete, bone white and soft
     * grey. Absolutely no terracotta, no clay, no olive branches, no warm plaster", written on
     * 2026-08-12 to stop this store coming back as שקמה's warm room twice out of two. It worked,
     * and it cost the store its daylight: cool + grey + a dark hero field is the graveyard the
     * owner named five days later.
     *
     * That version lasted one sample and produced אדנית — see `backdrop`. The store is now sky, and
     * the gallery views follow it: same open air, same pale light, no building at all. That is also
     * the cleanest possible separation from all three of the others, because none of them is
     * outdoors in the sky and every material that got סהר into trouble — plaster, stone, marble,
     * concrete — is now simply absent rather than argued about.
     */
    region:
      'contemporary Israeli 2026 aesthetic, bright clean daylight OUTDOORS in the open air, high up '
      + 'against sky — pale blue, white and soft gold, airy and light. There is no building, no '
      + 'room and no interior: no stone, no marble, no concrete, no plaster and no wall of any kind. '
      + 'Absolutely no terracotta pots, no clay jugs, no olive branches, no woven folk textiles and '
      + 'no rustic props',
    /**
     * The gallery views' world — the hero is `backdrop` and skips this entirely.
     *
     * Rewritten with everything else on 2026-08-17, and it carries the two defects the first sky
     * sample must not repeat, both of them named by the owner looking at real pictures:
     *
     *   "יש בגדים מקומטים או שיושבים לא טוב על האנשים"  → the pressing clause
     *   "יש דוגמנים שחסרים להם איברים! פתאום אין כפות רגליים" → `LIMB_SAFETY`, shared, because it
     *     is a defect of every store that puts a person in frame and not of this one's taste
     *
     * The modesty clause is not a style note either and is deliberately absolute: the owner is
     * religious ("אני אדם דתי"), and asked for clothes "שמתאימים לאנשים שומרי מסורת". A garment
     * that violates it is not a picture to be re-rolled — it is the wrong product, so the CATALOG
     * carries the same rule (see `catalog-fashion.mjs`) and this clause is the second line of it.
     */
    artDirection:
      'editorial fashion photograph in the open air against clear pale sky, bright and airy, with '
      + 'nothing behind the product but sky and soft cloud — no room, no wall, no shop, no street. '
      + 'Clothing is WORN by a cropped figure so the cut and the drape read; bags and accessories '
      + 'are carried or held. Soft natural daylight from the side, with gentle shadows that have '
      + 'shape. At most one simple prop, and never a piece of furniture or architecture',
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
      'a single simplified sycamore leaf with a short stem, drawn as one flat solid gold shape with '
      + 'a few clean vein lines cut out of it',
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
    /**
     * Flat vector, gold on teal — and the photographed panel it replaces failed for a reason the
     * original `logoPrompt()` note had already recorded: **the avatar renders in a CIRCLE.**
     *
     * A photograph of a board is a rectangle with visible edges, so cropping it round produced a
     * teal square sitting inside a circle (owner, 2026-08-13: "הלוגו הזה שהוא ריבוע בתוך העיגול זה
     * לא כל כך יפה"). Nothing about the wording fixes that; the medium itself is wrong for the
     * frame it lands in. Any logo here must run EDGE TO EDGE, so that a round crop takes a clean
     * disc of colour rather than a photograph of an object with a border.
     *
     * The palette is now the banner's: deep teal ground, warm gold mark. The two were separately
     * plausible and side by side looked like two shops ("שונה מדי מהבאנר").
     */
    logoStyle:
      'A flat vector logo artwork — a digital design file, not a photograph, not a 3D render, not '
      + 'a sign, not a board, not a mockup: no perspective, no shadow, no texture, no panel and no '
      + 'visible edges of any object. The DEEP TEAL background is a solid flat colour that fills '
      + 'the entire image right to all four edges, with no border, no frame and no lighter margin '
      + 'around it. The mark and the Hebrew name sit on that teal in warm GOLD, high contrast and '
      + 'generously spaced in the centre. The name is set in a warm, slightly condensed serif with '
      + 'real weight.',
    address: 'ויצמן 8, רעננה',
    selfPickup: true,
    categories: ['ריהוט', 'תאורה', 'קרמיקה וכלי הגשה', 'טקסטיל', 'עיצוב ואקססוריז'],
    /**
     * The MAXIMAL one, and the only banner in the set that is (owner, 2026-08-14: "בדיוק כמו הלוגו
     * שיש כרגע שיהיה במרכז, ומסביב המון פרחים במלא צבעים בסגנון מקסיקני ריאליסטי מאוד ובכל מיני
     * צורות, וחיות דמיוניות כאלו, משהו פרוע כזה. שטיח ומנורה גדולה ונרות").
     *
     * It is a deliberate exception to the restraint every other picture in this file is written
     * for, and it earns it: this is the store whose whole identity is a decorative tradition
     * (Oaxacan pottery, Talavera, alebrije), stated in `artDirection` and carried by every product
     * it sells. A banner is the one frame where that tradition can be the subject rather than the
     * pattern on an object, and the other three banners stay quiet, so nothing about the set reads
     * as busy — only this shop does.
     *
     * "כמו הלוגו במרכז" is answered twice over: described here, AND the logo image itself is fed
     * to the model as a reference (`bannerRefKey`). Describing a mark and getting the same mark
     * back are different things, and this store has already been through the version where its
     * logo and its banner looked like two shops.
     */
    bannerSubject:
      'the shop\'s own emblem dead CENTRE — a deep teal roundel carrying the shop name in warm '
      + 'gold, exactly the mark in the reference image, hanging in the middle of the scene as a '
      + 'real painted enamel sign — and everything else massed symmetrically around it. Flowers '
      + 'everywhere, dense and overflowing, in every colour and every shape: marigolds, dahlias, '
      + 'roses, carnations, zinnias, wild blossoms large and small, in the hot Mexican folk palette '
      + 'of pink, cobalt, marigold orange, blood red and emerald. Among the flowers, fantastical '
      + 'carved animals in the alebrije tradition — a jaguar, a long-tailed bird, a lizard — '
      + 'brightly painted in dots and stripes, half hidden in the blooms. Beneath it all a woven '
      + 'kilim rug in terracotta and saffron; one large brass lamp lit warm to the side; lit '
      + 'candles with real flames scattered through the scene. Wild, abundant and joyful, every '
      + 'inch of the frame alive with colour, and yet ordered around the centre so the emblem is '
      + 'unmistakably the middle of it',
    /** Painted and highly realistic at once, which is what "בסגנון מקסיקני ריאליסטי מאוד" is
     *  asking for — not a photograph of a room, and not flat illustration either: the surface of a
     *  richly painted decorative panel where every flower, feather and flame is rendered with real
     *  texture and real light. */
    /**
     * PHOTOGRAPHED, round two (owner, 2026-08-14: "יצא לא מספיק ריאליסטי, נראה מאוד מלאכותי. זה
     * צריך להיות יותר אמיתי").
     *
     * "A richly painted panel rendered in extremely fine realistic detail" was an attempt to have
     * both — his original ask said "ריאליסטי מאוד" of a decorative Mexican world — and it produced
     * the thing that is neither: a digital painting, which is the exact look people mean by
     * artificial. Realism is not a level of detail you can dial up inside an illustration; it is
     * the medium. So the scene is now a real arrangement in front of a real camera, built out of
     * objects that exist — cut flowers, carved painted wood, beeswax, brass, wool.
     *
     * Note what this does NOT change: the subject stays maximal, the emblem stays at the centre.
     * The complaint was about how it was made, not about what is in it.
     */
    bannerStyle:
      'A photograph, shot on a full-frame camera with a macro-sharp lens — a REAL arrangement of '
      + 'REAL objects physically built in front of the camera and lit for it, not a painting, not '
      + 'an illustration, not a digital render and not a collage. Real cut flowers with real petals '
      + 'and real stamens; hand-carved painted wooden folk animals with visible grain, brush marks '
      + 'and worn paint; real beeswax candles with real flames and running wax; a real brass lamp '
      + 'with tarnish and fingerprints on it; a real hand-woven wool rug with individual threads. '
      + 'Everything has genuine texture, genuine weight and genuine imperfection. Deeply saturated '
      + 'Mexican folk colour, warm practical light from the lamp and the candle flames mixing with '
      + 'soft daylight, real shadows falling between the objects, real depth from things standing '
      + 'in front of other things. Photorealistic throughout, everything in sharp focus, the '
      + 'composition symmetrical and centred and filling the whole frame.',
    bannerLettering:
      'The name is on the teal emblem at the centre, in warm gold, exactly as the reference image '
      + 'sets it — real raised or painted lettering on a real object in the scene, catching the '
      + 'warm light, never text laid over the picture. It is the brightest and clearest thing in '
      + 'the frame and the flowers never cover or crowd it.',
    /** The logo, fed to the model as a reference image — see `bannerSubject`. */
    bannerRefKey: '__logo',
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
    // "Two straight bars meeting at one right angle" left the SOLIDITY unstated, and the mark-alone
    // render read it as licence to decorate the only shape in the frame: the T came back with a
    // second T cut into its face as a groove, and the blue edge glowing like a light rather than
    // being a painted side. A monogram this simple has to be described as one solid piece or the
    // model finds something to add to it.
    logoConcept:
      'a geometric monogram of the letter T as ONE single solid piece: one horizontal bar resting '
      + 'squarely across the top of one vertical stem, both with flat faces and sharp square ends, '
      + 'precise and engineered — no groove, no channel, no inset or engraved line, no second T '
      + 'cut into it, no outline, no cut-out and no pattern on any face',
    /** The 3D RENDER one, which is also this store's own language: everything Teklar sells is
     *  photographed as a clean object on white, so its logo is one too. */
    /** White, because this store's whole direction already IS the empty backdrop. Named anyway so
     *  the hero staging reads from one place for all four rather than from three plus an exception. */
    backdrop: 'a seamless white studio sweep falling very slightly to pale grey at the corners, '
      + 'and the same white surface to stand on',
    /** The MARK ALONE, like סהר (owner, 2026-08-14: "בלוגו לא צריך להיות הכיתוב של הטקלר"). Same
     *  reasoning that made סהר nameless and it applies at least as well here: a monogram IS a
     *  letterform, so a name set underneath it says the same thing twice, and the store's name sits
     *  beside the avatar on every surface the avatar appears on. It also takes the second store out
     *  of the one failure this file cannot fully control, a misspelt name. */
    logoNameless: true,
    logoStyle:
      // The typography sentence that stood at the end of this string is deliberately gone, not
      // merely unused: סהר's own note records that a style line describing how to set the name is
      // an instruction to DRAW one, and that given the naming clause and a type note the model
      // follows the more specific of the two. Removing the field without removing the sentence is
      // exactly how "MARK ALONE" loses.
      'A clean 3D render of the mark as a solid physical object standing on a seamless white studio '
      + 'surface — brushed anodised aluminium with a soft contact shadow beneath it and one crisp '
      + 'specular highlight along the top edge, shot straight on. Graphite, with exactly ONE of its '
      + 'side faces painted a flat matte electric blue — a painted surface, never a light, never a '
      + 'glow, never an illuminated edge or a neon strip.',
    address: 'הרצל 40, חיפה',
    selfPickup: false,
    /** The only store that opts OUT of the full styling language — see RESTRAINED_LIFE_DIRECTION.
     *  Its whole point is to be the plain one, in its copy and in its pictures alike. */
    restrained: true,
    categories: ['שמע', 'מחשוב ועבודה', 'טעינה וחשמל', 'בית חכם', 'צילום ווידאו'],
    /**
     * The homepage card leads with the ANCHOR products (owner, 2026-08-14: "צריך לשים את המוצרים
     * היותר מובנים בראשי … הדברים ששמת למעלה הם דברים קצת קיקיוניים ואיזוטריים").
     *
     * Left to `created_at` this store's card opened with an action-camera mounting kit, a mouse
     * mat, a microphone arm and a novelty speaker — four accessories, three of them accessories TO
     * something else that was not in the picture. An electronics shop is judged in four thumbnails
     * by whether it stocks the big obvious things, and only then by whether it also has the cable.
     *
     * So: the ultra-wide monitor, the soundbar and the turntable, which he named, and the lit photo
     * tent for "צילום לשולחן". Four categories out of five, and the three most expensive things in
     * the shop lead — which is also the honest picture of what this catalogue is for.
     *
     * ⚠️ He also said "רמקול USB", and there is no such product in this catalogue. The nearest is
     * `מיקרופון USB לשולחן` (a USB desk microphone), which is a swap of one name if that is what
     * he meant.
     */
    cardProducts: ['מסך אולטרה־רחב', 'סאונדבר לטלוויזיה', 'פטיפון עם מגבר מובנה', 'אוהל צילום מואר'],
    /**
     * The VECTOR one (owner, 2026-08-14: "לא הגיוני שהבאנר מוזהב, צריך שיהיה כמו הלוגו, יותר פשוט,
     * יותר ׳וקטורי׳ כלומר לא ריאליסטי. ותמונות של כל מיני ציוד היקפי ומחשבים וגאד׳גטים בכל מיני
     * זוויות").
     *
     * The gold is not a styling slip, it is the bug this whole round fixed: `bannerPrompt` used to
     * hardcode "polished brass, warm gold" for every store's lettering, so the plainest shop in the
     * set — a white studio sweep, graphite and one electric blue, `restrained: true` — was gilded
     * by the shared prompt no matter what its own direction said.
     *
     * Drawn rather than photographed is the other half, and it is the one place this store's
     * pictures and its banner are allowed to disagree: the products are photographs on white
     * because that is what a shopper needs to see, and a shelf of the same photographs is not a
     * banner. A flat vector field of the same objects is, and it is nearer to the logo, which is
     * what he asked it to look like.
     */
    /**
     * Round two, and the two notes only look contradictory (owner, 2026-08-14: "הבאנר צריך להיות
     * יותר מושקע, יותר תלת מימד, כיתוב בפונט יותר מקצועי ומתוחכם", one round after "יותר וקטורי,
     * כלומר לא ריאליסטי").
     *
     * Both point at the same target, which is this store's own LOGO: a 3D render of a machined
     * object on a white sweep. "Not realistic" ruled out a photograph, and flat vector was one step
     * too far past it — a flat outline drawing of a laptop is a diagram, and a diagram cannot look
     * expensive. A render is still a made thing rather than a photograph, and it is the only one of
     * the three that can. So the medium is now the logo's exactly, which is where it should have
     * been the moment he said "כמו הלוגו".
     */
    bannerSubject:
      'consumer electronics and computer peripherals as clean 3D-rendered objects, each seen from '
      + 'its own angle — a laptop open at three-quarters, a keyboard tilted from above, over-ear '
      + 'headphones in profile, a mouse, a smartwatch on its side, a compact camera, a power bank, '
      + 'a small speaker turned away, a neatly coiled cable, a monitor straight on — floating and '
      + 'arranged across the width in a considered, balanced composition at slightly different '
      + 'sizes and depths. EVERY object is complete and whole, with clear empty space between it '
      + 'and the edge of the picture: nothing touches the left or right edge, nothing runs off the '
      + 'side, nothing is half in and half out of frame. Leave a generous empty margin down both '
      + 'sides and keep the whole arrangement inside it',
    bannerStyle:
      'A premium 3D product-design render on a seamless white studio ground — the same medium as '
      + 'the shop\'s own logo: solid physical objects with real form, soft even studio lighting, '
      + 'matte and satin surfaces, gentle contact shadows and one restrained specular highlight '
      + 'along an edge. Rendered and immaculate rather than photographed, and not flat illustration '
      + 'either: it has depth and volume. The palette is the shop\'s own and only that — graphite, '
      + 'brushed dark aluminium, cool light grey, white, and ONE electric blue used sparingly as '
      + 'the accent. Expensive, precise and understated, the look of a good hardware brand\'s own '
      + 'launch page. Absolutely no gold, no brass, no bronze, no copper, no warm metal and no '
      + 'ornament of any kind.',
    bannerLettering:
      // "A tight, technical, medium-weight sans-serif" produced a plain light grotesque that reads
      // as a default rather than as a choice (owner: "הפונט … פשוט מדי" was said of סהר, "יותר
      // מקצועי ומתוחכם" of this one — the same complaint from two directions). A weight, a width
      // and a spacing are what separate a designed wordmark from a system font, so they are named.
      'The name is set as a designed wordmark in a sophisticated, tightly drawn geometric '
      + 'sans-serif with real weight and confidence — bold, low-contrast, generously letter-spaced, '
      + 'the kind of precise custom lettering a serious technology brand uses, never a thin or '
      + 'default-looking system font. Solid graphite, flat and matte against the render, sitting in '
      + 'a clear open area at the centre with the objects arranged around it. Never gold, never '
      + 'metallic, never a serif, never a script, and never with an outline, a shadow or a glow.',
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
    /**
     * The DRAWN one (owner, 2026-08-14: "זה כיוון טוב … אבל הכיתוב למעלה מדי, ואם אני אחתוך אז
     * העציצים ייחתכו מלמטה, ויש שם יותר מדי צל. משהו יותר ממורכז וחכם, אולי כמה עציצים או סבך כזה
     * של יער ועליו כתוב שם החנות … יותר מתוחכם, יותר באנרי, פחות צילום ריאליסטי").
     *
     * Three notes, and only two of them are about this store. The crop damage — type at the top,
     * pots cut off at the bottom — is `bannerPrompt`'s job and is fixed there for all four, because
     * a rule written into one store's subject protects one store. What belongs HERE is the medium
     * and the composition: a thicket that closes over the whole frame with the name in a clearing
     * at its centre has nothing at an edge to lose, which is the structural version of the same
     * fix. The heavy shadow goes with the photograph it came from; a drawn banner has no sun in it
     * to cast one.
     *
     * Illustration is also the right medium for this store specifically, and it is the one that
     * finally makes it stop looking like everybody else's photograph: its logo is already the
     * hand-drawn one (`logoStyle` — ink and gouache, visible brush strokes), so the banner is now
     * the only one in the set that matches its own mark's medium rather than merely its palette.
     */
    bannerSubject:
      'a dense, layered thicket of foliage filling the whole frame — big monstera and fan-palm '
      + 'leaves, ferns, trailing ivy, olive and eucalyptus sprigs, a few flowering stems — in five '
      + 'or six distinct greens from deep forest to fresh lime, with three or four terracotta pots '
      + 'and glazed planters nestled in among the leaves near the bottom, each one whole and '
      + 'complete. At the centre the leaves part into a calm open clearing of plain warm cream, '
      + 'and the name sits in it with the foliage arching around it on both sides',
    /**
     * Round two: the same drawing, rendered for real (owner, 2026-08-14: "שיהיה יותר ריאליסטי").
     *
     * This does NOT reopen "פחות צילום ריאליסטי" from the round before — both notes are live and
     * they are about different things. What he rejected was a PHOTOGRAPH of a nursery; what he is
     * rejecting now is flat screen-printed shapes, which came back looking like clip art. Between
     * them sits botanical illustration: every leaf modelled, veined and shaded, real depth and real
     * material, and still unmistakably drawn. That is also the older and better tradition for a
     * plant shop's sign than either extreme.
     */
    // Round three, and the note is the same word for the third time ("היער לא מספיק ריאליסטי"), so
    // the answer stops splitting the difference. Two rounds tried to land between illustration and
    // photograph — screen-print, then botanical plate — and each read as the flatter of the two,
    // because "painted but realistic" leaves the model free to choose, and it chooses painted. So
    // the LEAVES are now simply described as real, and only the treatment of the whole picture is
    // still designed. What he rejected in round one was a photograph of a NURSERY — a shop, a
    // ledge, a wall — not realistic foliage; nothing here brings that back.
    bannerStyle:
      'Photographic realism in the foliage: real living leaves with real surface — waxy highlights, '
      + 'fine veining, translucency where light passes through a leaf, tiny imperfections and '
      + 'curled edges, real depth of field falling away into the layers behind, real glazed and '
      + 'terracotta pots with weight and texture. The plants must look like plants somebody could '
      + 'photograph, not like drawn or painted shapes, not flat, not stylised, not vector, not clip '
      + 'art. The picture as a WHOLE is still composed and designed rather than a snapshot: warm, '
      + 'calm, even light with no sun, no hard cast shadows and no dark corners, symmetrical, the '
      + 'foliage built outward from the centre in both directions, and the name lettered into it.',
    bannerLettering:
      // "Hand-lettered in the same brush as the foliage" produced a clean drawn typeface, because
      // nothing told it WHICH brush — the logo was not in the room. It is now (`bannerRefKey`), and
      // the instruction is to copy it rather than to describe it (owner: "זה חייב להיות תואם לפונט
      // שמופיע בלוגו"). Same move that put שקמה's actual mark at the centre of its own banner.
      // LEGIBILITY beats the brush (owner, 2026-08-14: "הכיתוב לא ברור- הא׳ נראית כמו מ׳"). The
      // previous wording asked for "slightly uneven weight" and "a loaded brush", which is a
      // licence to let a stroke thicken until א closes up into מ — and א and מ differ by exactly
      // that, whether the diagonal arms stay open. The hand stays; the deformation does not, and
      // the two letters are named so the instruction has something to be checked against.
      'The name is HAND-LETTERED with a brush in the lettering style of the reference image — the '
      + 'same warm informal hand, the same deep olive-green ink, as if the same person lettered '
      + 'both. But every letter is drawn CLEANLY and CORRECTLY and is instantly readable: even '
      + 'stroke weight, open counters, clear space between the letters, nothing blotted, nothing '
      + 'closed up, nothing running together. In particular the first letter is א (aleph) and must '
      + 'read unmistakably as א — its two separate diagonal arms clearly open and clearly detached '
      + 'from the central stroke — never closing up into anything that could be read as מ. Large '
      + 'and confident in the clearing at the centre, with clear space around it so no leaf crosses '
      + 'or covers a letter. Never gold, never metallic, never with a shadow or an outline.',
    /** The logo, as a reference image — it is where the lettering has to come from. */
    bannerRefKey: '__logo',
    /**
     * The header lock-up — see `lockupUrl`. The two halves come from two different pictures, and
     * that split is this store's own answer to the question the other one does not have to ask.
     *
     * Its logo holds BOTH the mark and a name, so it could have supplied both. It should not: that
     * lettering is this hand at its roughest, and it is the version the banner was corrected AWAY
     * from — `bannerLettering` above spends a paragraph on א closing up into מ, and the banner's
     * name is the fixed one, bigger and evenly weighted and still the same brush. At 40px of header
     * height a closed-up counter is not a slightly wrong letter, it is a different word. So the
     * mark is cut from the logo and the name from the banner, which is also exactly what was asked
     * for ("כתובית בפונט שמופיע בבאנר").
     *
     * The word crop is the central clearing and its edges are tight for a reason the trim cannot
     * help with: foliage overhangs the clearing on both sides in the same greens as the ink, so a
     * loose crop keeps a leaf and `e_trim` treats it as artwork. `w_0.2467` stops just past the א
     * and short of the frond above it.
     *
     * LOW tolerances, and the pot is why. `e_make_transparent` clears every colour within its
     * tolerance of the corner pixel, in PARTIAL alpha — so on a warm cream ground a generous
     * setting does not stop at the paper. At 40 (owner, 2026-08-15: "עציץ חיוור? לא חום ולא ירוק?
     * נראה כמו משהו שעבר עשרות עיבודים") it had eaten into the olive greens and the terracotta
     * stripe as well, and what came out was the drawing with its colour half dissolved. The paper
     * here is flat enough that 12 removes all of it, which is the whole tolerance this needs.
     *
     * The rule generalises: a tolerance is bounded by the DISTANCE from the background to the
     * nearest colour in the artwork, not by how stubborn the background is. סהר can afford 55
     * because its ink is near-black navy on pale limestone; this store's mid-olive is much nearer
     * its cream.
     */
    lockup: {
      word: { key: '__banner', crop: 'c_crop,x_0.385,y_0.26,w_0.2467,h_0.31,g_north_west', tolerance: 18 },
      mark: { key: '__logo', crop: 'c_crop,x_0.25,y_0.12,w_0.50,h_0.48,g_north_west', tolerance: 12 },
      // The mark gets the extra height here, unlike סהר's: a pot with leaves rising out of it is a
      // tall shape whose visual weight is in its lower half, so matched to the letters it reads as
      // smaller than them.
      wordHeight: 200,
      markHeight: 280,
    },
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
      // ⚠️ "stands alone on a plain, simple surface, with a plain wall … behind it" is the sentence
      // a store with a SURFACELESS backdrop must not be sent — see `mainModifier` below. Two rounds
      // of new clauses lost to it before anyone noticed the contradiction was inside the staging
      // itself, and not in what was being added around it.
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

/**
 * The hero backdrop for one product — the store's plain field, or its `backdropAccent` for a
 * minority of them. See סהר's `backdropAccent` for what it is and why it is rare.
 *
 * Its own hash suffix, like `companionFor`/`colorwayFor`: sharing a hash with `viewsForProduct`
 * would mean every product with a full gallery also got the special backdrop, and the correlation
 * is visible long before anyone works out why.
 *
 * The divisor is not the rate — the hash is not uniform over a hundred Hebrew product names — so
 * the count is MEASURED before a run and named in the commit, the same way `companionFor` records
 * "8 of אדנית's 89".
 */
function backdropFor(store, subject, name) {
  if (!store.backdropAccent) return store.backdrop;
  // The named list wins over the hash — see `backdropAccentAlways`. It is checked against the
  // product's Hebrew NAME rather than its English image subject because the list is written and
  // read by a person, and the name is what he sees on the card he is talking about.
  if (name && store.backdropAccentAlways?.includes(name)) return store.backdropAccent;
  // 9 → 12 on 2026-08-17: "זה בסדר בנגיעות, זה חייב להיות מאוזן". See `backdropAccent`.
  return hashOf(`${subject}#stage`) % 12 === 0 ? store.backdropAccent : store.backdrop;
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
  /** The default pushes TOWARD colour, which is what שקמה and אדנית were corrected into needing.
   *  סהר was corrected the other way and overrides it — see its `colorwayTone` for why a store
   *  states this in its own data instead of this sentence being edited for everyone. */
  const tone = store.colorwayTone
    ?? 'let it be genuinely saturated and cheerful rather than muted';
  return ` This particular piece is finished in ${store.colorways[h % store.colorways.length]} — `
    + `use this colour and pattern rather than any neutral colour named in the description above, and `
    + `${tone}.`;
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

/** `name` is the product's catalog name (`row.n`) and is only read by `backdropAccentAlways`.
 *  Optional so that anything generating a one-off prompt without a catalog row still works; the
 *  hash rule does not need it. */
export function imagePrompt(store, subject, view = PRODUCT_VIEWS[0], name = '') {
  const life = store.restrained ? RESTRAINED_LIFE_DIRECTION : LIFE_DIRECTION;
  const world = view.key === 'main' && store.backdrop
    ? `Behind and beneath it: ${backdropFor(store, subject, name)}.`
    : `${store.artDirection}.${settingFor(store, subject)}${companionFor(store, subject)}${accentFor(store, subject)}`;
  // A gallery view is generated FROM the main image, so it opens by naming that reference — and it
  // drops the colourway, which is already visible in the picture it is being shown.
  const opening = view.key === 'main'
    ? `The product: ${subject}.${colorwayFor(store, subject)}`
    : `${SAME_ITEM_CLAUSE} For reference the product is: ${subject}.`;
  /**
   * The three human-body rules go on EVERY view, not into a store's `artDirection`.
   *
   * `artDirection` is skipped entirely by the hero (see `world` above), and the hero is exactly
   * where all three failures were reported: the missing feet, the creased garments and the
   * necklines are all in main images. A rule that only reaches the gallery would have looked
   * applied and changed nothing on the shot that every grid cell, card and ad feed reads.
   *
   * They are also unconditional rather than per-store. Modesty is the owner's own standard for the
   * whole platform ("אני אדם דתי") and not a quirk of the fashion shop; the other two are defects
   * that any picture with a person or a textile in it can have. A store that shows neither pays a
   * few tokens for clauses that describe nothing in its frame, which is the cheaper mistake.
   */
  const body = `${MODESTY}. ${PRESSED}.${presentationFor(subject)} ${LIMB_SAFETY}`;
  return `${PURPOSE_DIRECTION} ${opening} `
    + `${mainModifier(store, view)}. ${FIDELITY}. `
    + `${regionFor(store)}. ${life}. ${QUALITY_DIRECTION}. ${world} ${body}. ${NEGATIVE_PROMPT}.`;
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
/**
 * `sole` is false for the banner, and that is a correction rather than an option (2026-08-14).
 *
 * This clause used to end "No other writing anywhere." unconditionally — and the banner asks for a
 * SECOND line, the tagline, in the very next sentence. So every banner prompt sent since the
 * tagline was added has forbidden the tagline one clause before requesting it. For the logo the
 * closing sentence is simply true and it stays.
 */
const nameClause = (store, { sole = true } = {}) => {
  // U+0590–U+05FF is the whole Hebrew block, so the maqaf (־) and the gershayim (״) are already in
  // it — naming them separately is what the duplicate-character-class rule catches.
  const script = /^[֐-׿\s'"]+$/.test(store.name) ? 'Hebrew' : 'Latin';
  const closing = sole ? ' No other writing anywhere.' : '';
  return script === 'Hebrew'
    ? `The shop name "${store.name}" appears in the scene, spelled EXACTLY "${store.name}" — `
      + `four-square Hebrew letters read right to left, clean modern Hebrew typography, `
      + `correctly formed, well spaced and clearly legible.${closing}`
    : `The shop name "${store.name}" appears in the scene, spelled EXACTLY "${store.name}" in `
      + `LATIN letters — do not translate it, do not transliterate it into Hebrew or any other `
      + `alphabet. Clean modern typography, correctly formed and clearly legible.${closing}`;
};

/**
 * The banner's own prohibitions — NOT `NEGATIVE_PROMPT`, and for the reason `LOGO_NEGATIVE`
 * already records one level down (2026-08-14).
 *
 * That list opens with "no text of any kind, in any language", then "no headline, no lettering
 * laid over the image", then "no logo, no brand mark" — and the banner is the one picture in this
 * file whose entire job is to carry the shop's NAME, with שקמה's also carrying its logo. Every
 * banner prompt sent before today therefore demanded lettering in its first sentence and forbade
 * it in its last, which a model resolves by picking one: it is the likeliest explanation for gold
 * type appearing where the store's own palette was asked for, and for the name drifting to an
 * edge. What is kept from that list is only what still applies to a picture with two lines of
 * wanted text in it.
 */
const BANNER_NEGATIVE = [
  'no watermark, no signature, no border, no frame around the picture',
  // The two lines are named in the prompt itself; everything else is the failure this replaces.
  'no third line of text, no headline, no caption, no slogan, no address, no phone number, no '
  + 'price, no date, no invented words, no lettering in any other language, no garbled or '
  + 'half-formed letterforms anywhere',
  'exactly ONE of the shop name in the picture — no duplicate, no echo, no ghost copy, no '
  + 'reflection of it, no second smaller version of it anywhere',
  'no printed labels, no packaging text, no writing on any object in the frame',
  // סהר's second attempt came back with the whole shop repeated as a narrow strip along the bottom
  // edge, like a contact sheet — a wide frame invites a model to tile rather than to compose, and
  // it is only ever visible once you look at the uncropped source.
  'ONE single continuous scene filling the frame — never tiled, never repeated, never a second '
  + 'strip or narrow band showing the same scene again along any edge, never a mirrored or '
  + 'duplicated copy of the picture inside itself, never split into panels',
  // Same reasoning as the product list: a generated face resembling a real person is a likeness
  // problem on a live commercial domain, and nothing in a banner needs one.
  'no visible faces, crop above the shoulders if a person appears',
  'anatomically correct: if any part of a person is in frame, every arm, hand, finger and leg is '
  + 'complete, whole, correctly shaped and in its natural position',
  'nothing important cropped or running off the edge of the frame',
].join(', ');

/**
 * The banner, and the ONE thing this function no longer decides: the medium.
 *
 * It used to open every banner with "A wide photograph, shot on a full-frame camera", light it
 * with raking daylight, and put the name up in "polished brass, warm gold". Four shops given one
 * art-directed picture came back as one picture four times — which is exactly the lesson
 * `logoPrompt()` learned twice over and wrote down: *whatever this prompt holds constant is what
 * will make the four look alike.* The owner said it about the results (2026-08-14): Teklar's
 * banner was gilded when its whole store is a white studio, and אדנית's was a photograph when what
 * a nursery's banner wants is a drawn one.
 *
 * So the medium, the palette, the lettering material and the composition all moved into
 * `bannerStyle`, per store, exactly as `logoStyle` holds them for the logo. What stays here is
 * only what is true of all four regardless of how they are drawn: the two lines of lettering and
 * their spelling, the crop, sharpness, and the prohibitions above. `regionFor()` and
 * `QUALITY_DIRECTION` are deliberately NOT appended any more — both are written for photographs
 * ("photorealistic and sharp on the product itself"), and a flat vector banner told to be
 * photorealistic is a prompt arguing with itself again.
 *
 * The one thing that must not come back is the old opening line, whatever the medium is. "A wide
 * editorial hero photograph for a shop's banner" is what printed "Hero Workspace" across Teklar in
 * a serif with a garbled English sub-line under it — naming a banner, a hero and an editorial
 * describes a LAYOUT, and a layout has a headline. No `bannerStyle` may use those words; each says
 * what the picture IS instead.
 */
export function bannerPrompt(store) {
  // The name is IN the picture (owner, 2026-08-12: "חייב כיתוב על הבאנרים, זה לא יכול להיות סתם
  // תמונה משעממת"). This reversed the SVG-overlay decision recorded below, and it reversed it on
  // evidence: the eight-image test showed the model spells a Hebrew shop name correctly most of
  // the time, and eight images is a set a person can check by eye.
  return `${store.bannerStyle} `
    + `The picture shows: ${store.bannerSubject}. `
    + `${nameClause(store, { sole: false })} ${store.bannerLettering} `
    // The tagline, at the owner's request 2026-08-12 ("אני רוצה גם משפט קצר על החנות בבאנר"). It
    // is the one place a SECOND line of lettering is asked for anywhere in this file, and it is
    // deliberately described as smaller and subordinate: two lines at equal weight is a poster,
    // and it also doubles the chance of a misspelling on the line nobody is looking at.
    + `Directly beneath the name, in noticeably smaller and lighter letters, the `
    + `line "${store.bannerTagline ?? store.tagline}" — spelled exactly that way, correctly formed `
    + `and legible, clearly secondary to the name above it. No other words anywhere in the picture. `
    // The banner is DELIVERED as a 3:1 band cropped from the middle of this 16:9 frame, so a fifth
    // of the height goes off the top and another fifth off the bottom. Twice now that has cost
    // something that mattered: שקמה's name (2026-08-13, "הבאנר של שקמה חתוך מלמעלה") and then
    // אדנית's pots (2026-08-14, "הכיתוב למעלה מדי, ואם אני אחתוך אז העציצים ייחתכו מלמטה"). The
    // second is why this clause now governs the SUBJECT and not only the lettering: a rule that
    // only protects the type just moves the amputation to whatever is under it.
    + `IMPORTANT — the finished picture is cropped to a wide band across the MIDDLE of this frame: `
    + `a strip off the top and a strip off the bottom are thrown away. Everything that matters — `
    + `the name, its line, and the main subject, whole and complete — sits well inside that middle `
    + `band, with generous clear space above and below it. Nothing important touches or comes near `
    + `the top or bottom edge. `
    // "Leave the top and the bottom of the frame as quiet background that can be lost without
    // taking anything with it" stood here, and אדנית's banner answered it exactly: the model drew
    // the artwork as a 3:1 strip with a plain WHITE BAR above and below it (owner, 2026-08-14:
    // "האורך נחתך למטה נראה שיש שם חלל לבן"). It did what it was told. The mistake was telling a
    // picture that part of it was disposable — the CROP is what is disposable, and the picture has
    // to be a whole picture at 16:9 whether or not anyone ever sees its edges.
    + `The picture still FILLS THE WHOLE FRAME, edge to edge, all the way to all four sides: the `
    + `top fifth and the bottom fifth are simply more of the same scene, quieter and with nothing `
    + `important in them. Never a blank, white or empty band across the top or the bottom, never a `
    + `letterbox, never a border, never a plain margin — no part of the frame is left empty. `
    // Owner, 2026-08-12: "התמונה בבאנר של סהר ממש מטושטשת." Depth-of-field language is what did it
    // — asked for three focal distances and atmosphere, the model softened the whole frame. A
    // banner is displayed 1400px wide and is the first thing anyone sees, so sharpness is named
    // explicitly and outranks any atmosphere a `bannerStyle` asks for. Worded for any medium: a
    // drawn banner has no focus, but it can still arrive mushy.
    + `The image is CRISP and SHARP across the whole frame, especially the lettering — high `
    + `resolution, fine detail, clean edges, no blur, no soft-focus haze, nothing mushy or `
    + `pixelated. `
    + `${BANNER_NEGATIVE}.`;
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
    // THE FRAME IS A CIRCLE, in the one place a logo is seen most: `StoreAvatar` crops it round at
    // 56px in the header and on every store card. So the background has to bleed to all four edges
    // — a logo with a visible panel, card, sheet or border becomes a square sitting inside a circle
    // (owner, 2026-08-13). This is a constraint of where the picture LANDS, not of its style, which
    // is why it sits here rather than in any one store's `logoStyle`.
    + `The background colour or surface runs edge to edge across the whole image, with no border, `
    + `no frame, no visible panel or sheet, and no lighter margin around the outside — the artwork `
    + `must survive being cropped into a circle. `
    + `The mark and any lettering are centred with generous even margins inside that, well clear of `
    + `the edges, complete and nothing cropped. `
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

/**
 * The HORIZONTAL LOCK-UP — the store's mark and its name side by side, for the header.
 *
 * **Why a third brand image exists at all.** `Header.astro` draws `headerLogo` into an 11rem × 40px
 * box (14rem on desktop), a strip of roughly 4.4:1, and CONTAINS it. The avatar is square, so in
 * that box it renders 40px wide and the shop reads as a dot; the banner is a 3:1 photograph of a
 * room, and at 40px high its lettering is gone. Neither picture is wrong — they are not this
 * shape, and a lock-up is the shape a header wants.
 *
 * **The name is on the LEFT of the mark** (owner, 2026-08-15), which for these two stores is not an
 * arbitrary layout choice: it is what their own signage already does. סהר's banner hangs the word
 * to the left of the crescent, so a lock-up that mirrored it would contradict the wall it came from.
 *
 * ── It is COMPOSED, not generated, and that is the whole design ─────────────────────────────────
 * The first version of this asked Gemini for the lock-up, handing it the banner as a reference so
 * the letterform would be the banner's ("כתובית בפונט שמופיע בבאנר" — the ask). Four paid attempts
 * came back with the same two defects: the artwork bled to the frame and the outer letter was cut
 * in half, and אדנית's brush lettering arrived blurred with the letters run together. Both are the
 * known hard part of this pipeline — `bannerLettering` above spends a paragraph on א closing up
 * into מ — and neither is worth re-fighting, because **the letters and the mark already exist**.
 * The banner IS a picture of the name in the right letterform. The logo IS the mark.
 *
 * So this cuts them out and places them side by side: Cloudinary crops each source to the one
 * element, `e_make_transparent` drops the wall or the paper it was standing on, `e_trim` tightens
 * to the ink, and a layer overlay sets the two on one white strip. Every pixel of the result is the
 * store's own existing artwork, which is a stronger guarantee than any prompt can give — the name
 * cannot be misspelt because nothing redrew it, and the mark cannot drift from the avatar because
 * it IS the avatar. It also costs nothing and is reproducible: re-running rebuilds the same image
 * from the same two sources, where the generated version cost a paid image per attempt.
 *
 * The background is plain WHITE because of where this lands: `.site-header` is `--color-surface`,
 * `#ffffff`. A paper tone or a stone wall arrives as a visible rectangle pasted into the bar, and
 * the dashboard's own "הסר רקע" runs in a browser worker this script cannot reach.
 *
 * ── What a store has to declare ────────────────────────────────────────────────────────────────
 * `lockup: { word, mark, wordHeight, markHeight }`, where `word` and `mark` are each
 * `{ key, crop, tolerance }` naming one of the store's own manifest images and the rectangle to cut
 * from it. The two heights are what set the optical balance — a mark is usually drawn a little
 * taller than the letters — and they are per store because that balance is a judgement about these
 * two shapes, not a constant.
 *
 * The crops are FRACTIONAL (`x_0.385,w_0.2467`), so they survive a source being re-delivered at
 * another pixel size. They do NOT survive the source being REGENERATED — a new banner puts the name
 * somewhere else and the crop then cuts empty wall. That is the same fragility `logoRefCrop`
 * carries one level up and it is accepted for the same reason: the alternative is a saliency guess
 * that cannot be argued with, and these four pictures change roughly never.
 */
/** White kept around the finished strip, and the gap between the name and the mark. Both are in
 *  the same units as the per-store heights — the composite is built a few hundred pixels tall and
 *  then contained into a 40px header box, so these are proportions written as numbers. The margin
 *  survives into the delivered asset (the lock-up is NOT trimmed afterwards; see below), which is
 *  the breathing room `.store-header__brand` does not supply itself. */
const LOCKUP_MARGIN = 40;
const LOCKUP_GAP = 70;

/**
 * The size one cut-out piece comes out at, asked of Cloudinary rather than guessed.
 *
 * This is the whole reason `lockupUrl` is async, and it is not optional. The canvas has to be
 * exactly `word + gap + mark` wide, and a piece's width after `e_trim` is not predictable from its
 * input — the trim's whole job is to find an edge nobody measured. The first version guessed a
 * generous canvas and trimmed the result instead, which fails in a way worth recording: `e_trim`
 * removes a uniform BORDER, so it took the outer white off and left the guess's surplus sitting in
 * the MIDDLE, between the name and the mark. The lock-up came out as a word and a mark at opposite
 * ends of a white bar.
 *
 * `fl_getinfo` returns the transformation's output dimensions as JSON without rendering the image
 * for delivery, so two extra round trips buy an exact layout.
 */
async function measure(url, transform) {
  const res = await fetch(url.replace('/upload/', `/upload/${transform}/fl_getinfo/`));
  if (!res.ok) throw new Error(`could not measure a lock-up piece (${res.status})`);
  const info = await res.json();
  if (!info?.output?.width) throw new Error('fl_getinfo returned no output size');
  return info.output;
}

/** Cut one piece out of one source: crop to it, drop the surface it was standing on, tighten to
 *  the ink, scale to the height it is wanted at. */
const cut = (part, height) =>
  `${part.crop ? `${part.crop}/` : ''}e_make_transparent:${part.tolerance}/e_trim:10/c_scale,h_${height}`;

/**
 * The Cloudinary delivery URL that IS the finished lock-up, built from the store's own two images.
 *
 * Returns null when either source is missing from the manifest, which the caller treats exactly as
 * it treats a missing reference image: the job is held back for a later run rather than failed.
 *
 * Reading it: the BASE is the word, cut and scaled and then padded out to the full canvas with the
 * word sitting at the west edge inside its margin; the MARK arrives as a layer that gets the same
 * cut-and-scale treatment before being applied at the east edge. Layer syntax puts the layer's own
 * transformations between `l_<id>` and `fl_layer_apply`, which is why the mark's crop reads as if
 * it belonged to the base until you reach that flag. `g_west`/`g_east` centre vertically, so the
 * two sit on one centre line whatever their heights.
 */
/**
 * The store's avatar, CUT out of its own banner instead of drawn again.
 *
 * **Why this exists at all, after four rounds of trying to make generation match.** The owner has
 * asked three separate times for the avatar and the banner's mark to agree, ending in *"הלוגו לא
 * זהה למה שיש על הבאנר, זה צריך להיות *בדיוק* אותו הדבר"* (2026-08-17). Every previous answer
 * tightened the words or the reference: describe the direction, attach the logo, attach a CROP of
 * the banner. Each got closer and none arrived, and none ever could — a generation from a reference
 * is a redraw, and a redraw of a five-wedge crescent is a different five-wedge crescent. The banner
 * came back with three stacked panes and the redraw made four radial ones.
 *
 * So the avatar stops being a picture OF the mark and becomes the mark: the same rectangle
 * `logoRefCrop` used to hand the model, cut out with `e_make_transparent`, trimmed to its own ink
 * and padded square. Identical is not a quality this can achieve badly, because nothing redraws.
 * It is the same reasoning that made the header lock-up a composition (`lockupUrl`), and the same
 * saving: no generation, nothing to pay for, and it reproduces exactly on every future run.
 *
 * **The tolerance is the whole risk, and it is a function of the palette rather than the shape.**
 * `e_make_transparent` keys on ONE colour — the corner — so panes close to the wall in luminance go
 * transparent with it. Tried first while the panes were "light sky blue, soft violet, warm gold" on
 * cream: at 45 the whole mark came back as a bare navy crescent with its panes punched out, at 30
 * only a ragged gold one survived. What made this viable was the owner's own next note, that the
 * palette felt "מת מבחינת סטורציה" — vivid panes are far from cream, and at 35 they all survive.
 * If the mark is ever repainted pale again, this route stops working and the note above is why.
 */
export function markCutUrl(store, manifest) {
  const spec = store.logoCut;
  if (!spec) return null;
  const src = manifest[`${store.slug}:${spec.key}`];
  if (!src) return null;                        // held back for a later run, like any missing ref
  return src.replace('/upload/', '/upload/'
    + `${spec.crop}/e_make_transparent:${spec.tolerance}/e_trim:8/`
    + `c_pad,w_1024,h_1024,b_rgb:${spec.pad}/f_png/`);
}

export async function lockupUrl(store, manifest) {
  const { lockup } = store;
  if (!lockup) return null;
  const wordUrl = manifest[`${store.slug}:${lockup.word.key}`];
  const markUrl = manifest[`${store.slug}:${lockup.mark.key}`];
  if (!wordUrl || !markUrl) return null;

  // A layer is addressed by public id, which is what a Cloudinary URL's last path segment is
  // without its extension. Deriving it rather than storing it keeps the manifest the single place
  // an image URL lives — a second copy of the same id is a second thing to update after a re-render.
  const publicId = markUrl.split('/').pop().replace(/\.[^.]+$/, '');

  const [word, mark] = await Promise.all([
    measure(wordUrl, cut(lockup.word, lockup.wordHeight)),
    measure(markUrl, cut(lockup.mark, lockup.markHeight)),
  ]);

  const canvasW = LOCKUP_MARGIN * 2 + word.width + LOCKUP_GAP + mark.width;
  const canvasH = LOCKUP_MARGIN * 2 + Math.max(word.height, mark.height);

  return wordUrl.replace('/upload/', '/upload/'
    + `${cut(lockup.word, lockup.wordHeight)}/`
    + `c_lpad,w_${canvasW},h_${canvasH},b_white,g_west,x_${LOCKUP_MARGIN}/`
    + `l_${publicId}/${cut(lockup.mark, lockup.markHeight)}/`
    + `fl_layer_apply,g_east,x_${LOCKUP_MARGIN}/`
    + 'f_png/');
}


export function storeBySlug(slug) {
  const store = SHOWCASE_STORES.find((s) => s.slug === slug);
  if (!store) throw new Error(`unknown showcase store ${JSON.stringify(slug)}`);
  return store;
}
