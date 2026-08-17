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
  INK_WIDTH_EM,
  GRADIENT,
  TAGLINE,
} from '../src/lib/brand-lockup.js';

/**
 * The brand lockup has SIX surfaces — the component, the account menu's home row, the favicon,
 * the poster SVGs, the rasters `npm run brand:assets` writes, and the email header those feed.
 * Until 2026-08-10 three of them carried the D's path as a literal string and asserted in their
 * own comments that the three copies were byte-identical, which nothing checked. They now all
 * read `src/lib/brand-lockup.ts`, and this file is what holds them there.
 *
 * It also pins two failures that already happened, because both were SILENT:
 *
 *   • `NaN` IN A PATH. opentype's `toPathData` emits the literal string `NaN` for some
 *     coordinates — reproducibly, for the lamed in the slogan. An SVG path containing NaN is
 *     invalid, so a renderer draws up to the error and stops: the poster lockup shipped showing
 *     one Hebrew letter out of nineteen. Nothing upstream notices, because the Path object's own
 *     bounding box is computed from the commands and is perfectly correct. The generator
 *     serialises paths itself now; this makes sure nothing reintroduces the shortcut.
 *
 *   • A LITERAL PATH LEFT IN A COMPONENT. That is how the three copies existed in the first
 *     place, and a fourth would drift the same way.
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
];

describe('the lockup is one drawing', () => {
  it('gives every generated file the module’s own mark path', () => {
    for (const file of GENERATED) expect(read(file), file).toContain(MARK_PATH);
  });

  it('gives every wordmark and lockup file the module’s own letters', () => {
    for (const file of GENERATED.filter((f) => f.includes('wordmark') || f.includes('lockup')))
      expect(read(file), file).toContain(LETTERS_PATH);
  });

  it('leaves no literal brand path in a component to drift from it', () => {
    // Both files legitimately carry a dozen 24×24 icon paths, so "has a d= literal"
    // is not the test. The brand's coordinates live in a 1000-unit em and run to
    // 3438; an icon's never leave a 24-unit box. A literal path carrying a
    // three-figure coordinate is therefore the mark or the letters, pasted in.
    for (const file of ['src/components/BrandLogo.astro', 'src/components/Header.astro']) {
      for (const [, d] of read(file).matchAll(/\bd="([^"]+)"/g)) {
        const biggest = Math.max(...(d.match(/\d+(\.\d+)?/g) ?? ['0']).map(Number));
        expect(biggest, `${file}: ${d.slice(0, 60)}`).toBeLessThan(100);
      }
    }
  });
});

describe('nothing generated carries an unrenderable coordinate', () => {
  it('has no NaN, Infinity or undefined in any generated file', () => {
    for (const file of [...GENERATED, 'src/lib/brand-lockup.ts'])
      expect(read(file), file).not.toMatch(/\b(NaN|Infinity|undefined)\b/);
  });

  it('parses every number in both paths as finite', () => {
    for (const [name, d] of [
      ['MARK_PATH', MARK_PATH],
      ['LETTERS_PATH', LETTERS_PATH],
    ] as const) {
      const numbers = d.match(/-?\d+(\.\d+)?/g) ?? [];
      expect(numbers.length, name).toBeGreaterThan(20);
      for (const n of numbers) expect(Number.isFinite(Number(n)), `${name}: ${n}`).toBe(true);
    }
  });
});

describe('the mark is still half a regular octagon', () => {
  /** The outer contour, as points. It is the first subpath of `MARK_PATH`. */
  const outer = (MARK_PATH.split('M')[1] ?? '')
    .split('L')
    .map((p) => p.trim().replace(/\s*Z\s*$/, '').split(/\s+/).map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite));

  it('cuts its corner at 45°, which is what makes it an octagon and not a chamfered box', () => {
    // The top edge runs from (0,0) to (W-cut, 0); the cut then goes down-right to (W, cut).
    const [topRight, cutEnd] = [outer[1], outer[2]];
    const run = cutEnd[0] - topRight[0];
    const rise = cutEnd[1] - topRight[1];
    expect(run / rise).toBeCloseTo(1, 3);
  });

  it('ties the cut to its HEIGHT, at 1/(2+√2) of it', () => {
    const height = Math.max(...outer.map((p) => p[1]));
    const cut = outer[2][1];
    expect(cut / height).toBeCloseTo(1 / (2 + Math.SQRT2), 4);
  });

  it('starts at the origin, so the wordmark’s ink and its viewBox agree', () => {
    expect(outer[0]).toEqual([0, 0]);
  });
});

