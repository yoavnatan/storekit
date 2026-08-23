/**
 * Builds the brand lockup — `npm run brand:wordmark`.
 *
 * THE WORDMARK IS THE TYPEFACE, AND NOTHING ELSE (2026-08-21). "Dezabin" set in
 * Libre Franklin ExtraBold at the face's own spacing. There is no drawn letter,
 * no thickening, no tracking and no levelling: every one of those was in the
 * previous lockup for a reason, and every one of those reasons went away with
 * the drawn octagon.
 *
 *   • THE DRAWN D IS GONE. It was the only part of the mark that was ours, and
 *     it was also the whole of what read as square — a straight back and three
 *     45° cuts. Every softer replacement was rendered and rejected over
 *     2026-08-21: a bowl that wraps past the arm ("not clear, doesn't fit the
 *     rest"), a chamfered wrap, a short flat foot, and the rounded families that
 *     could carry them ("looks like it's for children"). The owner's brief
 *     landed on "a clear, ordinary typeface, thick enough to see, stable,
 *     classic", and a drawn letter is the opposite of ordinary.
 *   • NO THICKENING. Chakra Petch stops at 700 with no variable axis, so 800 did
 *     not exist and a centred stroke was the substitute. Libre Franklin has a
 *     real ExtraBold; a stroke on top of it would only close the counters.
 *   • NO LEVELLED GAPS, and this is the one to understand before touching the
 *     spacing again. Levelling every ink gap to their mean was CORRECT under the
 *     thickening — a centred stroke eats its own width out of every gap
 *     regardless of how much was there, so the tight pairs went to nothing. With
 *     no stroke there is nothing to correct, and levelling actively damages the
 *     word: Libre Franklin sets `ez` at 17 units against a 65 mean, and opening
 *     it to the mean floats the z in space so its diagonal reads as a slab. The
 *     owner saw exactly that — "the z looks thick, in all of them" — which is
 *     the tell that it was the code and not the face. The tight pairs are tight
 *     ON PURPOSE: a z has less white inside its own box than a round letter.
 *   • NO TRACKING. Same argument. The face's own spacing is the answer until
 *     something eats it.
 *
 * WHY THE LETTERS ARE STILL OUTLINES. Unchanged, and it is not about the
 * thickening — that was only what forced the issue:
 *   • Libre Franklin never ships. Nothing else on the site uses it, so outlining
 *     it means no eleventh font preload on every page.
 *   • The logo cannot render in the wrong face. Every face in main.css is
 *     `font-display: optional`, which means a face not already available at
 *     first paint is not used AT ALL for that page view — the trap that made two
 *     successive alignment "fixes" measure 24px wrong in August. A path has no
 *     such state.
 *   • The site's logo and the poster files are one drawing.
 *
 * THE SECOND LINE IS A DIFFERENT DEVICE NOW. It used to be flush with the
 * wordmark on both ends, matched by SIZE because Hebrew cannot be tracked out to
 * a width. It is now small, centred and set under the name — the contrast
 * between a heavy tight name and a light open line is what does the work, and
 * `TAGLINE_TRACK_HE` is deliberately a tenth of what the Latin line takes,
 * because Hebrew loosens rather than enlarges when it is opened. Stretching it
 * to full width is still what was rejected on 2026-08-05, and is still the
 * failure mode to avoid.
 *
 * WHAT IS AUTHORED AND WHAT IS DERIVED. Authored: the tagline's size, gap and
 * two trackings, and the favicon's box. Everything else — the height, the
 * widths, the pen positions, the ink box — is read off the font. There are far
 * fewer authored numbers than there used to be, and that is the point: the
 * previous lockup needed eleven because it was a drawing.
 *
 * OUTPUT. One module, `src/lib/brand-lockup.ts`, plus the static SVGs and the
 * favicon. Every surface reads the module; `tests/brand-lockup.test.ts` holds
 * the static files to it. The lockup that shipped until 2026-08-21 is kept whole
 * under `assets/brand-archive/`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';
import { translations } from '../src/i18n/translations.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FONTS = resolve(ROOT, 'assets/brand-fonts');

/* ---------------------------------------------------------------- authored */

