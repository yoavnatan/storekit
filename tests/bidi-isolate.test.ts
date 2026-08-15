import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateLatinRunsHtml } from '../src/lib/bidi-isolate.js';

/**
 * A number the seller typed in Hebrew must not join the English word in front of it.
 *
 * The owner reported the symptom exactly (2026-08-15): "אחרי שכותבים משהו באנגלית, סימנים ומספרים
 * נחשבים כאילו הם בפלואו האנגלי למרות שאני רושם שם בעברית". It is the Unicode bidi algorithm doing
 * what it is specified to do — the space between a Latin word and a digit is neutral, and a neutral
 * between two left-to-right characters resolves left-to-right — so "קוד DEZABIN 10%" paints as one
 * LTR block and the 10% lands on the wrong side of the code.
 *
 * The ORDER itself cannot be asserted here: it is decided by the browser's bidi implementation at
 * paint time, and jsdom has no layout. It was measured instead, in Chromium, over eight realistic
 * promotion lines — three painted in the wrong order and now do not, five were already right and
 * still are. `lib/bidi-isolate.ts` records that table. What this file pins is the STRUCTURE that
 * produced it, and the escaping, which is the part a refactor can quietly break.
 */

const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

describe('isolateLatinRunsHtml', () => {
  it('isolates a Latin run and leaves the Hebrew alone', () => {
    expect(isolateLatinRunsHtml('קוד DEZABIN 10% הנחה'))
      .toBe('קוד <bdi>DEZABIN</bdi> 10% הנחה');
  });

  it('keeps punctuation glued to the word it follows', () => {
    // Measured: outside the isolate it detached — "SUMMER :" and "DEZABIN ,".
    expect(isolateLatinRunsHtml('מבצע SUMMER: 20%')).toContain('<bdi>SUMMER:</bdi>');
    expect(isolateLatinRunsHtml('קוד DEZABIN, הנחה')).toContain('<bdi>DEZABIN,</bdi>');
  });

  it('leaves a bare number alone — it was never the broken part', () => {
    expect(isolateLatinRunsHtml('עד 50% הנחה')).toBe('עד 50% הנחה');
    expect(isolateLatinRunsHtml('בתוקף עד 31.12')).toBe('בתוקף עד 31.12');
  });

  it('keeps a Latin run whole when it carries its own marks', () => {
    expect(isolateLatinRunsHtml('מותג AT&T בחנות')).toContain('<bdi>AT&amp;T</bdi>');
    expect(isolateLatinRunsHtml('מידה S/M זמינה')).toContain('<bdi>S/M</bdi>');
  });

  it('isolates each run separately, so several codes each keep their place', () => {
    const html = isolateLatinRunsHtml('קוד DEZABIN או קוד SUMMER');
    expect(html.match(/<bdi>/g)).toHaveLength(2);
  });

  it('escapes per segment, so an entity is never split by the isolate', () => {
    // Escaping the whole string first would turn `&` into `&amp;`, whose own letters then match
    // the run pattern — the entity comes back cut in half and printed as text.
    const html = isolateLatinRunsHtml('רק & סימן');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<bdi>amp;</bdi>');
  });

  it('escapes markup in the seller\'s own text', () => {
    expect(isolateLatinRunsHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(isolateLatinRunsHtml('שלום <b>עולם</b>')).not.toContain('<b>');
  });

  it('renders empty for empty', () => {
    expect(isolateLatinRunsHtml('')).toBe('');
  });
});

describe('all three renderers of the sale strip use it', () => {
  const RENDERERS: [string, string][] = [
    ['components/StoreSaleBanner.astro', 'the storefront banner'],
    ['components/dashboard/PromotionsPanel.astro', "the dashboard's server-rendered preview"],
    ['scripts/dashboard/promotions.ts', 'the live preview as the seller types'],
  ];
  for (const [file, what] of RENDERERS) {
    it(`${what} isolates both lines of copy`, () => {
      const src = read(file);
      expect(src).toMatch(/from '(\.\.\/)+lib\/bidi-isolate\.js'/);
      // Title AND subtitle — the title is the line most likely to END in a coupon code.
      expect(src.match(/isolateLatinRunsHtml\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
  }

  it('the live preview writes HTML, not a text node', () => {
    // `textContent` here would silently opt the one renderer the seller watches while typing out
    // of the fix.
    const src = read('scripts/dashboard/promotions.ts');
    expect(src).toContain('pvTitle.innerHTML = isolateLatinRunsHtml');
    expect(src).toContain('pvText.innerHTML = isolateLatinRunsHtml');
  });
});