describe('the boxes are cropped to the stroked ink', () => {
  const box = (vb: string) => vb.split(' ').map(Number);

  it('pads each viewBox by exactly half the stroke on every side', () => {
    for (const vb of [VIEW_BOX, MARK_VIEW_BOX]) {
      const [x, y] = box(vb);
      expect(x).toBeCloseTo(-STROKE_WIDTH / 2, 6);
      expect(y).toBeCloseTo(-STROKE_WIDTH / 2, 6);
    }
  });

  it('keeps the CSS height and the ink width in step with those boxes', () => {
    const [, , wordW, wordH] = box(VIEW_BOX);
    // 1000 units = 1em, which is what lets the component size the svg in em alone.
    expect(HEIGHT_EM).toBeCloseTo(wordH / 1000, 5);
    expect(INK_WIDTH_EM).toBeCloseTo(wordW / 1000, 5);
  });

  it('runs the gradient across the whole wordmark rather than per letter', () => {
    // objectBoundingBox — the default — resolves per element, giving every letter
    // its own full ramp; the word then reads as pieces stuck together. The static
    // files must therefore all declare userSpaceOnUse.
    const [, , wordW, wordH] = box(VIEW_BOX);
    expect(GRADIENT.x2).toBeCloseTo(wordW - STROKE_WIDTH, 6);
    expect(GRADIENT.y2).toBeCloseTo(wordH - STROKE_WIDTH, 6);
    for (const file of GENERATED.filter((f) => read(f).includes('linearGradient')))
      expect(read(file), file).toContain('gradientUnits="userSpaceOnUse"');
  });
});