/** The name, and the letters the wordmark is. */
const WORD = 'Dezabin';

/** The second line's size, as a share of the wordmark's CAP HEIGHT.
 *
 *  0.33 is the owner's own doubling (2026-08-21): the first pass sat at 0.165,
 *  which read as a caption rather than as the other half of a lockup. At 0.33
 *  the two lines are a pair. Anything much past this and the line stops being
 *  subordinate, which is the whole device. */
const TAGLINE_SIZE = 0.33;

/** The space between the two lines, also a share of the cap height. Small on
 *  purpose: the gap is what keeps this a subtitle rather than a second name. */
const TAGLINE_GAP = 0.24;

/** The second line's weight, in the site's interface face. 400 and not 300, for one
 *  reason that has nothing to do with taste: the tagline is LIVE TEXT, and under Heebo a
 *  weight the site did not already ship meant two more font files (latin + hebrew) on
 *  every page for one line that renders on two of them. The face is variable now
 *  (2026-08-23) and 300 costs no extra file, so this is a free number again — but it
 *  stays at 400, because at 0.245em of the lockup a 300 Hebrew line goes thin enough to
 *  disappear against a very heavy name, which is the opposite of the contrast device the
 *  lockup is. Change it by looking at the poster, not by reading this. */
const TAGLINE_WEIGHT = 400;

/** Tracking on the second line, in the TAGLINE's own em.
 *
 *  Latin gets 0.22 — that is the device: a wide-tracked light line under a tight
 *  heavy name. Hebrew gets a tenth of it, because Hebrew does not take tracking:
 *  opening it does not enlarge the word, it loosens it, and a loosened Hebrew
 *  line under a tight Latin name is what read as amateur on 2026-08-05
 *  ("לא מספיק מקצועי ולא מספיק מתאים לאתר"). 0.05 is the most it took before the
 *  word came apart, measured on 2026-08-21 across 0 / 0.05 / 0.09 / full-width. */
const TAGLINE_TRACK_EN = 0.22;
const TAGLINE_TRACK_HE = 0.05;

/**
 * The smallest the second line may be rendered, in CSS px — and therefore, once
 * divided by its ratio, the smallest the whole lockup may be drawn.
 *
 * 15.5px is the owner's own floor from 2026-08-05 ("the Hebrew gets very small
 * on mobile"), and the homepage carried it as a TYPED lockup size — 2.5rem,
 * correct for a tagline that was then 0.3886em of the lockup. This lockup's
 * ratio is 0.245, so the same 2.5rem put the Hebrew at 9.8px on a phone and the
 * owner reported it the day it shipped. **A floor derived from a ratio must not
 * be typed as a size**, or the next change to the ratio silently breaks it —
 * which is exactly what happened. It is exported and the homepage reads it.
 */
const TAGLINE_MIN_PX = 15.5;

/**
 * A margin around the ink, as a share of the wordmark's own height, on every box
 * this file emits.
 *
 * NOT decoration, and not optical: **the ink must never sit on the edge of its
 * own viewport.** The wordmark's baseline is one flat line shared by all seven
 * letters, so when the box is cropped exactly to the ink, that line is
 * coincident with the box's boundary — and any ancestor with `overflow: hidden`
 * then chops the antialiased row, across the whole word at once. The owner saw
 * it the day this shipped: *"in the header the logo is cut along its whole
 * bottom"*. The clip was `.store-header__logo-col .logo`, a truncation boundary
 * written for a long store NAME and inherited by a fixed-width SVG that can
 * never be truncated.
 *
 * That rule is fixed too, but the rule alone is not the fix: it protects the one
 * ancestor we know about. The margin protects against every future one — a store
 * header, a card, an email client's own wrapper — because there is no ink at the
 * edge left to chop.
 *
 * 0.05 is one twentieth of the height: 0.84px at the header's size, i.e. most of
 * a device pixel at DPR 1 and two and a half at DPR 3. `HEIGHT_EM` is the BOX,
 * so the ink still renders at exactly the same size for a given font-size — the
 * box simply grows around it, into space the header row already had.
 * `tests/brand-lockup.test.ts` holds the ink strictly inside every box.
 */
