import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MARK_PATH,
  LETTERS_PATH,
  STROKE_WIDTH,
  VIEW_BOX,
  MARK_VIEW_BOX,
  HEIGHT_EM,
  WIDTH_EM,
  INK_WIDTH_EM,
  INK_HEIGHT_EM,
  GRADIENT,
  TAGLINE,
} from '../src/lib/brand-lockup.js';
import { translations } from '../src/i18n/translations.js';

/**
 * The brand lockup has SIX surfaces — the component, the account menu's home row, the favicon,
 * the poster SVGs, the rasters `npm run brand:assets` writes, and the email header those feed.
 * Until 2026-08-10 three of them carried the D's path as a literal string and asserted in their
 * own comments that the three copies were byte-identical, which nothing checked. They now all
 * read `src/lib/brand-lockup.ts`, and this file is what holds them there.
 *
 * It also pins failures that already happened, because all of them were SILENT:
 *
 *   • `NaN` IN A PATH. opentype's `toPathData` emits the literal string `NaN` for some
 *     coordinates — reproducibly, for the lamed in the slogan. An SVG path containing NaN is
 *     invalid, so a renderer draws up to the error and stops: the poster lockup shipped showing
 *     one Hebrew letter out of nineteen. Nothing upstream notices, because the Path object's own
 *     bounding box is computed from the commands and is perfectly correct.
 *
 *   • A LITERAL PATH LEFT IN A COMPONENT. That is how the three copies existed in the first
 *     place, and a fourth would drift the same way.
 *
 *   • LEVELLED GAPS UNDER NO THICKENING (2026-08-21). Levelling every ink gap to their mean was
 *     right while the letters carried a stroke that ate a flat number of units out of each; with
 *     the stroke gone it opens the tight pairs the face closed on purpose, and the `z` then floats
 *     with its diagonal reading as a slab. The owner saw it in every face at once, which is what
 *     identified it as the code. `keeps the face's own spacing` below is that fix, pinned.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const GENERATED = [
  'public/favicon.svg',
  'public/brand/dezabin-wordmark.svg',
  'public/brand/dezabin-wordmark-dark.svg',
  'public/brand/dezabin-wordmark-white.svg',
  'public/brand/dezabin-mark.svg',
  'public/brand/dezabin-mark-white.svg',
  'public/brand/dezabin-lockup.svg',
  'public/brand/dezabin-lockup-white.svg',
  'public/brand/dezabin-lockup-en.svg',
  'public/brand/dezabin-lockup-en-white.svg',
];

describe('the lockup is one drawing', () => {
  it('gives every generated file the module’s own mark path', () => {
    for (const file of GENERATED) expect(read(file), file).toContain(MARK_PATH);
  });

  it('gives every wordmark and lockup file the module’s own letters', () => {
    for (const file of GENERATED.filter((f) => /wordmark|lockup/.test(f)))
      expect(read(file), file).toContain(LETTERS_PATH);
  });

  it('leaves no literal brand path in a component to drift from it', () => {
    // A path long enough to be a letterform, sitting in source that should have
    // imported one. Anything shorter is an icon and none of this file's business.
    const suspects = ['src/components/BrandLogo.astro', 'src/components/Header.astro'];
    for (const file of suspects) {
      const src = read(file);
      for (const m of src.matchAll(/d="([^"]{200,})"/g)) {
        expect(src.includes('brand-lockup'), `${file} carries a literal path`).toBe(true);
        expect([MARK_PATH, LETTERS_PATH], file).toContain(m[1]);
      }
    }
  });
});

describe('nothing generated carries an unrenderable coordinate', () => {
  it('has no NaN, Infinity or undefined in any generated file', () => {
    for (const file of [...GENERATED, 'src/lib/brand-lockup.ts'])
      expect(read(file), file).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('parses every number in both paths as finite', () => {
    for (const [name, d] of [
      ['MARK_PATH', MARK_PATH],
      ['LETTERS_PATH', LETTERS_PATH],
    ] as const)
      for (const n of d.match(/-?\d+(\.\d+)?/g) ?? [])
        expect(Number.isFinite(Number(n)), `${name}: ${n}`).toBe(true);
  });
});

describe('the mark is the typeface, not a drawing', () => {
  /**
   * The D was half a regular octagon until 2026-08-21 — a straight back and three
   * 45° cuts — and that was the whole of what read as square. It is the face's own
   * letter now. The distinction is testable rather than stylistic: a polygon has
   * only M/L/Z commands, and a drawn letterform has curves.
   */
  it('draws the D with curves, which a hand-cut octagon never had', () => {
    expect(MARK_PATH).toMatch(/[QC]/);
  });

  it('carries no thickening, because the face has a real ExtraBold', () => {
    // Chakra Petch stopped at 700 with no variable axis, so a centred stroke was
    // the substitute for a weight that did not exist. Zero rather than removed:
    // a zero-width stroke paints nothing, so the surfaces that still write the
    // attribute need no special case.
    expect(STROKE_WIDTH).toBe(0);
  });

  it('starts the INK at the origin, with the box’s margin outside it', () => {
    const [x] = VIEW_BOX.split(' ').map(Number);
    expect(x).toBeLessThan(0); // the margin — see "keeps a margin" below
    // The leftmost point, not the first command: a glyph's contour starts
    // wherever the outline does, which for this D is a third of the way in.
    const xs = [...MARK_PATH.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeCloseTo(0, 1); // the D's own left bearing is cancelled
  });
});

