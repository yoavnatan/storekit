import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sale strip's divider, and the one thing it must never be: a line with nothing on its far side.
 *
 * **Reported by the owner, 2026-08-15: "כשלא עושים אחוז על המבצע אז יש שם רק פס מפריד בלי שום דבר
 * לפניו".** The hairline that separates the percent figure from the copy was written on
 * `.store-sale__body` unconditionally, while the figure itself renders only when there IS a percent
 * — and the percent is optional by design. A store-wide sale can be pure announcement, and a strip
 * whose whole job is to carry a coupon code has no percent at all (the percent is what
 * `resolvePrice` applies to prices; a coupon deliberately does not touch them — see lib/coupons.ts).
 * So the ordinary case for this feature drew a border against the edge of the strip, plus a 13.6px
 * indent that nothing explained.
 *
 * Measured in a real browser before and after: with the figure the body reports a 1px inline-start
 * border and 13.6px padding; with the figure absent (storefront) or `[hidden]` (dashboard preview)
 * it reports 0px for both.
 *
 * The `[hidden]` half is why this is not just a `+` combinator. The storefront omits the element,
 * but the dashboard preview keeps it in the DOM and toggles `hidden` as the seller types
 * (scripts/dashboard/promotions.ts) — and an adjacent-sibling match does not care whether the
 * sibling is displayed. Without `:not([hidden])` the preview would keep showing the bare line the
 * storefront had stopped showing, which is the exact drift a preview exists to prevent.
 */

const CSS = readFileSync(join(process.cwd(), 'src/styles/utilities/utils.css'), 'utf8');
const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

describe('the sale strip divider is conditional on a visible figure', () => {
  it('the bare body rule carries no border and no indent', () => {
    expect(CSS).toMatch(/\.store-sale__body \{ min-width: 0; \}/);
  });

  it('the divider hangs off a percent figure that is present AND not hidden', () => {
    const rule = CSS.match(/\.store-sale__pct:not\(\[hidden\]\) \+ \.store-sale__body \{[\s\S]*?\n\}/)?.[0];
    expect(rule, 'the sibling-scoped divider rule is gone').toBeTruthy();
    expect(rule).toContain('border-inline-start');
    expect(rule).toContain('padding-inline-start');
  });

  it('no rule puts the divider back on the body unconditionally', () => {
    // A later `.store-sale__body { border-inline-start: … }` would win by source order and
    // silently restore the bug. Anchored at the start of a line so the sibling-scoped rule above —
    // whose selector also ENDS in `.store-sale__body` — is not mistaken for one.
    const unconditional = /(^|\n)\.store-sale__body\s*\{[^}]*border-inline-start/;
    expect(CSS).not.toMatch(unconditional);
  });
});

describe('the two renderers of the strip agree about the figure', () => {
  it('the storefront omits it when there is no percent', () => {
    // `{sale.percent && …}` — absent, not hidden.
    expect(read('components/StoreSaleBanner.astro')).toMatch(/\{sale\.percent && \(/);
  });

  it('the dashboard preview keeps it and hides it, which is what :not([hidden]) is for', () => {
    expect(read('components/dashboard/PromotionsPanel.astro')).toMatch(/id="sale-preview-pct"[^>]*hidden=/);
    expect(read('scripts/dashboard/promotions.ts')).toContain('pvPct.hidden = !(pct > 0)');
  });
});
