import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSelection, comboKey } from '../src/lib/variant-combo.js';

/**
 * **A variant selection is buyer input, and it picks which stock bucket a sale comes out of.**
 *
 * Found in the 2026-08-12 inventory+checkout area audit. `api/checkout.ts` re-derives every other
 * field of a cart line on the server — the price from the product row, the quantity floored, the
 * slug resolved, visibility and store status gated — and passed `selectedVariants` from the request
 * body straight into `decrementStock`.
 *
 * That is an oversell, not a tidiness complaint, because "no bucket matched this key" is a
 * LEGITIMATE state down in `adjustStock`: it is how a combo the seller never counted separately
 * sells from the shared pool. An invented selection produces the same non-match, so it took the
 * same path. On a product whose combos are all counted, the shared pool IS the sum of the buckets
 * (`syncPooledStock`), so a hand-posted checkout with no selection at all bought against the total
 * — sale accepted, no real bucket moved, seller holding an order for stock they did not have, and
 * the next per-combo sale re-derived `p.stock` and erased the trace.
 *
 * So the rule this file holds: **a buyer-supplied selection reaches a stock adjustment only after
 * the product has recognised it.** The scan walks the tree rather than a list, so a second checkout
 * surface is covered on the day someone writes it.
 */

const ROOTS = ['src/lib', 'src/pages/api'];

function walk(dir: string): string[] {
  const abs = path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return entry.isFile() && /\.ts$/.test(entry.name) ? [rel] : [];
  });
}

/** Source with comments stripped — a rule quoted in a comment is documentation, not a violation. */
function code(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const SRC = new Map(ROOTS.flatMap(walk).map((f) => [f, code(f)]));

describe('a buyer-supplied variant selection is validated before it can move stock', () => {
  it('every module that decrements stock resolves the selection against the product first', () => {
    for (const [file, src] of SRC) {
      // The owner of the adjustment itself is where the buckets live, not a caller.
      if (file === 'src/lib/store-products.ts') continue;
      if (!/decrementStock\(/.test(src)) continue;
      expect(/resolveSelection\(/.test(src),
        `${file}: calls decrementStock() without resolveSelection() from lib/variant-combo.ts — a selection the product does not declare falls through to the shared pool, which on a fully-counted product is the SUM of every bucket, so the sale comes out of stock that is not for sale`,
      ).toBe(true);
    }
  });

  it('at least one module is actually covered by that scan', () => {
    // Without this, deleting the checkout would leave the guard above vacuously green.
    const callers = [...SRC].filter(([f, s]) => f !== 'src/lib/store-products.ts' && /decrementStock\(/.test(s));
    expect(callers.map(([f]) => f)).toContain('src/pages/api/checkout.ts');
  });

  /**
   * The READ side of the same rule. `getEffectiveStock` resolves a selection to a bucket exactly
   * as the decrement does, so a route that answers a buyer's question with it can quote the shared
   * pool as the ceiling for a combo that does not exist — a number belonging to nothing, handed to
   * the cart a moment before checkout refuses the line.
   */
  it('every module that answers a stock question about a buyer-named combo validates it too', () => {
    for (const [file, src] of SRC) {
      if (file === 'src/lib/store-products.ts') continue;
      if (!/getEffectiveStock\(/.test(src)) continue;
      expect(/resolveSelection\(/.test(src),
        `${file}: answers getEffectiveStock() for a caller-supplied selection without resolveSelection() from lib/variant-combo.ts — an unrecognised combo falls through to the shared pool and is quoted as that line's stock`,
      ).toBe(true);
    }
  });
});

describe('resolveSelection', () => {
  const DIMS = [
    { name: 'צבע', options: ['אדום', 'כחול'] },
    { name: 'מידה', options: ['S', 'M'] },
  ];

  it('accepts a selection naming every dimension with a declared option', () => {
    expect(resolveSelection(DIMS, { צבע: 'אדום', מידה: 'M' }))
      .toEqual({ ok: true, selection: { צבע: 'אדום', מידה: 'M' } });
  });

  it('refuses an option the dimension does not declare', () => {
    expect(resolveSelection(DIMS, { צבע: 'סגול', מידה: 'M' })).toEqual({ ok: false });
  });

  it('refuses a dimension the product does not declare', () => {
    expect(resolveSelection(DIMS, { צבע: 'אדום', חומר: 'כותנה' })).toEqual({ ok: false });
  });

  /**
   * The exact shape of the oversell. A product with variants sold with NO selection used to reach
   * the shared pool, which for a fully-counted product is the total of every bucket.
   */
  it('refuses a partial selection, and refuses none at all', () => {
    expect(resolveSelection(DIMS, { צבע: 'אדום' })).toEqual({ ok: false });
    expect(resolveSelection(DIMS, {})).toEqual({ ok: false });
    expect(resolveSelection(DIMS, undefined)).toEqual({ ok: false });
  });

  it('refuses a value that is not a string', () => {
    expect(resolveSelection(DIMS, { צבע: { toString: 'אדום' }, מידה: 'M' })).toEqual({ ok: false });
    expect(resolveSelection(DIMS, { צבע: ['אדום'], מידה: 'M' })).toEqual({ ok: false });
    expect(resolveSelection(DIMS, { צבע: null, מידה: 'M' })).toEqual({ ok: false });
  });

  it('refuses a selection on a product that declares no variants', () => {
    expect(resolveSelection(undefined, { צבע: 'אדום' })).toEqual({ ok: false });
    expect(resolveSelection([], { צבע: 'אדום' })).toEqual({ ok: false });
    expect(resolveSelection(undefined, undefined)).toEqual({ ok: true, selection: undefined });
  });

  /** Same rule `generateCombos` uses — a dimension with no name or no options is not a dimension. */
  it('ignores empty dimensions, exactly as combo expansion does', () => {
    const withEmpty = [...DIMS, { name: '', options: ['x'] }, { name: 'ריק', options: [] }];
    expect(resolveSelection(withEmpty, { צבע: 'כחול', מידה: 'S' }))
      .toEqual({ ok: true, selection: { צבע: 'כחול', מידה: 'S' } });
  });

  /**
   * Returning the product's own spelling is what keeps one combo from minting two `comboKey`s —
   * and a second key is a second bucket that no seller ever counted.
   */
  it('returns the declared strings, so stray whitespace cannot fork a combo key', () => {
    const resolved = resolveSelection(DIMS, { צבע: ' אדום ', מידה: 'M ' });
    expect(resolved).toEqual({ ok: true, selection: { צבע: 'אדום', מידה: 'M' } });
    expect(comboKey((resolved as { selection: Record<string, string> }).selection))
      .toBe(comboKey({ צבע: 'אדום', מידה: 'M' }));
  });
});