describe('the boxes are cropped to the ink', () => {
  const box = (vb: string) => vb.split(' ').map(Number);

  it('keeps a margin around the ink, so no letter sits on a boundary', () => {
    /**
     * THE FIX FOR "the logo is cut along its whole bottom" (owner, 2026-08-21).
     *
     * The wordmark's baseline is one flat line shared by all seven letters. Crop
     * the box to the ink and that line IS the box's edge — so any ancestor with
     * `overflow: hidden` takes a slice off the bottom of the whole word at once.
     * The one that did it was a truncation boundary written for a long store
     * NAME, in a stylesheet that says nothing about the logo. That rule is fixed,
     * but the rule only covers the ancestor we know about; the margin covers
     * every future one — a store header, a card, a mail client's wrapper.
     *
     * So: the box must be strictly larger than the ink on every side. This is the
     * assertion that makes a clip harmless anywhere, and it is deliberately the
     * OPPOSITE of what this file asserted for one day.
     */
    const [x, y, w, h] = box(VIEW_BOX);
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
    expect(w).toBeCloseTo(WIDTH_EM * 1000, 1);
    expect(h).toBeCloseTo(HEIGHT_EM * 1000, 1);
    // and the margin is real rather than a rounding artefact: at the header's
    // ~23px the ink has to clear the edge by most of a device pixel.
    expect(-y / (INK_HEIGHT_EM * 1000)).toBeGreaterThan(0.03);
    expect(INK_HEIGHT_EM).toBeLessThan(HEIGHT_EM);
  });

  it('lets nothing in the header clip the wordmark', () => {
    // The clip that caused it, and the escape that releases it. `:has()` keeps
    // every boundary intact for the store-name path, which is the only one that
    // can actually overflow.
    const css = read('src/styles/components/header.css');
    expect(css).toMatch(/\.store-header__logo-col:has\(\.dz-logo\)[\s\S]*?overflow: visible/);
    expect(css).toMatch(/\.store-header__logo-col:has\(\.dz-logo\) > div/);
    expect(css).toMatch(/\.store-header__logo-col \.logo:has\(\.dz-logo\)/);
  });

  it('gives the lone D its own box at CAP height, not the word’s ascender', () => {
    // A capital standing alone has no ascender above it to allow for, and a box
    // that reserved one would centre the letter high in every slot that uses it.
    const [, my, , mh] = box(MARK_VIEW_BOX);
    const [, vy, , wordH] = box(VIEW_BOX);
    expect(mh).toBeLessThanOrEqual(wordH);
    // Both boxes end the same distance below the shared baseline — that distance
    // being the margin. The D's box is shorter only at the TOP, where the word
    // has an ascender and a lone capital does not.
    expect(my + mh).toBeCloseTo(vy + wordH, 1);
  });

  /**
   * The FAVICON is the one surface that gets a margin (owner, 2026-08-19: cropped
   * to the ink, the D touched all four edges of a 16px tab slot and read as a
   * slab). The margin is a property of the tab strip, not of the drawing — every
   * other surface sits beside something that already gives it air.
   *
   * The exact fraction is the generator's `FAVICON_INK` and is free to move; the
   * band is not. Above ~0.95 there is no margin left and the fault is back; below
   * ~0.80 the counter closes at 16px and the letter reads as a blob, which is the
   * same fault by the opposite route. Both ends were rendered.
   */
  it('gives the favicon — and only the favicon — a margin around the ink', () => {
    const vb = read('public/favicon.svg').match(/viewBox="([^"]+)"/)?.[1];
    const [fx, fy, fw, fh] = box(vb!);
    const [ix, iy, iw, ih] = box(MARK_VIEW_BOX);

    expect(fw).toBeCloseTo(fh, 6); // square, because the slot is
    expect(fx + fw / 2).toBeCloseTo(ix + iw / 2, 1);
    expect(fy + fh / 2).toBeCloseTo(iy + ih / 2, 1);

    // Against the D's INK, not its padded box: the box's margin protects the
    // letter from a clip, and the tab slot's margin is a different decision.
    const margin = -box(VIEW_BOX)[1];
    const fraction = (ih - margin * 2) / fh;
    expect(fraction).toBeGreaterThan(0.8);
    expect(fraction).toBeLessThan(0.95);
  });

  it('keeps the CSS height and the ink width in step with those boxes', () => {
    const [, , wordW, wordH] = box(VIEW_BOX);
    // 1000 units = 1em, which is what lets the component size the svg in em
    // alone. Both of these are the BOX; the ink pair is asserted separately.
    expect(HEIGHT_EM).toBeCloseTo(wordH / 1000, 5);
    expect(WIDTH_EM).toBeCloseTo(wordW / 1000, 5);
  });

  it('runs the gradient across the whole wordmark rather than per letter', () => {
    // objectBoundingBox — the default — resolves per element, giving every letter
    // its own full ramp; the word then reads as pieces stuck together. The static
    // files must therefore all declare userSpaceOnUse.
    // The ramp spans the INK. Running it across the margin as well would end the
    // word short of the stop the ramp was drawn for.
    expect(GRADIENT.x2).toBeCloseTo(INK_WIDTH_EM * 1000, 1);
    expect(GRADIENT.y2).toBeCloseTo(INK_HEIGHT_EM * 1000, 1);
    for (const file of GENERATED.filter((f) => read(f).includes('linearGradient')))
      expect(read(file), file).toContain('gradientUnits="userSpaceOnUse"');
  });
});

