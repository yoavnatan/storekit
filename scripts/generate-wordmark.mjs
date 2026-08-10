/**
 * Builds the brand lockup — `npm run brand:wordmark`.
 *
 * WHY THE LETTERS ARE OUTLINES AND NOT TEXT (2026-08-10).
 * The wordmark is Chakra Petch 700 thickened by 0.014em, and a thickening is an
 * outline: the family stops at 700 and has no variable axis, so there is no
 * heavier cut to switch to. CSS cannot paint `-webkit-text-stroke` with a
 * gradient — the outline would have to be a flat colour and would halo against
 * the ramp — so the wordmark has to be SVG, and once it is SVG the letters may
 * as well be paths. That buys three things, and the third is the one that
 * matters most here:
 *   • Chakra Petch never ships. It is not used anywhere else on the site, so
 *     outlining it means no eleventh font preload on every page.
 *   • The logo cannot render in the wrong face. Every face in main.css is
 *     `font-display: optional`, which means a face not already available at
 *     first paint is not used AT ALL for that page view — the trap that made
 *     two successive alignment "fixes" measure 24px wrong in August. A path has
 *     no such state.
 *   • The site's logo and the poster file become the same drawing.
 *
 * WHY opentype.js IS A DEPENDENCY AT ALL. `generate-brand-assets.mjs` argues
 * against "a font rasteriser in the app's own dependencies", and that argument
 * still holds — this is a devDependency for a generator run BY HAND, whose
 * output is committed, and nothing at runtime imports it. It is the same shape
 * as Playwright next door. The alternative was pasting path data nobody could
 * regenerate.
 *
 * WHAT IS AUTHORED AND WHAT IS DERIVED. The only authored things are the D's
 * identity (half a regular octagon, cut = H/(2+√2)), the two optical ratios,
 * the tracking and the thickening. Everything else — the mark's height, width
 * and stem, the gap to the `e`, the tagline's size and margin — is read off the
 * font. That is the rule the previous wordmark was built under and it is why a
 * weight change was never one line.
 *
 * OUTPUT. One module, `src/lib/brand-lockup.ts`, plus the static SVGs. Every
 * surface reads the module, so the old "four surfaces must stay byte-identical"
 * problem is now one file; `tests/brand-lockup.test.ts` holds the static files
 * to it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';

const ROOT = resolve(import.meta.dirname, '..');
const FONTS = resolve(ROOT, 'assets/brand-fonts');

/* ---------------------------------------------------------------- authored */

/** The wordmark's tracking. Negative is the point: heavy weight plus negative
 *  tracking is what closes the seven letters into ONE SOLID SHAPE, and that
 *  shape is the logo (owner, 2026-08-05 and again 2026-08-10). */
const TRACKING = -0.04;

/** The thickening, in em. Chakra Petch has 300–700 and no variable axis, so
 *  "800" does not exist; this is the standard substitute — a centred outline on
 *  the letters AND on the mark, which grows every edge by this much and eats the
 *  counters by the same amount. 0.014 takes the stem from 0.137em to 0.151em,
 *  between Chakra Petch's own 700 and Heebo 800's 0.167em (owner, 2026-08-10). */
const THICKEN = 0.014;

/** Half a REGULAR octagon — the mark's identity, tied to its HEIGHT so the
 *  silhouette stays regular whatever font the letters are. Deepening it turns
 *  the counter into a wedge and the mark reads as a ▶; that was measured at
 *  8.2 / 9.5 / 10.7 / 12 units in August and fails from about 10 on. */
const CUT_RATIO = 1 / (2 + Math.SQRT2);

/** A horizontal looks heavier than it measures and a diagonal looks lighter.
 *  These correct for the eye, not for a weight, so they are CARRIED OVER from
 *  the original drawing rather than re-derived per font. */
const H_RATIO = 0.799;
const D_RATIO = 0.9037;

/** The site's brand gradient — the one `.btn` wears, unchanged. */
const BRAND_A = '#2a3c40';
const BRAND_B = '#3a5260';

