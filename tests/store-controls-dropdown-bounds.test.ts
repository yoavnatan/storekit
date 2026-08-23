/**
 * A DROPDOWN IN THE STORE'S CONTROL ROW MUST NOT BE ABLE TO LEAVE THE PAGE, and it must not
 * depend on where its trigger happens to sit for that.
 *
 * 2026-08-23, owner, on a category page: "כפתור הסינון נצמד להתחלה של העמוד + הדרופדאון יוצא
 * מגבולות העמוד". Two faults with one root. `.category-filters-wrap` is the row's `flex: 1 1 auto`
 * item and normally absorbs every spare pixel — but a LEAF category has no children to offer, the
 * wrap goes `display: none`, and the row then had nothing to hold the filter and sort buttons at
 * its end: both slid to the inline START. Measured at 1440 before the fix, the filter button moved
 * from x=230 to x=1218, and the 27rem menu hanging off it ran 210px past the viewport (350px at
 * 900 and at 768).
 *
 * Pinning the buttons back fixes the symptom. It does NOT fix the class: a menu anchored to its
 * own trigger is a width and a position that nothing reconciles, so the next layout change puts it
 * back outside the page. The owner asked for the guarantee, not the patch — "גם אם היה נשאר איפה
 * שהוא, הדרופדאון לא היה גולש מחוץ לעמוד". The guarantee is structural: make the ROW the
 * containing block and cap the menu at `100%` of it, and overflow stops being possible to express.
 *
 * That was already the ≤640px rule, written for a phone. The reasoning was never width-specific,
 * and keeping it behind a media query is exactly how the desktop case stayed open.
 *
 * These assertions read the stylesheet rather than a rendered page because the failure is a
 * missing declaration, not a wrong number — and because the rendered proof (a headless browser at
 * six widths) is not something the suite runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'src/styles/pages/store.css'), 'utf8')
  // Comments first: this file's own notes quote the declarations they are explaining.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The file with every at-rule block (`@media`, `@supports`, `@keyframes`) cut out, braces
 * balanced. Everything asserted below has to hold UNCONDITIONALLY — a guarantee that only exists
 * under `(max-width: 640px)` is the bug this file is about, so a rule found inside a media query
 * must not satisfy these tests.
 */
const UNCONDITIONAL = (() => {
  let out = '';
  let i = 0;
  while (i < CSS.length) {
    if (CSS[i] !== '@') { out += CSS[i]; i += 1; continue; }
    const open = CSS.indexOf('{', i);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    while (j < CSS.length) {
      if (CSS[j] === '{') depth += 1;
      else if (CSS[j] === '}' && --depth === 0) break;
      j += 1;
    }
    i = j + 1;
  }
  return out;
})();

/** The declaration block(s) of every unconditional rule whose selector list contains `selector`. */
function blocksFor(selector: string): string[] {
  const out: string[] = [];
  for (const [, sels, body] of UNCONDITIONAL.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sels.split(',').some((s) => s.trim() === selector)) out.push(body);
  }
  return out;
}

function decl(selector: string, prop: string): string | null {
  for (const body of blocksFor(selector)) {
    const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) return m[1].trim();
  }
  return null;
}

describe('the store control row keeps its dropdowns inside the page', () => {
  it('anchors the attribute menu to the ROW, not to its own trigger', () => {
    // The row is the containing block…
    expect(decl('.store-controls__row', 'position')).toBe('relative');
    // …because the trigger's wrapper deliberately is not one.
    expect(decl('.facet-dropdown-wrap', 'position')).toBe('static');
  });

  it('caps the attribute menu at the row it hangs from', () => {
    const maxW = decl('.facet-panel', 'max-width');
    expect(maxW).toBe('100%');
    // `100vw` measures the VIEWPORT, which is not the box the menu is positioned in — it let the
    // menu be wider than the row and start anywhere. Whatever this becomes, it must stay relative
    // to the containing block.
    expect(maxW).not.toMatch(/vw/);
  });

  it('lets the menu collapse below its comfortable width rather than overflow', () => {
    // `min-width` beats `max-width` in CSS, so an unclamped one re-opens the overflow on any row
    // narrower than it — which is every phone.
    const minW = decl('.facet-panel', 'min-width');
    expect(minW).toMatch(/min\(/);
    expect(minW).toMatch(/100%/);
  });

  it('holds the filter and sort buttons at the row end with no chip row to push them', () => {
    const pinned = blocksFor('.store-controls__row > .facet-dropdown-wrap')
      .concat(blocksFor('.store-controls__row > .sort-dropdown-wrap'));
    // One rule may carry both selectors, so assert on the union of what they set.
    const all = pinned.join(';');
    expect(all).toMatch(/margin-inline-start\s*:\s*auto/);

    // …and the two must not split the free space between them: whenever the filter is there, it
    // is the one that takes it, so the pair stays adjacent.
    const cancel = blocksFor('.store-controls__row > .facet-dropdown-wrap ~ .sort-dropdown-wrap').join(';');
    expect(cancel).toMatch(/margin-inline-start\s*:\s*0/);
  });

  it('does not re-state the anchoring inside the phone media query', () => {
    // Every assertion above already reads UNCONDITIONAL, so a rule hiding in a media query cannot
    // satisfy them. This one guards the other direction: a duplicate left behind at ≤640px is a
    // second place to change, and the last time these two disagreed the desktop copy was the one
    // that was missing.
    const phone = CSS.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(phone).not.toMatch(/\.facet-dropdown-wrap\s*\{[^}]*position/);
    expect(phone).not.toMatch(/\.store-controls__row\s*\{[^}]*position/);
  });
});