describe('the word keeps the face’s own spacing', () => {
  /** Each path's subpaths as x-ranges, merged where they overlap — a letter is
   *  one range even when it is drawn as two contours (the `e`'s counter, the
   *  `i`'s dot). */
  const letterBoxes = (d: string) => {
    const boxes = d
      .split('M')
      .filter(Boolean)
      .map((sub) => {
        const xs = [...sub.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => Number(m[1]));
        return { x1: Math.min(...xs), x2: Math.max(...xs) };
      })
      .sort((a, b) => a.x1 - b.x1);
    const merged: { x1: number; x2: number }[] = [];
    for (const b of boxes) {
      const last = merged.at(-1);
      if (last && b.x1 <= last.x2) last.x2 = Math.max(last.x2, b.x2);
      else merged.push({ ...b });
    }
    return merged;
  };

  const letters = letterBoxes(LETTERS_PATH);
  const markRight = Math.max(...letterBoxes(MARK_PATH).map((b) => b.x2));
  let prev = markRight;
  const gaps = letters.map((l) => {
    const g = l.x1 - prev;
    prev = l.x2;
    return g;
  });

  it('draws six letters after the D, each as one shape', () => {
    // If this is wrong the gaps below are measuring something else entirely.
    expect(letters).toHaveLength(6);
  });

  it('leaves the tight pairs tight, which is what LEVELLING destroyed', () => {
    /**
     * THE OPPOSITE OF WHAT THIS FILE ASSERTED UNTIL 2026-08-21, and deliberately.
     * Levelling every gap to their mean was correct while a centred stroke ate a
     * flat number of units out of each one. With no stroke there is nothing to
     * correct, and levelling opens `ez` — which Libre Franklin sets at roughly a
     * quarter of the mean — until the z floats and its diagonal reads as a slab.
     * A face closes those pairs on purpose: a z has less white inside its own box
     * than a round letter does.
     *
     * So the gaps must NOT be equal. The spread is the evidence the font's own
     * spacing survived, and the `ez` junction is the one that proves it.
     */
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const spread = Math.max(...gaps) - Math.min(...gaps);
    expect(spread, `gaps: ${gaps.map((g) => g.toFixed(0)).join(', ')}`).toBeGreaterThan(mean * 0.5);
    // gaps[1] is e→z, the pair the face draws tightest of the six.
    expect(gaps[1]).toBeLessThan(mean);
    // …and every one of them still has to be a gap, not a collision.
    for (const g of gaps) expect(g).toBeGreaterThan(0);
  });

  it('is as wide as the face draws it, with nothing added or taken', () => {
    // No tracking, no levelling: the width is Libre Franklin ExtraBold's own. A
    // different number here means something started adjusting the spacing again,
    // which is the decision this whole describe exists to guard.
    expect(INK_WIDTH_EM).toBeCloseTo(3.807, 2);
    expect(WIDTH_EM).toBeGreaterThan(INK_WIDTH_EM); // the box is that plus its margin
  });
});