/**
 * The tagline's margin, corrected against the BUILT site — in the tagline's own
 * em, added to the bearing derived below. Arithmetic is only the starting point
 * here and always has been: the previous lockup's shipped tagline size was
 * 0.3886 where the calculation said 0.3882.
 *
 * Two things the font metrics cannot know, and they pull in the same direction:
 *   • The stroke's MITER JOINS reach past half a stroke width at every corner
 *     sharper than 180° — up to √2 × half at a right angle — so the wordmark's
 *     ink overflows its own viewBox by a fraction of a pixel on the right.
 *   • The browser's rendered right inset on the Hebrew run measures smaller than
 *     Heebo's own right side bearing for the מ (0.56px against 1.40px at hero
 *     size), which no table predicts.
 * Together they left the Hebrew half a pixel outside the wordmark on every
 * desktop viewport. Measured with scratch measurement over 7 viewports × DPR
 * 1/2/3 on `npm start`, not on the dev server, and not by eye.
 *
 * RE-MEASURE THIS if the thickening, the tracking or the slogan changes. It is
 * the one number here that a font cannot give you.
 */
const TAGLINE_MARGIN_BISECTION = 0.02571;

/**
 * And the same for its SIZE, added to the ratio derived below. The arithmetic
 * ratio put the Hebrew one CSS pixel wide at every desktop viewport: the two
 * faces' ADVANCE widths agree with the browser exactly (8.57912em, checked), so
 * this is the ink sitting differently inside those advances once rasterised —
 * not a layout mistake, and not something either font's tables predict.
 *
 * Measured on the built site, one raster of the whole lockup split into its two
 * bands. Do NOT measure the two elements separately: each one then quantises
 * against its own fractionally-positioned box and reports a whole pixel of
 * disagreement that no visitor can see.
 */
const TAGLINE_SIZE_BISECTION = -0.00244;

/** The slogan the poster lockup carries. The site's own line is live text in
 *  BrandLogo.astro, because it follows the visitor's language; this is the
 *  Hebrew one, outlined, for a file that has to stand alone. */
const SLOGAN = 'מתחם חנויות דיגיטלי';

/* -------------------------------------------------------------- the faces */

const face = (file) => opentype.parse(readFileSync(resolve(FONTS, file)).buffer);
const cp = face('ChakraPetch-Bold.ttf');
const heebo = face('Heebo-Medium.ttf');

/** A glyph's ink box, in font units, y measured UP from the baseline. */
function ink(font, ch) {
  const g = font.charToGlyph(ch);
  const b = g.getPath(0, 0, font.unitsPerEm).getBoundingBox();
  // getPath renders y-down with the baseline at 0, so ink above the baseline is
  // negative. Flip it back, because every number in the brand notes is "above".
  return { adv: g.advanceWidth, x1: b.x1, x2: b.x2, top: -b.y1, bottom: b.y2 };
}

/**
 * The straight back's thickness, read off the outline rather than off a metrics
 * table: flatten the contours to segments, cut them with a horizontal line at
 * half the ink height, and take the first run of ink. A row-scan is the right
 * instrument for a stem (a metrics table has no such number), and the first run
 * is the back — the same rule the pixel-scan version used.
 */
function stemOf(font, ch) {
  const g = font.charToGlyph(ch);
  const path = g.getPath(0, 0, font.unitsPerEm);
  const box = path.getBoundingBox();
  const y = (box.y1 + box.y2) / 2;

  const segs = [];
  let sx = 0, sy = 0, cx = 0, cy = 0;
  const line = (x1, y1, x2, y2) => segs.push([x1, y1, x2, y2]);
  const flatten = (x0, y0, cmd) => {
    // 24 steps is far past what a stem measurement can notice, and it costs
    // nothing here — this runs once, by hand.
    const N = 24;
    let px = x0, py = y0;
    for (let i = 1; i <= N; i++) {
      const t = i / N,
        u = 1 - t;
      let qx, qy;
      if (cmd.type === 'Q') {
        qx = u * u * x0 + 2 * u * t * cmd.x1 + t * t * cmd.x;
        qy = u * u * y0 + 2 * u * t * cmd.y1 + t * t * cmd.y;
      } else {
        qx = u ** 3 * x0 + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t ** 3 * cmd.x;
        qy = u ** 3 * y0 + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t ** 3 * cmd.y;
      }
      line(px, py, qx, qy);
      px = qx;
      py = qy;
    }
  };
  for (const c of path.commands) {
    if (c.type === 'M') { sx = cx = c.x; sy = cy = c.y; }
    else if (c.type === 'L') { line(cx, cy, c.x, c.y); cx = c.x; cy = c.y; }
    else if (c.type === 'Q' || c.type === 'C') { flatten(cx, cy, c); cx = c.x; cy = c.y; }
    else if (c.type === 'Z') { line(cx, cy, sx, sy); cx = sx; cy = sy; }
  }

  const xs = [];
  for (const [x1, y1, x2, y2] of segs) {
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
  }
  xs.sort((a, b) => a - b);
  if (xs.length < 2) throw new Error(`stemOf(${ch}): the scanline found no ink`);
  return xs[1] - xs[0]; // the first run — the straight back
}

