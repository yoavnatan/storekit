/**
 * **No text a SHOPPER reads is smaller than 0.75rem.**
 *
 * **Where the number comes from, and it is not taste** (owner, 2026-08-25: *"גם אצל הקונים זה קצת
 * קטן... בעיקר על באדג׳ים ועל כרטיסיות של חנויות"*). Every font size on this site below 0.75rem
 * turned out to live in the seller dashboard or the admin — dense data tables read by someone
 * working, who is leaning in. The buyer-facing pages used none of them *by convention*, with four
 * exceptions nobody had noticed. So the complaint resolved to a rule the codebase was already
 * mostly following, and this file is what makes it a rule rather than a habit.
 *
 * **Measured, not assumed.** A browser pass over `/`, `/stores`, a store page, a product page and
 * `/pricing` collected the computed size of every visible leaf text node. Under 12px: 21 elements
 * in four rules — the pricing "best value" badge, the product card's sale badge, the category-chip
 * counts, and a set of small `TIME` stamps. Four more were invisible to that scan because their
 * container starts closed (the header search dropdown's section label and its "clear recents"), and
 * those are exactly the kind a rendered scan alone will keep missing — which is the second reason
 * this is a static test over the stylesheets rather than a screenshot diff.
 *
 * **The file list is NAMED, and `utilities/utils.css` is deliberately not in it.** That sheet is
 * shared: `.store-card__tag` sits in it beside `.notif-item__time` and the message-table headers,
 * so a size there cannot be judged by the file it is in. Its shopper-facing rules were fixed by
 * hand and are pinned by `tests/consent.test.ts` and the store-card pair's own comments instead. A
 * transitive "any CSS a buyer page imports" rule was the obvious alternative and is worse: it drags
 * in every shared sheet and turns this into an allowlist nobody maintains.
 *
 * **A failure is fixed by raising the size, never by adding a file to the exceptions.** If a
 * genuinely dense buyer surface ever needs smaller type, that is a design decision to take out
 * loud, in the sheet, with a comment — not a quiet entry here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Stylesheets whose every rule is read by a shopper. */
const BUYER_SHEETS = [
  'src/styles/pages/home.css',
  'src/styles/pages/store.css',
  'src/styles/pages/product.css',
  'src/styles/pages/search.css',
  'src/styles/components/store-card.css',
  'src/styles/components/product-card.css',
  'src/styles/components/cards.css',
  'src/styles/components/header.css',
  'src/styles/components/footer.css',
  'src/styles/components/cart-drawer.css',
];

/** 0.75rem = 12px at the default root size. */
const FLOOR_REM = 0.75;

describe('buyer-facing type never goes below 0.75rem', () => {
  it.each(BUYER_SHEETS)('%s', (sheet) => {
    const css = readFileSync(join(ROOT, sheet), 'utf8')
      // Comments out first — this rule is explained inside the very sheets it governs, and those
      // explanations quote the sizes being banned. The same trap bit three other guards in the
      // session that wrote this one.
      .replace(/\/\*[\s\S]*?\*\//g, ' ');

    const under: string[] = [];
    for (const m of css.matchAll(/font-size:\s*([\d.]+)rem/g)) {
      const rem = Number(m[1]);
      if (Number.isFinite(rem) && rem < FLOOR_REM) under.push(`${m[1]}rem`);
    }
    expect(
      under,
      `${sheet} sets type below the ${FLOOR_REM}rem shopper floor. Raise it — sizes under this `
      + 'belong to the dashboard and the admin, which are tables read by someone working.',
    ).toEqual([]);
  });

  it('the floor is stated where a reader of the CSS will meet it', () => {
    // A number enforced only by a test in another directory is a number the next person changes
    // without ever learning why it was that number.
    const cards = readFileSync(join(ROOT, 'src/styles/components/cards.css'), 'utf8');
    expect(cards, 'cards.css carries the note the other sheets point at').toContain('BUYER-FACING FLOOR');
  });
});