describe('the block is spaced evenly', () => {
  /**
   * Every junction in `Dezabin` — the mark→`e` one included — must carry the same
   * ink gap. It did not until 2026-08-17: Chakra Petch gives the `z` side bearings
   * of 25/25 where the other letters carry 45–60 and kerns `ez`/`za` a further −5
   * each, so the six gaps ran 65/25/25/75/65/75, and the thickening then took a
   * flat 14 out of each and turned that into 51/11/11/61/51/61. `eza` read as a
   * lump inside the word, which is how the owner spotted it.
   *
   * The gaps are measured off the SHIPPED paths rather than recomputed from the
   * font, because the paths are what a visitor sees and the whole failure was
   * invisible to the metrics that produced them.
   */
  /** Each path's subpaths as x-ranges, merged where they overlap — a letter is
   *  one range even when it is drawn as two contours (the `e`'s counter, the
   *  `i`'s dot). */
  const letterBoxes = (d: string) => {
    const boxes = d
      .split('M')
      .filter(Boolean)
      .map((sub) => {
        const xs = sub
          .split(/[ML]/)
          .filter(Boolean)
          .map((p) => Number(p.trim().split(/\s+/)[0]));
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

  it('draws six letters after the mark, each as one shape', () => {
    // If this is wrong the gaps below are measuring something else entirely.
    expect(letters).toHaveLength(6);
  });

  it('gives every junction the same gap, the mark’s included', () => {
    let prev = markRight;
    const gaps = letters.map((l) => {
      const g = l.x1 - prev;
      prev = l.x2;
      return g;
    });
    // A unit is a thousandth of an em; anything under one is past what a raster
    // can show, and the levelling is exact arithmetic anyway.
    for (const g of gaps) expect(g, `gaps: ${gaps.join(', ')}`).toBeCloseTo(gaps[0], 0);
    // And it must be a gap, not a collision: the thickening eats STROKE_WIDTH out
    // of every one of them, so a gap at or under the stroke means letters touching.
    expect(gaps[0]).toBeGreaterThan(STROKE_WIDTH * 2);
  });

  it('did not buy that by opening the word up', () => {
    // The levelling targets the MEAN of the font's own gaps, so it redistributes
    // and cannot widen. 3.452em is what the wordmark measured before it, and the
    // density is the logo (owner, twice). A different number here means the
    // target stopped being the mean — which is a decision about density, and one
    // that has been made and reverted once already.
    expect(INK_WIDTH_EM).toBeCloseTo(3.452, 3);
  });
});

describe('the module is what the generator writes', () => {
  /**
   * `gapEm` was added to `src/lib/brand-lockup.ts` by hand on 2026-08-14 and the
   * generator was never taught to emit it. Nothing failed, because nobody ran
   * `brand:wordmark` for three days — and that run would have deleted a value two
   * live surfaces import, while the poster lockup drew the superseded 0.05 the
   * whole time. A generated file that can be hand-edited is two files.
   */
  const generator = read('scripts/generate-wordmark.mjs');
  const moduleSrc = read('src/lib/brand-lockup.ts');
  const exportsOf = (src: string) => [...src.matchAll(/export const (\w+)/g)].map((m) => m[1]).sort();

  it('exports exactly the names the generator’s template emits', () => {
    expect(exportsOf(moduleSrc)).toEqual(exportsOf(generator));
  });

  it('carries no TAGLINE key the generator does not write', () => {
    const keys = (src: string) =>
      // Up to `};`, not to the first `}` — in the generator each value is a
      // `${...}` interpolation and would swallow the match at its own brace.
      (src.match(/export const TAGLINE = \{(.*?)\};/)?.[1] ?? '')
        .split(',')
        .map((p) => p.split(':')[0].trim())
        .filter(Boolean)
        .sort();
    expect(keys(moduleSrc)).toEqual(keys(generator));
    expect(keys(moduleSrc)).toContain('gapEm');
  });

  it('leaves no second copy of the tagline gap in the generator', () => {
    // The poster lockup used to hard-code `0.05 * UPEM` beside the module's own
    // value. One authored constant, read by both, or they drift again.
    expect(generator).toMatch(/const TAGLINE_GAP = /);
    expect(generator).not.toMatch(/0\.05 \* UPEM/);
  });
});

describe('the tagline still solves against the wordmark', () => {
  it('is a fraction of the wordmark, not a size of its own', () => {
    // Heebo's own "מתחם חנויות דיגיטלי" is a shade under 8.6em, so the ratio that
    // matches it to a 3.45em wordmark lands just over 0.4. A value outside this
    // band means the solve was skipped, not merely re-tuned.
    expect(TAGLINE.sizeEm).toBeGreaterThan(0.35);
    expect(TAGLINE.sizeEm).toBeLessThan(0.45);
  });

  it('pulls the line OUT with a negative margin, cancelling Heebo’s side bearing', () => {
    // A line box is not its ink: align the boxes and the Hebrew starts a visible
    // pixel inside the English however exact the ratio is. Positive here would
    // push it further in, i.e. exactly the wrong way.
    expect(TAGLINE.marginEm).toBeLessThan(0);
    expect(TAGLINE.marginEm).toBeGreaterThan(-0.2);
  });
});

describe('the fonts the generator reads are in the repo', () => {
  it('keeps both faces and their licence, so the lockup can be rebuilt offline', () => {
    // Chakra Petch is NOT shipped to browsers — the letters are outlines — but it
    // has to be here for `npm run brand:wordmark` to redraw them, and the OFL
    // requires the licence to travel with it.
    for (const f of ['ChakraPetch-Bold.ttf', 'Heebo-Medium.ttf', 'OFL.txt'])
      expect(fs.existsSync(path.join(ROOT, 'assets/brand-fonts', f)), f).toBe(true);
  });

  it('does not ship Chakra Petch as a webfont', () => {
    // The whole reason the letters are paths: nothing else on the site uses this
    // family, so a @font-face for it would be an eleventh preload for seven letters —
    // and one that `font-display: optional` could refuse at first paint.
    expect(read('src/styles/main.css')).not.toMatch(/chakra/i);
  });
});
