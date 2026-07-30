import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProductVisible } from '../src/lib/store-products.js';
import type { StoreProduct } from '../src/lib/store-products.js';

/**
 * "Is this product on the storefront?" has exactly one answer, and it lives in
 * `isProductVisible` (store-products.ts).
 *
 * The rule is currently `!blocked && !hidden`, which is short enough that call sites keep
 * re-typing it inline instead of importing it — and while the two spellings agree, nothing
 * signals that they are the same rule. They feed different things: the storefront listing, the
 * store-readiness gate that decides whether a store is indexed at all, the boost picker that
 * decides which products a seller may spend money advertising, and the baseline card that tells
 * a seller whether the platform is advertising him. The day the rule gains a condition — a draft
 * state, a product with no price, an unapproved image — whichever copies were missed keep
 * answering the old question, and the surfaces disagree silently. Two of them are money.
 *
 * This is the same shape as the safe-redirect and email-address guards: extract the rule, then
 * make it mechanically hard to hand-roll again.
 *
 * When this fails, import `isProductVisible` instead of inlining the check. Add to the allowlist
 * only with a reason written beside the entry.
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** The rule's own definition, and the public listing helper built directly on it. */
const ALLOWED = new Set(['lib/store-products.ts']);

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/** Both orderings, `.` and `?.`, and either spacing — the shapes actually found in the tree. */
const INLINE_RULE = /![a-zA-Z_$][\w$]*\??\.(?:hidden|blocked)\s*&&\s*![a-zA-Z_$][\w$]*\??\.(?:blocked|hidden)/;

describe('product visibility is defined once', () => {
  it('nobody hand-rolls `!p.hidden && !p.blocked` outside store-products.ts', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR, ['.ts', '.astro'])) {
      const rel = file.slice(SRC_DIR.length);
      if (ALLOWED.has(rel)) continue;
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (INLINE_RULE.test(line)) offenders.push(`${rel}:${i + 1}`);
      }
    }
    expect(offenders, `Import isProductVisible instead of inlining the rule:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('still answers what the inlined copies answered — blocked or hidden is off the storefront', () => {
    const p = (over: Partial<StoreProduct>): StoreProduct => ({ id: 'p', storeId: 's', name: 'p', stock: 1, ...over }) as StoreProduct;
    expect(isProductVisible(p({}))).toBe(true);
    expect(isProductVisible(p({ hidden: true }))).toBe(false);
    expect(isProductVisible(p({ blocked: true }))).toBe(false);
    expect(isProductVisible(p({ hidden: true, blocked: true }))).toBe(false);
    // Out of stock is NOT invisible — it still has a page, and the boost picker layers its own
    // `stock > 0` on top (ad-campaign-input.ts). Folding it in here would take every sold-out
    // product out of the storefront.
    expect(isProductVisible(p({ stock: 0 }))).toBe(true);
  });
});