const BOX_MARGIN = 0.05;

/** The site's brand gradient — the one `.btn` wears, unchanged. */
const BRAND_A = '#2a3c40';
const BRAND_B = '#3a5260';

/** How much of the FAVICON's box the D's ink fills, top to bottom — the tab icon
 *  only. Carried over unchanged from the octagon (owner, 2026-08-19), because
 *  the reasoning is about the SLOT and not about the letter: a tab strip gives
 *  an icon no air of its own, and edge to edge any letter reads as a slab. The
 *  value is a sixteenth so the ink lands on whole device pixels — 16 × 0.9375 =
 *  15 exactly, with half a pixel of air top and bottom, and 32 and 48 divide the
 *  same way. A fractional height gets smeared, and smeared at 16px is mush.
 *  `tests/brand-lockup.test.ts` holds the band. */
const FAVICON_INK = 0.9375;

/** The slogans the poster lockups carry, READ FROM THE DICTIONARY rather than
 *  copied. The site's own line is live text in BrandLogo.astro because it
 *  follows the visitor's language, and a second copy of the words here is the
 *  drift this repo has been bitten by more than once: change the tagline in
 *  `translations.ts` and every poster, the mail header and the share card keep
 *  saying the old thing, with nothing to notice. Node imports the `.ts` directly
 *  (type stripping, ≥22.18) — it holds only `export const`s. */
const SLOGAN_HE = translations.he.brand.tagline;
const SLOGAN_EN = translations.en.brand.tagline;

/* -------------------------------------------------------------- the faces */

const face = (file) => opentype.parse(readFileSync(resolve(FONTS, file)).buffer);

/** Libre Franklin ExtraBold, static. NOT the variable file instanced at 800:
 *  opentype.js applies `gvar` to the outlines but not `HVAR` to the advances, so
 *  an instanced run comes out 0.4% wide — right shapes, wrong spacing, and
 *  spacing is the thing this file exists to get right. The static cut measures
 *  5.1307 ink-to-cap against the browser's own 5.1330, which is rounding. */
const lf = face('LibreFranklin-ExtraBold.ttf');

/** The interface face, variable, instanced at the tagline's weight for the OUTLINED
 *  slogan in the poster lockups. The advance caveat above does not bite here: the
 *  second line is CENTRED, not matched to a width, so nothing downstream depends on
 *  its exact advance. Nothing in `brand-lockup.ts` comes from this face either — only
 *  the two `public/brand/dezabin-lockup*.svg` files do.
 *
 *  TWO FILES, PICKED BY SCRIPT, AND THEY ARE THE SITE'S OWN BINARIES. Noto Sans Hebrew
 *  ships subsetted per script, so the Hebrew slogan and MARKETPLACE come from
 *  different files; `assets/brand-fonts/NotoSansHebrew-Variable-{Hebrew,Latin}.ttf` are
 *  those exact woff2 files from `node_modules/@fontsource-variable/noto-sans-hebrew`,
 *  decompressed (opentype.js cannot read woff2). That is the point rather than a
 *  workaround: a poster outlined from a DIFFERENT binary than the browser paints is
 *  how a lockup drifts, and this one cannot. Re-decompress from the package if the
 *  dependency is ever bumped. */
