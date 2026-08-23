import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE FACE'S DECLARED METRICS ARE OVERRIDDEN, AND THE SUM IS THE PART THAT MUST NOT MOVE.
 *
 * Owner, 2026-08-23, on the day the interface face changed: *"על כל כפתור הוא קצת למטה יותר, כאילו
 * נקודת ההתחלה שלו היא קצת יותר תחתונה"*, and then *"בכל קונטיינר הטקסט לא ממורכז מבחינת הגובה"*.
 * Both are one measurable fact rather than an impression:
 *
 *     Heebo             baseline sits 71.34% down its own line box
 *     Noto Sans Hebrew  baseline sits 78.53% down its own line box
 *
 * Noto reserves far less room under the baseline (29.2% against Heebo's 42.09%), so in ANY box that
 * centres its text — a button, a chip, a tab, a table cell — the glyphs ride low. Measured on the
 * real dashboard before the fix: 0.7px on a 12.5px button, 1.26px on a 14px tab, 1.18px on a 16px
 * heading. After: every one of them inside ±0.3px.
 *
 * The fix is `ascent-override` / `descent-override` on the @font-face, which is the only place that
 * can correct all of them at once — the alternative was a nudge on every component, which is how a
 * codebase ends up with fifty magic numbers that no future face swap can re-derive.
 *
 * ── WHAT THIS TEST PINS, AND WHY IT IS THE SUM ──
 * The two numbers reproduce HEEBO'S BASELINE SHARE inside NOTO'S OWN LINE BOX. Keeping the box is
 * the whole safety of the change: 97.03 + 38.97 = 136.00% is exactly what the face already declares
 * (1068 + 292 per 1000 upem), so no element's height moves and nothing reflows. Change one number
 * without the other and every `line-height: normal` box on the site silently grows or shrinks —
 * which would be a layout change shipped under the name of a typography fix.
 *
 * A browser too old for the descriptors ignores them and gets the pre-fix rendering. That is a
 * graceful floor rather than a break, and it is why this is a font-level correction and not JS.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/** Noto Sans Hebrew's own hhea box, per 1000 upem: ascender 1068, descender -292. */
const FACE_BOX_PERCENT = 136.0;

describe('font metric override', () => {
  const css = read('src/styles/main.css');
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);

  it('is declared on every face of the interface family, not just one script', () => {
    // Hebrew and Latin are separate @font-face rules split by unicode-range. A price string mixes
    // Latin digits with a Hebrew ₪, resolved from BOTH — override one and that string sits at two
    // different heights inside one line.
    const base = faces.filter((f) => /font-family:\s*'Noto Sans Hebrew'/.test(f));
    expect(base.length, 'expected the two subset faces of the interface family').toBe(2);
    for (const f of base) {
      expect(f, 'a face of the interface family with no ascent-override').toMatch(/ascent-override:/);
      expect(f, 'a face of the interface family with no descent-override').toMatch(/descent-override:/);
    }
  });

  it('keeps the line box exactly the size the face itself declares', () => {
    for (const f of faces.filter((x) => /ascent-override/.test(x))) {
      const asc = Number(/ascent-override:\s*([\d.]+)%/.exec(f)![1]);
      const desc = Number(/descent-override:\s*([\d.]+)%/.exec(f)![1]);
      expect(
        asc + desc,
        `ascent+descent must stay ${FACE_BOX_PERCENT}% — the face's own box. Anything else moves ` +
          'every line-height:normal element on the site, which is a layout change, not a type fix.',
      ).toBeCloseTo(FACE_BOX_PERCENT, 2);
    }
  });

  it('moves the baseline UP, which is the direction the complaint was in', () => {
    // Sanity on the direction: the override must give the face LESS ascent than it declares
    // (106.8%), or it is pushing the text further down rather than lifting it.
    for (const f of faces.filter((x) => /ascent-override/.test(x))) {
      const asc = Number(/ascent-override:\s*([\d.]+)%/.exec(f)![1]);
      expect(asc, 'the override must reduce the ascent, not raise it').toBeLessThan(106.8);
    }
  });
});
