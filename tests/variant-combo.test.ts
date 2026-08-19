import { describe, expect, it } from 'vitest';
import { isProductInStock, comboStockRows, isFullyPerCombo, sumComboOverrides, comboKey, remapComboKeys } from '../src/lib/variant-combo.js';

describe('isProductInStock', () => {
  it('for a non-variant product, reflects the flat stock field directly', () => {
    expect(isProductInStock(5, undefined, undefined)).toBe(true);
    expect(isProductInStock(0, undefined, undefined)).toBe(false);
  });

  it('is in stock when the shared pool covers a combo with no variantStock override', () => {
    const variants = [{ name: 'Size', options: ['S', 'M'] }];
    expect(isProductInStock(3, variants, {})).toBe(true);
  });

  it('is out of stock when the shared pool is empty and no combo has an override', () => {
    const variants = [{ name: 'Size', options: ['S', 'M'] }];
    expect(isProductInStock(0, variants, undefined)).toBe(false);
  });

  it('is in stock when the shared pool is empty but an overridden combo still has stock', () => {
    const variants = [{ name: 'Size', options: ['S', 'M'] }];
    expect(isProductInStock(0, variants, { 'Size=M': 4 })).toBe(true);
  });

  it('is out of stock when every combo is explicitly zeroed, even though the (now-unused) shared pool is nonzero', () => {
    const variants = [{ name: 'Size', options: ['S', 'M'] }];
    expect(isProductInStock(5, variants, { 'Size=S': 0, 'Size=M': 0 })).toBe(false);
  });
});

/**
 * `evenSplit` / `resolveVariantStockMap` were REMOVED, and their tests with them.
 *
 * They existed to turn a shared pool into a full per-combo map — a product with 10 units and a
 * colour dimension became `{red: 5, blue: 5}`, a breakdown the seller never gave. A seller holding
 * 8 red and 2 blue then had the 6th red sale refused on stock that existed, and three blue sold
 * that did not. `variantStock` is partial by design; the replacements below read that partial map
 * instead of completing it.
 */
describe('comboStockRows — a partial map is an answer, not a gap', () => {
  const variants = [{ name: 'Size', options: ['S', 'M'] }];
  const S = comboKey({ Size: 'S' });
  const M = comboKey({ Size: 'M' });

  it('marks every combo as pooled when nothing has been counted, and invents no per-combo number', () => {
    const rows = comboStockRows(variants, undefined, 10);
    expect(rows.map((r) => r.shared)).toEqual([true, true]);
    expect(rows.map((r) => r.override)).toEqual([undefined, undefined]);
    // Both read the SAME pool — 10 units in total, not 10 each and not 5 each.
    expect(rows.map((r) => r.effective)).toEqual([10, 10]);
  });

  it('leaves an uncounted combo on the pool while its sibling has a bucket', () => {
    const rows = comboStockRows(variants, { [M]: 4 }, 7);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey[M]!.override).toBe(4);
    expect(byKey[M]!.shared).toBe(false);
    // Previously this became an explicit 0 — the combo silently went out of stock.
    expect(byKey[S]!.override).toBeUndefined();
    expect(byKey[S]!.shared).toBe(true);
    expect(byKey[S]!.effective).toBe(7);
  });

  it('ignores a stale key for a combo that no longer exists', () => {
    const rows = comboStockRows(variants, { [S]: 7, 'Color=Red': 3 }, 0);
    expect(rows.map((r) => r.key).sort()).toEqual([M, S].sort());
  });

  it('reports an explicit zero as a real bucket, not as "uncounted"', () => {
    const rows = comboStockRows(variants, { [S]: 0 }, 9);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    // 0 means sold out, and must not fall through to the pool's 9.
    expect(byKey[S]!.shared).toBe(false);
    expect(byKey[S]!.effective).toBe(0);
  });
});

describe('isFullyPerCombo / sumComboOverrides — when the pool stops mattering', () => {
  const variants = [{ name: 'Size', options: ['S', 'M'] }];
  const S = comboKey({ Size: 'S' });
  const M = comboKey({ Size: 'M' });

  it('is false while any combo still draws on the pool', () => {
    expect(isFullyPerCombo(variants, undefined)).toBe(false);
    expect(isFullyPerCombo(variants, { [M]: 4 })).toBe(false);
  });

  it('is true only once every combo carries its own bucket', () => {
    expect(isFullyPerCombo(variants, { [S]: 1, [M]: 4 })).toBe(true);
  });

  it('is false for a product with no variants at all — there is nothing to be per-combo about', () => {
    expect(isFullyPerCombo([], { [S]: 1 })).toBe(false);
  });

  it('sums the buckets and never folds the shared pool in', () => {
    expect(sumComboOverrides({ [S]: 1, [M]: 4 })).toBe(5);
    expect(sumComboOverrides(undefined)).toBe(0);
  });
});

describe('remapComboKeys — a relabelled dimension is not a new product', () => {
  const before = [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }];

  it('follows a renamed dimension through every combo', () => {
    const after = [{ name: 'Color', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }];
    const map = remapComboKeys(before, after);
    expect(map.size).toBe(4);
    expect(map.get(comboKey({ צבע: 'אדום', מידה: 'S' }))).toBe(comboKey({ Color: 'אדום', מידה: 'S' }));
  });

  it('follows a relabelled VALUE too — the colour picker appends an exact hex', () => {
    const after = [{ name: 'צבע', options: ['אדום #ff0000', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }];
    const map = remapComboKeys(before, after);
    expect(map.get(comboKey({ צבע: 'אדום', מידה: 'S' }))).toBe(comboKey({ צבע: 'אדום #ff0000', מידה: 'S' }));
    // The combos that did not move are absent rather than mapped to themselves — a caller keeps
    // its own key when the map has no entry, so an identity entry would say nothing.
    expect(map.has(comboKey({ צבע: 'כחול', מידה: 'L' }))).toBe(false);
  });

  it('refuses anything that is not a relabel — a moved count is worse than a lost one', () => {
    // An option added: the slots no longer line up, so nothing is claimed to correspond.
    expect(remapComboKeys(before, [before[0]!, { name: 'מידה', options: ['S', 'M', 'L'] }]).size).toBe(0);
    // A dimension removed.
    expect(remapComboKeys(before, [before[0]!]).size).toBe(0);
    // A dimension added.
    expect(remapComboKeys(before, [...before, { name: 'חומר', options: ['עץ'] }]).size).toBe(0);
    // Nothing to remap from.
    expect(remapComboKeys(undefined, before).size).toBe(0);
  });

  it('is empty when nothing was relabelled at all', () => {
    expect(remapComboKeys(before, [...before]).size).toBe(0);
  });
});
