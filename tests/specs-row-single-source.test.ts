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
});