const tagFace = {
  rtl: face('NotoSansHebrew-Variable-Hebrew.ttf'),
  ltr: face('NotoSansHebrew-Variable-Latin.ttf'),
};
const TAG_FACE_AT = { variation: { wght: TAGLINE_WEIGHT } };

/** A glyph's ink box, in font units, y measured UP from the baseline. */
function ink(font, ch, opts = {}) {
  const g = font.charToGlyph(ch);
  const b = g.getPath(0, 0, font.unitsPerEm, opts, font).getBoundingBox();
  // getPath renders y-down with the baseline at 0, so ink above the baseline is
  // negative. Flip it back, because every number in the brand notes is "above".
  return { adv: g.advanceWidth, x1: b.x1, x2: b.x2, top: -b.y1, bottom: b.y2 };
}

/**
 * Serialise a path ourselves rather than calling opentype's `toPathData`.
 *
 * NOT a preference. `toPathData(2)` emits the literal string `NaN` for some
 * coordinates — reproducibly, for the lamed's y in the Hebrew slogan — and an
 * SVG path containing NaN is invalid, so the renderer draws up to the error and
 * stops. That is what left the poster lockup showing one Hebrew letter out of
 * nineteen, and it is silent: the Path's own getBoundingBox is correct, so
 * nothing downstream notices. `tests/brand-lockup.test.ts` fails on any NaN in a
 * generated file so this cannot come back quietly.
 */
function toPath(path, dp = 2) {
  const f = (v) => {
    if (!Number.isFinite(v)) throw new Error(`path coordinate is not finite: ${v}`);
    return String(Math.round(v * 10 ** dp) / 10 ** dp);
  };
  return path.commands
    .map((c) => {
      if (c.type === 'M' || c.type === 'L') return `${c.type}${f(c.x)} ${f(c.y)}`;
      if (c.type === 'Q') return `Q${f(c.x1)} ${f(c.y1)} ${f(c.x)} ${f(c.y)}`;
      if (c.type === 'C') return `C${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)}`;
      if (c.type === 'Z') return 'Z';
      throw new Error(`unknown path command: ${c.type}`);
    })
    .join('');
}

/**
 * Lay a string out at the face's own spacing, kerning included, and return one
 * path plus its ink box and its final pen.
 *
 * `dir: 'rtl'` places the first logical character rightmost; Hebrew needs no
 * contextual shaping, so reversing the run is the whole of it.
 *
 * `tracking` is in em and is added after every glyph — the LAST one included,
 * which is what Blink does with `letter-spacing`. That matters only for the
 * Latin slogan, which is centred against a run measured the same way.
 */
function run(font, text, { size, x, y, tracking = 0, dir = 'ltr', opts = {} }) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(text);
  const order = dir === 'rtl' ? [...glyphs].reverse() : glyphs;
  const path = new opentype.Path();
  let pen = x;
  order.forEach((g, i) => {
    path.extend(g.getPath(pen, y, size, opts, font));
    const next = order[i + 1];
    pen += (g.advanceWidth + (next ? font.getKerningValue(g, next) : 0)) * scale + tracking * size;
  });
  return { path, box: path.getBoundingBox(), pen };
}

/* ------------------------------------------------------------- the numbers */

const UPEM = lf.unitsPerEm;

/** The lockup's own coordinate space: x = 0 at the D's left INK edge, y = 0 at
 *  the tallest ink in the word, and the baseline at y = H. The wordmark's box is
 *  cropped to the ink, so it has no side bearings of its own — every surface
 *  that positions it can trust its edges. */
const D = ink(lf, 'D');
const CAP = ink(lf, 'H').top;

/* The word, drawn from a pen that puts the D's ink at x = 0. */
const wordAll = run(lf, WORD, { size: UPEM, x: -D.x1, y: 0 });
const TOP = -wordAll.box.y1;                       // the tallest ink: the b's ascender
const H = TOP;                                     // baseline sits here
const INK_W = wordAll.box.x2 - wordAll.box.x1;