/**
 * Serialise a path ourselves rather than calling opentype's `toPathData`.
 *
 * NOT a preference. `toPathData(2)` emits the literal string `NaN` for some
 * coordinates — reproducibly, for the lamed's y in this slogan — and an SVG path
 * containing NaN is invalid, so the renderer draws up to the error and stops.
 * That is what left the poster lockup showing one Hebrew letter out of
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

/** Lay a string out with kerning and tracking, and return one path plus its ink
 *  box. `dir: 'rtl'` places the first logical character rightmost; Hebrew needs
 *  no contextual shaping, so reversing the run is the whole of it. */
function run(font, text, { size, x, y, tracking = 0, dir = 'ltr' }) {
  const upem = font.unitsPerEm;
  const scale = size / upem;
  const glyphs = font.stringToGlyphs(text);
  const order = dir === 'rtl' ? [...glyphs].reverse() : glyphs;
  const path = new opentype.Path();
  let pen = x;
  order.forEach((g, i) => {
    path.extend(g.getPath(pen, y, size));
    const next = order[i + 1];
    const kern = next ? font.getKerningValue(g, next) : 0;
    pen += (g.advanceWidth + kern) * scale + tracking * size;
  });
  return { path, advanceEnd: pen, box: path.getBoundingBox() };
}

/** Ink width of a string at 1em, for the ratios below. */
const inkWidthEm = (font, text, dir) => {
  const r = run(font, text, { size: 1000, x: 0, y: 0, dir });
  return (r.box.x2 - r.box.x1) / 1000;
};

/* ------------------------------------------------------------- the numbers */

const UPEM = cp.unitsPerEm;
const B = ink(cp, 'b');
const D = ink(cp, 'D');

/** The mark stands to the ASCENDER, not to the cap line — a deliberate logotype
 *  override, made with the rule in hand (owner, 2026-08-05). Aligning a drawn
 *  symbol to the tallest thing in the word is ordinary practice; the rule it
 *  breaks is a rule about running text. In Chakra Petch the two are only 0.013em
 *  apart (cap 0.700em, ascender 0.713em), so this costs far less than it did in
 *  Heebo — but it stays, because it is the same mark. */
const H = B.top;                         // the mark's height, in font units
const W = D.x2 - D.x1;                   // the font's own D width — unchanged
const STEM = stemOf(cp, 'D');
const D_LSB = D.x1;
const D_RSB = D.adv - D.x2;

const CUT = H * CUT_RATIO;
const TV = STEM;
const TH = TV * H_RATIO;
const TD = TV * D_RATIO;

/** Path coordinates, in a 1000-unit em: three decimals is a thousandth of a
 *  unit, far past anything a raster can show. */
const r = (v) => Math.round(v * 1000) / 1000;
/** Ratios that get multiplied by a font-size before they reach a pixel, so they
 *  need the precision the old lockup was bisected at — 0.0004em is one pixel of
 *  movement at hero size. */
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/* The mark: x from 0, y from 0 (ink top) down to H (the baseline). */
const outer = `M0 0 L${r(W - CUT)} 0 L${r(W)} ${r(CUT)} L${r(W)} ${r(H - CUT)} L${r(W - CUT)} ${r(H)} L0 ${r(H)} Z`;
const iL = TV, iR = W - TV, iT = TH, iB = H - TH;
const kTop = W - CUT - TD * Math.SQRT2;         // inner top diagonal:    x - y = kTop
const kBot = W - CUT + H - TD * Math.SQRT2;     // inner bottom diagonal: x + y = kBot
const inner = `M${r(iL)} ${r(iT)} L${r(iT + kTop)} ${r(iT)} L${r(iR)} ${r(iR - kTop)} L${r(iR)} ${r(kBot - iR)} L${r(kBot - iB)} ${r(iB)} L${r(iL)} ${r(iB)} Z`;
const MARK_PATH = `${outer} ${inner}`;

