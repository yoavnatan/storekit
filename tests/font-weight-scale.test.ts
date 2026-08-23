import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE WEIGHT SCALE, RE-SOLVED FOR THE FACE — AND IT HAS TWO HALVES THAT MUST NOT DRIFT.
 *
 * Owner, 2026-08-23: *"אני רוצה שזה יישב בדיוק על הפיקסל ועל העובי, רק עם הפונט החדש"*. Noto Sans
 * Hebrew lays down 4-7% more ink than Heebo at the same number — measured by rendering the same
 * Hebrew line at the same px and counting the ink, with letter HEIGHT within 1%, so it is genuinely
 * thicker strokes rather than a bigger-looking face. Because the face is variable, the fix is not
 * "drop a step" (400 lands 8% LIGHT) but the axis value that reproduces Heebo's density:
 *
 *     Heebo 400 -> 380     600 -> 553     800 -> 730
 *     Heebo 500 -> 455     700 -> 641
 *
 * The scale reaches the page through THREE mechanisms, and all three have to agree:
 *   1. Tailwind's own `--font-weight-*` tokens, for ~410 `font-medium`/`font-semibold`/`font-bold`
 *      call sites.
 *   2. The raw `font-weight: NNN` declarations in the legacy stylesheets — 268 of them.
 *   3. `body { font-weight: var(--font-weight-normal) }`, for everything that declares NO weight
 *      at all. This one was missed on the first pass and it is the biggest surface by far: the
 *      price column, the panel headings and every table cell were still inheriting the browser's
 *      400 while the buttons had already moved.
 *
 * Miss any one and the site renders two densities at once, which is harder to see than a uniform
 * error and is exactly the state this pass was fixing.
 *
 * **Re-solve these on the next family swap.** They are a property of the pair (this face, Heebo's
 * density), not constants. The measurement: render the same string at the same px in both faces,
 * count non-white subpixels, and interpolate the axis value that matches.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const SCALE: Record<string, number> = {
  normal: 380,
  medium: 455,
  semibold: 553,
  bold: 641,
  extrabold: 730,
};

/** The pre-swap numbers. Any of these left in a stylesheet is a surface still on Heebo's scale. */
const OFF_SCALE = [400, 500, 600, 700, 800];

/**
 * Mail is not this scale, and that is deliberate rather than an oversight: a mail client renders
 * the header in Arial (no @font-face survives most of them), so a 455 there is a request Arial
 * cannot honour and rounds back to 500 anyway. `lib/email/` keeps the round numbers.
 */
const EMAIL = 'src/lib/email/';

describe('the interface weight scale', () => {
  const tokens = read('src/styles/base/tokens.css');

  it('declares every step in Tailwind’s own token namespace', () => {
    for (const [name, value] of Object.entries(SCALE)) {
      const m = new RegExp(`--font-weight-${name}:\\s*(\\d+)`).exec(tokens);
      expect(m, `--font-weight-${name} is not declared — its utility falls back to Tailwind's default`).not.toBeNull();
      expect(Number(m![1]), `--font-weight-${name}`).toBe(value);
    }
  });

  it('gives text that declares no weight the same scale', () => {
    // Without this the browser's own 400 wins on the majority of the page's text.
    expect(tokens).toMatch(/body\s*\{[^}]*font-weight:\s*var\(--font-weight-normal\)/s);
  });

  it('leaves no stylesheet still asking for the pre-swap numbers', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!/\.(css|astro|ts|tsx|js|mjs)$/.test(e.name)) continue;
        if (rel.startsWith(EMAIL)) continue;
        const text = read(rel);
        /**
         * A `font-weight: 100 900` in an @font-face is a RANGE, not a weight, and has to be let
         * through — but anchoring on a trailing `;`/quote to tell them apart is what this test
         * did first, and it MISSED a live one: `style="font-weight:500${h.done ? …}"` in
         * `product-seo-field.ts`, where the declaration ends in a template interpolation. The
         * same blind spot was in the script that did the remap, so the test agreed with the bug.
         *
         * Matching the range EXPLICITLY instead — a second three-digit number after it — leaves
         * nothing between the two cases.
         */
        for (const m of text.matchAll(/font-weight\s*:\s*(\d{3})(\s+\d{3})?/g)) {
          if (m[2]) continue; // a variable range, e.g. `100 900`
          if (OFF_SCALE.includes(Number(m[1]))) offenders.push(`${rel}: font-weight ${m[1]}`);
        }
      }
    };
    walk('src');
    expect(offenders, 'these render at Heebo\'s density beside text that does not').toEqual([]);
  });

  it('keeps the brand lockup’s live tagline on the scale too', () => {
    // The tagline is live text in this face on the site AND outlined at the same number in the
    // poster files, so an off-scale value here shows up as the lockup disagreeing with the page.
    const gen = read('scripts/generate-wordmark.mjs');
    const m = /const TAGLINE_WEIGHT = (\d+)/.exec(gen);
    expect(m).not.toBeNull();
    expect(Number(m![1]), 'the tagline must sit on the same "regular" as the rest of the site').toBe(SCALE.normal);
  });
});
