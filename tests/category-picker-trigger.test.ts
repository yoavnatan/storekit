/**
 * The category picker's trigger is a FIELD, and it has to be the same field as the ones beside it.
 *
 * **The bug this closes (owner, 2026-08-20):** "הכפתור שלו הוא נמוך יותר בהשוואה לכל שאר האינפוטים
 * שם". In the product form the trigger sits in a three-column grid next to SKU and brand, both
 * plain `.input`s — and it was 5px shorter than both, on every product row, in both the add form
 * and the inline edit form.
 *
 * The cause is the one `review-diff`'s checklist names first: **a rule that appears in two modules
 * is the next bug.** `.input` is `padding: 0.65rem 0.8rem` (`styles/components/forms.css`), and two
 * of the four triggers on this site carry the class. The other two re-spelled the recipe in Tailwind
 * utilities — `px-[0.7rem] py-2` — and `py-2` is 0.5rem. Nobody typed a wrong number; the copy just
 * drifted from the original, which is exactly what a copy does.
 *
 * `forms.css` already made this decision and wrote it down: the trigger's hover and open states live
 * there "because they CANNOT live in the markup" — `.input`'s `border` shorthand comes from an
 * unlayered sheet and beats a `hover:border-…` utility however specific it is. So a trigger without
 * the class was also carrying two utilities that had never applied. One class fixes the height and
 * the states together.
 *
 * Asserted on the SOURCE, because the failure is a missing class in markup and a runtime test would
 * only see the one page someone remembered to render. The scan is over the whole tree rather than
 * over the four known files: the point is the FIFTH trigger, written next month.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(astro|ts)$/.test(rel)) out.push(rel);
  }
  return out;
}

/** Every `class="…category-picker__trigger…"` in the tree, with the file it came from. */
function triggers(): Array<{ file: string; classes: string }> {
  const found: Array<{ file: string; classes: string }> = [];
  for (const file of walk('src')) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    // The class attribute of any element naming the trigger. Bounded, non-backtracking: one
    // character class, no nested quantifier (memory `project_redos_regex_class`).
    for (const match of src.matchAll(/class="([^"]*category-picker__trigger[^"]*)"/g)) {
      found.push({ file, classes: match[1]! });
    }
  }
  return found;
}

describe('every category-picker trigger is an .input', () => {
  it('finds the triggers at all, so a rename cannot make this test vacuously pass', () => {
    // Four today: the add-product form, the inline edit form, the sale scope and the boost scope.
    expect(triggers().length).toBeGreaterThanOrEqual(4);
  });

  it('carries the `input` class rather than re-spelling its geometry', () => {
    const offenders = triggers()
      .filter((t) => !/(^|\s)input(\s|$)/.test(t.classes))
      .map((t) => t.file);
    expect(
      [...new Set(offenders)],
      'a category-picker trigger without `input` re-implements .input\'s padding and lands at a '
      + 'different height from the fields beside it (owner, 2026-08-20). Add the class and delete '
      + 'the hand-rolled px/py/bg/border/rounded utilities.',
    ).toEqual([]);
  });

  it('does not hand-roll the padding, background, border or radius the class already gives it', () => {
    // The height was only the visible half. A trigger that keeps these utilities alongside the
    // class has two answers for one property, and which one wins depends on the layer order.
    const DUPLICATED = [/\bpy-\d/, /\bpx-\[/, /\bbg-\[color:var\(--color-bg\)\]/, /\brounded-\[var\(--radius\)\]/];
    const offenders = triggers()
      .filter((t) => DUPLICATED.some((re) => re.test(t.classes)))
      .map((t) => t.file);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('leaves the hover and open border to forms.css, which is the only place they work', () => {
    // `.input` sets the `border` SHORTHAND from an unlayered sheet, so these utilities lose —
    // measured 2026-08-05, and written up at length above `.category-picker__trigger:hover`.
    const offenders = triggers()
      .filter((t) => /hover:border-|aria-expanded:border-/.test(t.classes))
      .map((t) => t.file);
    expect([...new Set(offenders)]).toEqual([]);
  });
});