/* The two halves every consumer draws: the D on its own (the favicon, the menu
   row, a tile) and the rest of the word. Together they are exactly `wordAll` —
   the split exists because the D has to be drawable alone, not because the mark
   is a separate thing any more. */
const markPathRun = run(lf, 'D', { size: UPEM, x: -D.x1, y: H });
const MARK_PATH = toPath(markPathRun.path);
const MARK_W = markPathRun.box.x2 - markPathRun.box.x1;

/* Where "ezabin" starts: the D's own advance from the same pen, with the pair's
   kerning. Nothing is authored here — this is the face's spacing, which is the
   whole decision. */
const dGlyph = lf.charToGlyph('D');
const eGlyph = lf.charToGlyph('e');
const PEN = -D.x1 + dGlyph.advanceWidth + lf.getKerningValue(dGlyph, eGlyph);
const letters = run(lf, WORD.slice(1), { size: UPEM, x: PEN, y: H });
const LETTERS_PATH = toPath(letters.path);

/** Kept for the surfaces that draw a stroke attribute. There is no thickening
 *  any more, so it is zero: a zero-width stroke paints nothing, which lets every
 *  consumer keep the same markup. */
const STROKE = 0;

/** Path coordinates, in a 1000-unit em: two decimals is a hundredth of a unit,
 *  far past anything a raster can show. */
const r = (v) => Math.round(v * 100) / 100;
/** Ratios that get multiplied by a font-size before they reach a pixel. */
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/* Every box carries `BOX_MARGIN` of the wordmark's height on all four sides, so
   no ink is ever on a boundary. The margin is the SAME absolute number on both
   axes — a margin that differed by axis would be a shape, not a margin. */
const PAD = H * BOX_MARGIN;
const VIEW_BOX = `${r(-PAD)} ${r(-PAD)} ${r(INK_W + PAD * 2)} ${r(H + PAD * 2)}`;
const MARK_VIEW_BOX = `${r(-PAD)} ${r(H - CAP - PAD)} ${r(MARK_W + PAD * 2)} ${r(CAP + PAD * 2)}`;

/* ---------------------------------------------------- the tagline's numbers */

const TAG_SIZE_UNITS = TAGLINE_SIZE * CAP;

/** The D's slice of the ramp, for a mark shown on its own in brand colour: it
 *  covers the first N% of the lockup's width and takes exactly that slice, or it
 *  ends light where the wordmark's D ends dark. */