describe('the module is what the generator writes', () => {
  /**
   * `gapEm` was added to `src/lib/brand-lockup.ts` by hand on 2026-08-14 and the
   * generator was never taught to emit it. Nothing failed, because nobody ran
   * `brand:wordmark` for three days — and that run would have deleted a value two
   * live surfaces import. A generated file that can be hand-edited is two files.
   */
  const generator = read('scripts/generate-wordmark.mjs');
  const moduleSrc = read('src/lib/brand-lockup.ts');
  const exportsOf = (src: string) => [...src.matchAll(/export const (\w+)/g)].map((m) => m[1]).sort();

  it('exports exactly the names the generator’s template emits', () => {
    expect(exportsOf(moduleSrc)).toEqual(exportsOf(generator));
  });

  it('carries no TAGLINE key the generator does not write', () => {
    const keys = (src: string) =>
      (src.match(/export const TAGLINE = \{([\s\S]*?)\n\};/)?.[1] ?? '')
        .split('\n')
        .map((line) => line.split(':')[0].trim())
        .filter((k) => /^\w+$/.test(k))
        .sort();
    expect(keys(moduleSrc)).toEqual(['gapEm', 'minLockupPx', 'sizeEm', 'trackEm', 'weight']);
    expect(keys(moduleSrc)).toContain('gapEm');
  });

  it('keeps one authored copy of the tagline’s spacing', () => {
    // The poster lockup used to hard-code its own gap beside the module's value.
    // One authored constant, read by both, or they drift again.
    expect(generator).toMatch(/const TAGLINE_GAP = /);
    expect(generator).toMatch(/const TAGLINE_SIZE = /);
  });
});

