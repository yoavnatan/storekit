/**
 * The overall `stock` of a variant product is the SUM of its per-combo buckets, never a second
 * number that can disagree with them.
 *
 * Three write paths set it, and until now they did not agree: `patch-variant-stock` persisted
 * `sum(buckets)`, while add-product and the full edit form took the submitted `stock` field
 * verbatim. The dashboard hides that by making the field read-only and live-summing it
 * (scripts/dashboard/products.ts#syncTotalStockField), so the divergence is invisible through the
 * UI and lands the moment anything posts without that script. A total that disagrees with its own
 * breakdown is not cosmetic: `countStockAlerts` and the low-stock badge read `stock`, and
 * `getEffectiveStock` falls back to it for any combo without a bucket of its own.
 *
 * The rule lives in `resolveTotalStock` (api/product.ts). It is module-private, so this pins it
 * through the arithmetic it has to satisfy plus a source check that the two call sites still use
 * it — a regression here is silent, and that is the whole reason the bug existed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { comboStockRows, isFullyPerCombo, sumComboOverrides, comboKey, generateCombos } from '../src/lib/variant-combo.js';

const ROUTE = resolve(process.cwd(), 'src/pages/api/product.ts');
const DIMS = [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }];
const RED_S = comboKey({ צבע: 'אדום', מידה: 'S' });

describe('resolveTotalStock — the total follows the buckets', () => {
  const source = readFileSync(ROUTE, 'utf8');

  it('is the rule both product-writing paths use, not a per-call-site expression', () => {
    expect(source.match(/stock: resolveTotalStock\(stock, variants, variantStock\)/g)).toHaveLength(2);
    // The old form must not come back on either path.
    expect(source).not.toContain('stock: isNaN(stock) ? 0 : stock');
  });

  it('no longer materialises a full per-combo map on the inline path', () => {
    // The even split is gone from every write path — this is the regression that would
    // reintroduce stock numbers the seller never entered.
    expect(source).not.toContain('resolveVariantStockMap');
  });
});

/**
 * The even split survived its own deletion once already.
 *
 * `seller/dashboard.astro` held a PRIVATE `evenSplit` — same arithmetic, its own copy, invisible to
 * the library — so removing it from lib/variant-combo.ts left the server-rendered edit rows still
 * seeding fabricated per-combo numbers while every test stayed green. The rule now has one home,
 * and this is what stops a second one appearing: it greps the source rather than any module's
 * exports, because a private copy is exactly what an export check cannot see.
 */
describe('the split has one home and no private copies', () => {
  const OWNERS = [
    'src/pages/seller/dashboard.astro',
    'src/scripts/dashboard/products.ts',
    'src/pages/api/product.ts',
    'src/lib/variant-combo.ts',
  ];

  it('defines no local evenSplit anywhere that renders or saves per-combo stock', () => {
    for (const file of OWNERS) {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(text, `${file} declares its own split`).not.toMatch(/function evenSplit\b/);
    }
  });

  it('leaves no caller of the removed helpers behind', () => {
    for (const file of OWNERS) {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(text, `${file} still calls evenSplit`).not.toMatch(/\bevenSplit\s*\(/);
    }
  });
});

describe('typing a total, then adding variants — nothing is invented and nothing is lost', () => {
  it('keeps all four combos on the one pool the seller actually typed', () => {
    const rows = comboStockRows(DIMS, undefined, 10);
    expect(rows).toHaveLength(4);
    // Not 2/3/3/2 and not four independent 10s: one pool of 10 that any combo can sell from.
    expect(rows.every((r) => r.shared && r.override === undefined && r.effective === 10)).toBe(true);
  });

  it('leaves the overall stock as the seller typed it while any combo is uncounted', () => {
    expect(isFullyPerCombo(DIMS, undefined)).toBe(false);
    expect(isFullyPerCombo(DIMS, { [RED_S]: 7 })).toBe(false);
  });

  it('counting one combo does not silently zero the other three', () => {
    const rows = comboStockRows(DIMS, { [RED_S]: 7 }, 3);
    const counted = rows.filter((r) => !r.shared);
    expect(counted).toHaveLength(1);
    expect(counted[0]!.override).toBe(7);
    // The remaining three still sell — from the pool of 3, together.
    expect(rows.filter((r) => r.shared).every((r) => r.effective === 3)).toBe(true);
  });

  it('switches the overall number to the sum only when every combo has been counted', () => {
    const full: Record<string, number> = {};
    generateCombos(DIMS).forEach((c, i) => { full[comboKey(c)] = i + 1; });
    expect(isFullyPerCombo(DIMS, full)).toBe(true);
    expect(sumComboOverrides(full)).toBe(1 + 2 + 3 + 4);
  });

  it('covers every generated combination, so no selection is left unrepresented', () => {
    const keys = new Set(comboStockRows(DIMS, undefined, 8).map((r) => r.key));
    for (const combo of generateCombos(DIMS)) expect(keys.has(comboKey(combo))).toBe(true);
  });
});