const lerp = (a, b, t) =>
  '#' +
  [0, 2, 4]
    .map((i) =>
      Math.round(
        parseInt(a.slice(1 + i, 3 + i), 16) +
          (parseInt(b.slice(1 + i, 3 + i), 16) - parseInt(a.slice(1 + i, 3 + i), 16)) * t,
      )
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const D_SLICE_END = lerp(BRAND_A, BRAND_B, MARK_W / INK_W);

/* --------------------------------------------------------------- the module */

const module_ = `/**
 * GENERATED by scripts/generate-wordmark.mjs — do not hand-edit.
 * Run \`npm run brand:wordmark\` after changing anything it treats as authored
 * (the tagline's size, gap and two trackings, and the favicon's box).
 *
 * The wordmark is "${WORD}" in Libre Franklin ExtraBold at the FACE'S OWN
 * SPACING — no drawn letter, no thickening, no tracking, no levelled gaps. The
 * generator's header says why each of those went, and why re-adding one would
 * bring back the fault it was blamed for.
 *
 * The letters are OUTLINES, not text: Libre Franklin is not shipped to the
 * browser at all, so the logo cannot render in a fallback face and costs no font
 * preload.
 *
 * Coordinates: 1000 units = 1em, x starts at the D's left ink edge, y starts at
 * the tallest ink in the word and the baseline is at y = ${r(H)}.
 */

/** The D on its own — the favicon, the account-menu row, a tile. It is the
 *  face's own letter; there is nothing drawn about it. */
export const MARK_PATH =
  '${MARK_PATH}';

/** "${WORD.slice(1)}", outlined, starting at the D's own advance. */
export const LETTERS_PATH =
  '${LETTERS_PATH}';

/** No thickening any more — Libre Franklin has a real ExtraBold. Zero, rather
 *  than removed, so every surface can keep drawing the same stroke attribute
 *  without a special case: a zero-width stroke paints nothing. */
export const STROKE_WIDTH = ${STROKE};

/** viewBox for the whole wordmark, tight to the ink. */
export const VIEW_BOX = '${VIEW_BOX}';

/** viewBox for the D on its own, tight to ITS ink — cap height, not the word's
 *  ascender, because a lone capital has no ascender above it to allow for. */
export const MARK_VIEW_BOX = '${MARK_VIEW_BOX}';

/** CSS height for the wordmark: everything else in the component is em, so this
 *  is the only size knob. It is the BOX, which carries a margin around the ink —
 *  see the generator's \`BOX_MARGIN\`. Sizing by it therefore keeps the INK at
 *  exactly \`INK_HEIGHT_EM\` for a given font-size; the margin grows outward. */
export const HEIGHT_EM = ${r5((H + PAD * 2) / UPEM)};

/** The wordmark's BOX width, in em of its own font-size — the margin included,
 *  so it is what the element measures on the page. */
export const WIDTH_EM = ${r5((INK_W + PAD * 2) / UPEM)};

/** The INK inside that box — what a reader actually sees, and the pair to reach
 *  for when something has to line up with the LETTERS rather than with the
 *  element. These were the same numbers as the box until the margin existed,
 *  which is precisely why they are named apart now. */
export const INK_WIDTH_EM = ${r5(INK_W / UPEM)};
export const INK_HEIGHT_EM = ${r5(H / UPEM)};

/** The brand ramp, as ONE gradient across the whole wordmark. It must be
 *  \`gradientUnits="userSpaceOnUse"\`: the default resolves per element, which
 *  gives every letter its own full ramp and reads as pieces stuck together. */
export const GRADIENT = { from: '${BRAND_A}', to: '${BRAND_B}', x1: 0, y1: 0, x2: ${r(INK_W)}, y2: ${r(H)} };

/** The second line, which is still live text in the interface face because it follows the
 *  visitor's language.
 *
 *  It is CENTRED under the wordmark now, not flush with it — so there is no
 *  margin to cancel a side bearing with any more, and no size solve either.
 *  \`sizeEm\` and \`gapEm\` are in the LOCKUP's em so the site header, the mail
 *  header and the poster files move together.
 *
 *  \`trackEm\` differs by language and that is the point: the Latin line is
 *  opened wide, which is the device; Hebrew takes a tenth of it, because opening
 *  Hebrew loosens the word instead of enlarging it. */
export const TAGLINE = {
  sizeEm: ${r5(TAG_SIZE_UNITS / UPEM)},
  gapEm: ${r5((TAGLINE_GAP * CAP) / UPEM)},
  weight: ${TAGLINE_WEIGHT},
  trackEm: { he: ${TAGLINE_TRACK_HE}, en: ${TAGLINE_TRACK_EN} },
  /** The smallest font-size the LOCKUP may be drawn at and still leave this line
   *  at ${TAGLINE_MIN_PX}px — derived from \`sizeEm\`, never typed. Any surface that
   *  draws the tagline reads this as its floor. */
  minLockupPx: ${Math.ceil((TAGLINE_MIN_PX / (TAG_SIZE_UNITS / UPEM)) * 10) / 10},
};
`;

mkdirSync(resolve(ROOT, 'src/lib'), { recursive: true });
writeFileSync(resolve(ROOT, 'src/lib/brand-lockup.ts'), module_);

/* ----------------------------------------------------------- the static SVGs */

const grad = (id, g) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}"><stop offset="0" stop-color="${g.from}"/><stop offset="1" stop-color="${g.to}"/></linearGradient>`;

