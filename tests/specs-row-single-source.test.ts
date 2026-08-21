/**
 * The product's specification row is built in ONE place, and no field in it is nailed to a width
 * it cannot shrink below.
 *
 * Both halves come from the same afternoon (2026-08-20). The row existed three times — the rows
 * rendered from a product's saved specs, the row "+ הוסף שורה" appends, and the row a suggested
 * attribute creates — and all three carried `width:170px` / `width:220px` with `flex:0 0 auto`.
 * 440px of fixed width in a 333px box on a phone: measured at 375px, the value field started 44px
 * past the left edge of the screen and the × was 82px beyond it. In RTL that overflow produces no
 * scrollbar, so the control was not merely awkward — it was unreachable
 * (owner: *"רוחב: 20 (ואיקס למחיקה) זה מה שיוצא לי מהשטח"*).
 *
 * Fixing one copy would have left two. So the row moved to `scripts/dashboard/specs-row.ts`, and
 * this fails if a fourth is hand-rolled — the pattern `safe-redirect` and `email-address` already
 * use here: extract the rule, then make the copy impossible rather than merely fixed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SOURCE = join(SRC, 'scripts/dashboard/specs-row.ts');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|astro)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('one specification row, and it fits the screen it is on', () => {
  it('only one file writes the row\'s markup', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === SOURCE) continue;
      const text = readFileSync(file, 'utf8');
      // The markup, not the SELECTOR: reading `input[name="specs_label"]` back out of the DOM is
      // what half the dashboard legitimately does. Writing the element is what may happen once.
      if (/<input[^>]*name="specs_label"/.test(text)) offenders.push(relative(SRC, file));
    }
    expect(
      offenders,
      'Build the row through `specsRowHtml` (scripts/dashboard/specs-row.ts). Three copies of it '
      + 'is how the same unreachable × shipped in three places at once.',
    ).toEqual([]);
  });

  it('neither field can be squeezed below its content and pushed off the screen', () => {
    const text = readFileSync(SOURCE, 'utf8');
    // `min-w-0` is the whole difference between "shrinks" and "leaves the viewport": a flex item's
    // default `min-width:auto` is its content, so without it the row cannot get narrower than the
    // text inside it however small the phone is.
    // Per INPUT, not a count over the file — the prose above says `min-w-0` too, and a guard that
    // a comment can satisfy is not a guard.
    const inputs = text.split('\n').filter((l) => /<input[^>]*name="specs_(label|value)"/.test(l));
    expect(inputs).toHaveLength(2);
    for (const line of inputs) {
      expect(line, `${line.trim().slice(0, 60)}… must carry min-w-0`).toContain('min-w-0');
      // A fixed px width is fine ABOVE a breakpoint and fatal below one — that is the whole shape
      // of the bug: 170px and 220px that applied at every size.
      const unguarded = line.match(/(?<!sm:|md:|lg:)w-\[\d+px\]/);
      expect(unguarded, `${line.trim().slice(0, 60)}… pins a width at every size`).toBe(null);
      expect(line).not.toContain('flex:0 0 auto');
    }
  });

  /**
   * The desktop size is stated as a flex-BASIS, and a `width` utility would not work at all.
   *
   * `.input` (components/forms.css) declares `width: 100%`, and that sheet is imported unlayered
   * while Tailwind's utilities live in `@layer utilities` — unlayered beats layered whatever the
   * specificity. So `sm:flex-none sm:w-[170px]` read, in the browser, as "hand the sizing back to
   * width, which is 100%": each field took a whole row and the three-part row became three stacked
   * rows above 640px only (owner, סשן ג׳). A flex-basis is the one channel `.input` cannot reach.
   *
   * Guarding the SHAPE and not the numbers — a later pass may retune 170/220 — because the shape
   * is the part that silently breaks: `w-[170px]` looks correct in the diff and does nothing.
   */
  it('sizes the fields above sm with a flex-basis, never a width', () => {
    const text = readFileSync(SOURCE, 'utf8');
    const inputs = text.split('\n').filter((l) => /<input[^>]*name="specs_(label|value)"/.test(l));
    expect(inputs).toHaveLength(2);
    for (const line of inputs) {
      expect(line, `${line.trim().slice(0, 60)}… must size itself above sm`).toMatch(/sm:flex-\[/);
      // `flex-none` is `flex: none` → `flex-basis: auto` → back to `.input`'s width. The exact
      // regression this file now exists to catch.
      expect(line, `${line.trim().slice(0, 60)}… uses flex-none, which defers to .input's width`)
        .not.toMatch(/sm:flex-none/);
      expect(line, `${line.trim().slice(0, 60)}… states a width, which .input overrules`)
        .not.toMatch(/sm:w-\[/);
    }
  });
});

/**
 * The מפרט field explains itself the same way on BOTH product forms.
 *
 * There are two renderers for one field — `seller/dashboard.astro` draws the ADD form on the
 * server, `scripts/dashboard/products.ts#specsEditorHtml` builds the EDIT form as a string in the
 * browser — and the hint the owner asked for in סשן ג׳ has to reach the second one, which is the
 * form a seller with a real catalogue actually lives in. Before this, the add form carried an
 * InfoTip and the edit form carried nothing at all: the same class the admin-parity memory names,
 * where the surface used more often gets the poorer copy.
 */
describe('the מפרט hint', () => {
  it('is rendered by both product forms', () => {
    const addForm = readFileSync(join(SRC, 'pages/seller/dashboard.astro'), 'utf8');
    const editForm = readFileSync(join(SRC, 'scripts/dashboard/products.ts'), 'utf8');
    for (const key of ['specsExamples', 'specsFilterHint']) {
      expect(addForm, `the add-product form must render ${key}`).toContain(key);
      expect(editForm, `specsEditorHtml must render ${key}`).toContain(key);
    }
  });

  /**
   * The wording states the rule `lib/product-facets.ts` actually implements, and the two halves it
   * gets wrong when written from memory are both here: a facet needs TWO products and up
   * (`MIN_PRODUCTS_PER_FACET`, not "over two"), and it needs their values to DIFFER
   * (`MIN_VALUES_PER_FACET` — two products both saying "חומר: עץ" open nothing, because every
   * product in view already matches). A copy pass that drops "בערכים שונים" turns the hint into a
   * promise the store page will not keep.
   */
  it('promises what the facet thresholds actually deliver', async () => {
    const facets = await import('../src/lib/product-facets.js');
    expect(facets.MIN_PRODUCTS_PER_FACET).toBe(2);
    expect(facets.MIN_VALUES_PER_FACET).toBe(2);
    const he = readFileSync(join(SRC, 'i18n/translations.ts'), 'utf8');
    const hint = /specsFilterHint:\s*'([^']*)'/.exec(he)?.[1] ?? '';
    expect(hint, 'the Hebrew hint was not found').not.toBe('');
    expect(hint, 'the hint must say the values have to differ').toContain('בערכים שונים');
  });
});