/**
 * Where "ezabin" starts. The mark is spaced as a LETTER, not as a symbol: if it
 * were the real glyph its ink would sit D_LSB past the pen, so the pen that drew
 * it was at -D_LSB, and the next pen is that plus the D's advance plus the
 * tracking every other pair in the word gets. A mark spaced like a symbol is
 * what made early versions read as an icon glued next to a word.
 */
const PEN = -D_LSB + D.adv + TRACKING * UPEM;
const letters = run(cp, 'ezabin', { size: UPEM, x: PEN, y: H, tracking: TRACKING });
const LETTERS_PATH = toPath(letters.path);

const STROKE = THICKEN * UPEM;
const INK_W = letters.box.x2 - 0;                 // the mark starts at x = 0
const VB = (w, h) => `${r(-STROKE / 2)} ${r(-STROKE / 2)} ${r(w + STROKE)} ${r(h + STROKE)}`;

/* The tagline is still live text on the site (it follows the visitor's
   language), so what the module carries is the ratio, not a path. The svg's box
   is tight to the stroked ink, so the wordmark has no side bearing of its own
   and the margin is simply Heebo's — cancelling the bearing is the whole job. */
const SLOGAN_INK = inkWidthEm(heebo, SLOGAN, 'rtl');
const MEM = ink(heebo, 'מ');
const HEEBO_RSB = (MEM.adv - MEM.x2) / heebo.unitsPerEm;
const TAG_SIZE = (INK_W + STROKE) / UPEM / SLOGAN_INK + TAGLINE_SIZE_BISECTION;

/** The D's slice of the ramp, for a mark shown on its own in brand colour: it
 *  covers the first N% of the lockup's width and takes exactly that slice, or it
 *  ends light where the wordmark's D ends dark. */
const lerp = (a, b, t) =>
  '#' +
  [0, 2, 4]
    .map((i) => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) + (parseInt(b.slice(1 + i, 3 + i), 16) - parseInt(a.slice(1 + i, 3 + i), 16)) * t)
      .toString(16)
      .padStart(2, '0'))
    .join('');
const D_SLICE_END = lerp(BRAND_A, BRAND_B, W / INK_W);

/* --------------------------------------------------------------- the module */