/** One standalone file. `paint` is a colour or a url(#id). */
function svgFile({ viewBox, defs = '', paint, paths, extra = '', comment }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
  <!-- ${comment} -->${defs ? `\n  <defs>${defs}</defs>` : ''}
  <g fill="${paint}">
${paths.map((p) => `    <path d="${p}"/>`).join('\n')}
  </g>${extra}
</svg>
`;
}

const POSTER_NOTE =
  'Dezabin — standalone, self-contained: the letters are outlines, so this file needs no font, no CSS and no network. Generated by scripts/generate-wordmark.mjs; do not hand-edit.';

const OUT = resolve(ROOT, 'public/brand');
mkdirSync(OUT, { recursive: true });

const G = { from: BRAND_A, to: BRAND_B, x1: 0, y1: 0, x2: r(INK_W), y2: r(H) };
const MG = { from: BRAND_A, to: D_SLICE_END, x1: 0, y1: 0, x2: r(MARK_W), y2: r(H) };

const files = {
  'dezabin-wordmark.svg': svgFile({ viewBox: VIEW_BOX, defs: grad('g', G), paint: 'url(#g)', paths: [MARK_PATH, LETTERS_PATH], comment: POSTER_NOTE }),
  'dezabin-wordmark-dark.svg': svgFile({ viewBox: VIEW_BOX, paint: BRAND_A, paths: [MARK_PATH, LETTERS_PATH], comment: `${POSTER_NOTE} Solid brand colour, for one-colour print.` }),
  'dezabin-wordmark-white.svg': svgFile({ viewBox: VIEW_BOX, paint: '#ffffff', paths: [MARK_PATH, LETTERS_PATH], comment: `${POSTER_NOTE} White, for a brand-coloured or photographic ground.` }),
  'dezabin-mark.svg': svgFile({ viewBox: MARK_VIEW_BOX, defs: grad('g', MG), paint: 'url(#g)', paths: [MARK_PATH], comment: `${POSTER_NOTE} The D alone, carrying its own slice of the wordmark's ramp.` }),
  'dezabin-mark-white.svg': svgFile({ viewBox: MARK_VIEW_BOX, paint: '#ffffff', paths: [MARK_PATH], comment: `${POSTER_NOTE} The D alone, white.` }),
};

/**
 * The lockups: wordmark plus a second line, outlined too, because a poster file
 * has to stand on its own. One per language — the English file carries
 * MARKETPLACE, the Hebrew one the Hebrew slogan (owner, 2026-08-21) — and both
 * are CENTRED on the wordmark, which is the whole device.
 *
 * The centring is done on the INK, not on the advance: with tracking applied
 * after the last glyph as well, an advance-centred line sits half a space to one
 * side, which is exactly the "MARKETPLACE isn't centred" the owner spotted.
 */
function lockupFile({ text, dir, tracking, paint, defs }) {
  const f = tagFace[dir];
  const first = run(f, text, { size: TAG_SIZE_UNITS, x: 0, y: 0, tracking, dir, opts: TAG_FACE_AT });
  const shift = (INK_W - (first.box.x2 - first.box.x1)) / 2 - first.box.x1;
  const lift = H + TAGLINE_GAP * CAP - first.box.y1;
  const placed = run(f, text, { size: TAG_SIZE_UNITS, x: shift, y: lift, tracking, dir, opts: TAG_FACE_AT });
  const height = placed.box.y2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(-PAD)} ${r(-PAD)} ${r(INK_W + PAD * 2)} ${r(height + PAD * 2)}">
  <!-- ${POSTER_NOTE} The full lockup: wordmark plus slogan, both outlined. -->${defs ? `\n  <defs>${defs}</defs>` : ''}
  <g fill="${paint}">
    <path d="${MARK_PATH}"/>
    <path d="${LETTERS_PATH}"/>
    <path d="${toPath(placed.path)}"/>
  </g>
