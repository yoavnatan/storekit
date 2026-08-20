/**
 * The three floating notices are laid out by ONE recipe, and none of them may drift from it.
 *
 * They are twins by construction — same corner, same shape, raised by three unrelated owners — and
 * on 2026-08-20 all three were changed together three times in one afternoon: full width on a
 * phone, then icon-and-sentence as one flex item, then one rule at every width instead of a `sm:`
 * split. A recipe that has to be copied into three files is a recipe that will be corrected in one
 * of them (memory `project_brand_boost_twin_drift`).
 *
 * What the numbers in it are FOR, so a future edit knows what it is trading:
 *  · `inset-x-4 mx-auto max-w-[34rem]` — a defined width, never shrink-to-fit. A wrapping flex box
 *    sizes to its widest ITEM rather than to the sum of them, so left to itself the bar chose 320px
 *    and stacked, which is how the middle of the range ended up 106px tall.
 *  · `basis-[19rem]` on the icon+sentence — one line of the sentence. Either the buttons fit beside
 *    it or they take the row below; the words are never squeezed into a column.
 *  · `mx-auto` on the button pair — no free space beside a growing sentence, so it stays at the end
 *    of that line; alone on a row, the auto margins centre it.
 *  · `data-bottom-bar` — the toast reads it and lifts above whatever is out
 *    (tests/bottom-bar-toast-clearance.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../src/components/dashboard/', import.meta.url));
const BARS = ['UnsavedChangesBar.astro', 'StaleDataBar.astro', 'FormFallbackGuard.astro'];

/** The class list of the element carrying `data-bottom-bar` in each file. */
function barClasses(file: string): string {
  const text = readFileSync(join(DIR, file), 'utf8');
  const line = text.split('\n').find((l) => l.includes('data-bottom-bar') && l.includes('class='));
  if (!line) throw new Error(`${file}: no floating bar found`);
  return line.match(/class="([^"]*)"/)?.[1] ?? '';
}

describe('the floating notices share one layout recipe', () => {
  const REQUIRED = [
    'fixed', 'bottom-6', 'inset-x-4', 'mx-auto', 'max-w-[34rem]',
    'flex', 'flex-wrap', 'items-center',
  ];

  for (const file of BARS) {
    it(`${file} carries the whole recipe`, () => {
      const cls = barClasses(file);
      for (const token of REQUIRED) {
        expect(cls.split(/\s+/), `${file} is missing ${token}`).toContain(token);
      }
      // The `sm:` split that made the middle of the range worse than the phone. A breakpoint may
      // change padding or type size; it may not change whether the row can break.
      expect(cls, `${file} must not re-introduce a breakpoint on wrapping`).not.toContain('flex-nowrap');
      expect(cls, `${file} must not re-introduce a per-breakpoint position`).not.toContain('sm:left-');
    });
  }

  it('the sentence is one flex item with a line\'s worth of basis, in every one of them', () => {
    for (const file of BARS) {
      const text = readFileSync(join(DIR, file), 'utf8');
      expect([...text.matchAll(/grow basis-\[19rem\]/g)].length, `${file}`).toBeGreaterThan(0);
      expect(text, `${file}: the sentence must be allowed to shrink`).toContain('min-w-0');
    }
  });

  it('every button pair centres itself when it lands on its own row', () => {
    // `ms-auto` — the end alignment inherited from the one-line layout — reads as the buttons
    // having fallen off the bar once the row is theirs alone. UnsavedChangesBar carries no pair at
    // all: its only control is the section's name, inside the sentence.
    let found = 0;
    for (const file of BARS) {
      const text = readFileSync(join(DIR, file), 'utf8');
      for (const m of text.matchAll(/flex items-center gap-2 shrink-0 (\S+?)['"]/g)) {
        found++;
        expect(m[1], `${file}: a pair on its own row must centre`).toBe('mx-auto');
      }
    }
    expect(found, 'no button pair found in any bar — has the recipe moved?').toBeGreaterThan(0);
  });
});