const module_ = `/**
 * GENERATED by scripts/generate-wordmark.mjs — do not hand-edit.
 * Run \`npm run brand:wordmark\` after changing anything it treats as authored
 * (the tracking, the thickening, the octagon's cut, the two optical ratios).
 *
 * The wordmark is OUTLINES, not text: Chakra Petch is not shipped to the browser
 * at all, so the logo cannot render in a fallback face and costs no font preload.
 * The generator's header explains why in full.
 *
 * Coordinates: 1000 units = 1em, x starts at the mark's left ink edge, y starts
 * at the ascender and the baseline is at y = ${r(H)}.
 */

/** The drawn D — half a regular octagon, rebuilt against Chakra Petch 700. */
export const MARK_PATH =
  '${MARK_PATH}';

/** "ezabin", outlined at ${TRACKING}em tracking. */
export const LETTERS_PATH =
  '${LETTERS_PATH}';

/** The thickening, as a centred stroke in the coordinates above. Draw it with
 *  \`paint-order="stroke"\` and the SAME paint as the fill, on both the mark and
 *  the letters, or the two stop matching. */
export const STROKE_WIDTH = ${r(STROKE)};

/** viewBox for the whole wordmark, tight to the stroked ink. */
export const VIEW_BOX = '${VB(INK_W, H)}';

/** viewBox for the mark on its own — the favicon, the menu row, a tile. */
export const MARK_VIEW_BOX = '${VB(W, H)}';

/** CSS height for the wordmark: everything else in the component is em, so this
 *  is the only size knob. It is the ascender plus the stroke. */
export const HEIGHT_EM = ${r5((H + STROKE) / UPEM)};

/** The lockup's ink width, in em of the wordmark's own font-size. */
export const INK_WIDTH_EM = ${r5((INK_W + STROKE) / UPEM)};

/** The brand ramp, as ONE gradient across the whole wordmark. It must be
 *  \`gradientUnits="userSpaceOnUse"\`: the default resolves per element, which
 *  gives every letter its own full ramp and reads as pieces stuck together. */
export const GRADIENT = { from: '${BRAND_A}', to: '${BRAND_B}', x1: 0, y1: 0, x2: ${r(INK_W)}, y2: ${r(H)} };

/** The D covers the first ${(100 * W / INK_W).toFixed(1)}% of the lockup, so a mark shown alone in brand
 *  colour takes exactly that slice of the ramp. */
export const MARK_GRADIENT = { from: '${BRAND_A}', to: '${D_SLICE_END}' };

/** The Hebrew line under the mark, which is still live Heebo text because it
 *  follows the visitor's language. \`sizeEm\` matches its ink width to the
 *  wordmark's; \`marginEm\` (in the tagline's OWN em) cancels Heebo's side
 *  bearing to the right of the מ, because a line box is not its ink and aligning
 *  the boxes parks the Hebrew a visible pixel inside the English.
 *  Both are re-solved by the generator whenever the wordmark moves — and
 *  \`sizeEm\` then carries a bisection against the built site, see the test. */
export const TAGLINE = { sizeEm: ${r5(TAG_SIZE)}, marginEm: ${r5(-HEEBO_RSB + TAGLINE_MARGIN_BISECTION)} };
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
  <g fill="${paint}" stroke="${paint}" stroke-width="${r(STROKE)}" stroke-linejoin="miter" paint-order="stroke">
${paths.map((p) => `    <path fill-rule="evenodd" d="${p}"/>`).join('\n')}
  </g>${extra}
</svg>
`;
}

const POSTER_NOTE =
  'Dezabin — standalone, self-contained: the letters are outlines, so this file needs no font, no CSS and no network. Generated by scripts/generate-wordmark.mjs; do not hand-edit.';

const OUT = resolve(ROOT, 'public/brand');
mkdirSync(OUT, { recursive: true });

const G = { ...{ from: BRAND_A, to: BRAND_B }, x1: 0, y1: 0, x2: r(INK_W), y2: r(H) };
const MG = { from: BRAND_A, to: D_SLICE_END, x1: 0, y1: 0, x2: r(W), y2: r(H) };

const files = {
  'dezabin-wordmark.svg': svgFile({ viewBox: VB(INK_W, H), defs: grad('g', G), paint: 'url(#g)', paths: [MARK_PATH, LETTERS_PATH], comment: POSTER_NOTE }),
  'dezabin-wordmark-dark.svg': svgFile({ viewBox: VB(INK_W, H), paint: BRAND_A, paths: [MARK_PATH, LETTERS_PATH], comment: `${POSTER_NOTE} Solid brand colour, for one-colour print.` }),
  'dezabin-wordmark-white.svg': svgFile({ viewBox: VB(INK_W, H), paint: '#ffffff', paths: [MARK_PATH, LETTERS_PATH], comment: `${POSTER_NOTE} White, for a brand-coloured or photographic ground.` }),
  'dezabin-mark.svg': svgFile({ viewBox: VB(W, H), defs: grad('g', MG), paint: 'url(#g)', paths: [MARK_PATH], comment: `${POSTER_NOTE} The mark alone, carrying its own slice of the wordmark's ramp.` }),
  'dezabin-mark-white.svg': svgFile({ viewBox: VB(W, H), paint: '#ffffff', paths: [MARK_PATH], comment: `${POSTER_NOTE} The mark alone, white.` }),
};

/* The lockup: wordmark plus the Hebrew line, outlined too, because a poster file
   has to stand on its own. Its size and position are the same solve the site
   uses — the ink widths match and the bearing is cancelled. */