</svg>
`;
}

files['dezabin-lockup.svg'] = lockupFile({ text: SLOGAN_HE, dir: 'rtl', tracking: TAGLINE_TRACK_HE, paint: 'url(#g)', defs: grad('g', G) });
files['dezabin-lockup-white.svg'] = lockupFile({ text: SLOGAN_HE, dir: 'rtl', tracking: TAGLINE_TRACK_HE, paint: '#ffffff', defs: '' });
files['dezabin-lockup-en.svg'] = lockupFile({ text: SLOGAN_EN, dir: 'ltr', tracking: TAGLINE_TRACK_EN, paint: 'url(#g)', defs: grad('g', G) });
files['dezabin-lockup-en-white.svg'] = lockupFile({ text: SLOGAN_EN, dir: 'ltr', tracking: TAGLINE_TRACK_EN, paint: '#ffffff', defs: '' });

for (const [name, body] of Object.entries(files)) writeFileSync(resolve(OUT, name), body);

/* The favicon is the D on a flat fill that follows the tab strip's theme — a
   dark ink on a dark tab strip is an invisible favicon, which is the one thing a
   favicon may not be.

   A SQUARE box, ink-centred, with the ink filling FAVICON_INK of its height —
   see that constant for why the tab is the one surface that gets padding.
   Square because the slot is: a taller-than-wide box is letterboxed into it
   anyway, so stating the square is the same drawing with the margins written
   down. */
const FAV_SIDE = CAP / FAVICON_INK;
const FAV_VB = [
  r(MARK_W / 2 - FAV_SIDE / 2),
  r(H - CAP / 2 - FAV_SIDE / 2),
  r(FAV_SIDE),
  r(FAV_SIDE),
].join(' ');

writeFileSync(
  resolve(ROOT, 'public/favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${FAV_VB}">
  <!-- The bare D — no tile. GENERATED by scripts/generate-wordmark.mjs from the
       same path the component and the menu row draw, so the tab, the menu and
       the header are one drawing and cannot drift apart. The box is the letter's
       own ink plus a margin: square, centred, the ink ${(FAVICON_INK * 100).toFixed(1)}% of the height.
       A tab strip gives an icon no air of its own, and edge to edge the D read
       as a slab rather than as a letter. It is the BOX that carries that, and
       nothing else — same path, same stem as every other surface.

       The fill follows the browser's theme rather than being fixed: SVG favicons
       honour prefers-color-scheme in Firefox and Chromium, and a browser that
       ignores it falls back to the brand colour, which is correct on every light
       tab strip. -->
  <style>
    path { fill: ${BRAND_A}; }
    @media (prefers-color-scheme: dark) { path { fill: #ffffff; } }
  </style>
  <path d="${MARK_PATH}"/>
</svg>
`,
);

console.log(`brand lockup regenerated — Libre Franklin ExtraBold, the face's own spacing
  cap height    ${r(CAP)}u = ${r5(CAP / UPEM)}em
  word height   ${r(H)}u = ${r5(H / UPEM)}em  (the b's ascender)
  D width       ${r(MARK_W)}u = ${r5(MARK_W / UPEM)}em
  pen for "e"   ${r(PEN)}u
  wordmark ink  ${r5(INK_W / UPEM)}em wide, box ${r5((INK_W + PAD * 2) / UPEM)}em (margin ${BOX_MARGIN} of the height)
  tagline       ${r5(TAG_SIZE_UNITS / UPEM)}em, gap ${r5((TAGLINE_GAP * CAP) / UPEM)}em, Noto Sans Hebrew ${TAGLINE_WEIGHT}, tracking he ${TAGLINE_TRACK_HE} / en ${TAGLINE_TRACK_EN}
  files         src/lib/brand-lockup.ts, public/favicon.svg, public/brand/*.svg`);