describe('the second line is small, centred, and tracked by language', () => {
  it('is a third of the cap height, not a width match', () => {
    // It used to be solved to the wordmark's own ink width, which put it just
    // over 0.4em. It is now a share of the cap height (0.33 of it), which lands
    // near 0.245em. A value back up in the 0.4s means the width solve came back.
    expect(TAGLINE.sizeEm).toBeGreaterThan(0.2);
    expect(TAGLINE.sizeEm).toBeLessThan(0.3);
  });

  it('states the smallest lockup that leaves the line legible, and is read for it', () => {
    /**
     * The homepage carried this floor as a TYPED 2.5rem, correct for a tagline
     * that was 0.3886em of the lockup — 15.5px, the owner's own floor from
     * 2026-08-05. The lockup was redrawn on 08-21, the ratio became 0.245, and
     * the same 2.5rem put the Hebrew at 9.8px on a phone. He reported it the same
     * day. A floor derived from a ratio must not be stored as a size.
     */
    expect(TAGLINE.sizeEm * TAGLINE.minLockupPx).toBeGreaterThanOrEqual(15.5);
    // …and no bigger than it needs to be, or the floor is really a design choice
    // wearing a legibility argument.
    expect(TAGLINE.sizeEm * TAGLINE.minLockupPx).toBeLessThan(16.5);
    // the homepage reads it rather than repeating it
    const home = read('src/pages/index.astro');
    expect(home).toContain('TAGLINE.minLockupPx');
    expect(home).not.toMatch(/size="clamp\(\d/);
  });

  it('gives Hebrew a fraction of the Latin tracking', () => {
    /**
     * Opening Hebrew does not enlarge the word, it loosens it, and a loosened
     * Hebrew line under a tight Latin name is what read as amateur on 2026-08-05.
     * The Latin line is opened wide on purpose — that IS the device. Anything
     * approaching parity here means the rule was forgotten.
     */
    expect(TAGLINE.trackEm.he).toBeGreaterThan(0);
    expect(TAGLINE.trackEm.en).toBeGreaterThan(TAGLINE.trackEm.he * 3);
    expect(TAGLINE.trackEm.he).toBeLessThan(0.1);
  });

  it('is set at a weight main.css already ships', () => {
    // The line is LIVE TEXT — it follows the visitor's language — so a weight the
    // site does not already carry is two more font files (latin + hebrew) on
    // every page for one line on two of them.
    expect(read('src/styles/main.css')).toContain(`font-weight: ${TAGLINE.weight};`);
  });

  it('takes the trailing letter-space back on BOTH renderers', () => {
    /**
     * `letter-spacing` is applied after the LAST character too, so a centred run
     * sits half a space off its own axis — which is the first thing the owner
     * noticed about the English line. One whole tracking unit off the inline end
     * makes the box the ink again.
     *
     * TWO renderers draw this lockup — the component and the raster script — and
     * a rule living in two modules is the next bug (it is how three copies of the
     * D's path existed). The NUMBER is shared already, through `TAGLINE.trackEm`;
     * this holds the formula, so a fix in one cannot silently miss the other.
     */
    for (const file of ['src/components/BrandLogo.astro', 'scripts/generate-brand-assets.mjs'])
      expect(read(file), file).toMatch(/margin-inline-end:\$\{-track\}em/);
  });

  it('leaves no second copy of the tagline’s words in a script', () => {
    // The generators read `translations` rather than carrying the strings, or a
    // change to the tagline would leave every poster, the mail header and the
    // share card saying the old thing with nothing to notice.
    for (const file of ['scripts/generate-wordmark.mjs', 'scripts/generate-brand-assets.mjs']) {
      const src = read(file);
      expect(src, file).toContain("from '../src/i18n/translations.ts'");
      expect(src, file).not.toContain(translations.he.brand.tagline);
      expect(src, file).not.toMatch(/'MARKETPLACE'/);
    }
  });

  it('says something different in each language, on purpose', () => {
    // Hebrew keeps the slogan; English says the one word that does the same job
    // in a breath (owner, 2026-08-21). Not a translation, and not a shared key —
    // `home.startSelling` is the homepage h1's accessible name and stays a
    // sentence.
    expect(translations.he.brand.tagline).toBe('מתחם חנויות דיגיטלי');
    expect(translations.en.brand.tagline).toBe('MARKETPLACE');
    expect(read('src/components/BrandLogo.astro')).toContain('t.brand.tagline');
  });
});

describe('the fonts the generator reads are in the repo', () => {
  it('keeps both faces and their licence, so the lockup can be rebuilt offline', () => {
    // Neither face is shipped to browsers — the letters are outlines — but both
    // have to be here for `npm run brand:wordmark` to redraw them, and the OFL
    // requires the licence to travel with them.
    for (const f of ['LibreFranklin-ExtraBold.ttf', 'Heebo-Variable.ttf', 'OFL.txt'])
      expect(fs.existsSync(path.join(ROOT, 'assets/brand-fonts', f)), f).toBe(true);
  });

  it('names every face it carries in the licence file', () => {
    const ofl = read('assets/brand-fonts/OFL.txt');
    for (const name of ['Libre Franklin', 'Heebo', 'Chakra Petch']) expect(ofl).toContain(name);
  });

  it('does not ship Libre Franklin as a webfont', () => {
    // The whole reason the letters are paths: nothing else on the site uses this
    // family, so a @font-face for it would be an eleventh preload for seven
    // letters — and one that `font-display: optional` could refuse at first paint.
    expect(read('src/styles/main.css')).not.toMatch(/franklin/i);
  });

  it('keeps the superseded lockup whole, rather than only in git', () => {
    // The owner asked for the previous logo to be kept somewhere safe
    // (2026-08-21). A branch is not somewhere he can look.
    const archive = 'assets/brand-archive/2026-08-21-chakra-petch';
    for (const f of ['dezabin-wordmark.svg', 'favicon.svg', 'brand-lockup.ts.bak', 'README.md'])
      expect(fs.existsSync(path.join(ROOT, archive, f)), f).toBe(true);
  });

  it('keeps the faces that archive can only be rebuilt from', () => {
    // Neither is read by anything live any more — which is exactly why they
    // would be deleted as dead weight, and why the README's "run the old
    // generator" would then be a promise nothing keeps.
    for (const f of ['ChakraPetch-Bold.ttf', 'Heebo-Medium.ttf'])
      expect(fs.existsSync(path.join(ROOT, 'assets/brand-fonts', f)), f).toBe(true);
    expect(read('assets/brand-archive/2026-08-21-chakra-petch/README.md')).toContain('ChakraPetch-Bold.ttf');
  });

  it('says where the clip measurement lives, so the tool is not an orphan', () => {
    // A tool nothing points at is a tool nobody runs. The header's own note is
    // where somebody stands when the logo looks cut again.
    expect(read('src/styles/components/header.css')).toContain('scripts/measure-logo-clip.mjs');
  });
});