const TAG_SIZE_UNITS = TAG_SIZE * UPEM;
const tagRun = run(heebo, SLOGAN, { size: TAG_SIZE_UNITS, x: 0, y: 0, dir: 'rtl' });
const GAP = 0.05 * UPEM; // the component's own gap-[0.05em] between the two lines
const tagShift = INK_W + STROKE / 2 - tagRun.box.x2;      // right edges flush, ink to ink
const tagLift = H + STROKE / 2 + GAP - tagRun.box.y1;
const tagPath = run(heebo, SLOGAN, { size: TAG_SIZE_UNITS, x: tagShift, y: tagLift, dir: 'rtl' });
const lockupH = tagPath.box.y2 + STROKE / 2;
const lockupVB = `${r(-STROKE / 2)} ${r(-STROKE / 2)} ${r(INK_W + STROKE)} ${r(lockupH + STROKE / 2)}`;

for (const [name, paint, defs] of [
  ['dezabin-lockup.svg', 'url(#g)', grad('g', G)],
  ['dezabin-lockup-white.svg', '#ffffff', ''],
]) {
  files[name] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${lockupVB}">
  <!-- ${POSTER_NOTE} The full lockup: wordmark plus slogan, both outlined. -->${defs ? `\n  <defs>${defs}</defs>` : ''}
  <g fill="${paint}" stroke="${paint}" stroke-width="${r(STROKE)}" stroke-linejoin="miter" paint-order="stroke">
    <path fill-rule="evenodd" d="${MARK_PATH}"/>
    <path fill-rule="evenodd" d="${LETTERS_PATH}"/>
  </g>
  <path fill="${paint}" d="${toPath(tagPath.path)}"/>
</svg>
`;
}

for (const [name, body] of Object.entries(files)) writeFileSync(resolve(OUT, name), body);

/* The favicon is the mark on a flat fill that follows the tab strip's theme — a
   dark ink on a dark tab strip is an invisible favicon, which is the one thing a
   favicon may not be. Its own file rather than a poster variant, because it
   carries that <style> and nothing else does. */
writeFileSync(
  resolve(ROOT, 'public/favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB(W, H)}">
  <!-- The bare D — no tile. GENERATED by scripts/generate-wordmark.mjs from the
       same path the component and the menu row draw, so the tab, the menu and
       the header are one drawing and cannot drift apart. The viewBox is cropped
       to the letter's own ink, so at 16px the browser spends every pixel it has
       on the letter rather than on a plate around it.

       The fill follows the browser's theme rather than being fixed: SVG favicons
       honour prefers-color-scheme in Firefox and Chromium, and a browser that
       ignores it falls back to the brand colour, which is correct on every light
       tab strip. -->
  <style>
    g { fill: ${BRAND_A}; stroke: ${BRAND_A}; }
    @media (prefers-color-scheme: dark) { g { fill: #ffffff; stroke: #ffffff; } }
  </style>
  <g stroke-width="${r(STROKE)}" stroke-linejoin="miter" paint-order="stroke">
    <path fill-rule="evenodd" d="${MARK_PATH}"/>
  </g>
</svg>
`,
);

console.log(`brand lockup regenerated
  ascender      ${r(H)}u = ${r(H / UPEM * 1000) / 1000}em
  D width       ${r(W)}u = ${r(W / UPEM * 1000) / 1000}em
  stem          ${r(TV)}u = ${r(TV / UPEM * 1000) / 1000}em  (+ ${THICKEN} stroke → ${r((TV + STROKE) / UPEM * 1000) / 1000}em)
  octagon cut   ${r(CUT)}u = ${(100 * CUT_RATIO).toFixed(1)}% of the height
  pen for "e"   ${r(PEN)}u
  lockup ink    ${r((INK_W + STROKE) / UPEM * 1000) / 1000}em
  tagline       ${r5(TAG_SIZE)}em (derived ${r5(TAG_SIZE - TAGLINE_SIZE_BISECTION)} + bisection ${TAGLINE_SIZE_BISECTION}), margin ${r5(-HEEBO_RSB + TAGLINE_MARGIN_BISECTION)}em  (derived ${r5(-HEEBO_RSB)} + bisection ${TAGLINE_MARGIN_BISECTION})
  files         src/lib/brand-lockup.ts, public/favicon.svg, public/brand/*.svg`);
