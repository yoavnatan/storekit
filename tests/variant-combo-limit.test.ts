/**
 * The cartesian product is exponential in the number of dimensions while the payload describing it
 * is linear — so the bound has to be checked BEFORE anything expands, at every gate that accepts
 * variant dimensions from outside.
 *
 * Found 2026-08-06 while auditing the ad feed. Not a feed bug: `parseVariantsPayload` called
 * `generateCombos` to build its set of valid combo keys, so three dimensions of fifty options —
 * a few kilobytes of JSON — allocated 125,000 objects and 125,000 sorted key strings on the request
 * thread before any validation could reject them. The product form is authenticated, so this is not
 * an anonymous DoS; it is one seller (or one stolen session) able to stall SSR for every shopper on
 * the platform, which the "breaks at 1000 sellers?" rule treats the same way.
 *
 * The gates are the whole defence: everything downstream — storefront, dashboard, feed — expands
 * what is STORED, and is correct to do so only because nothing over the limit can be stored.
 */
import { describe, expect, it } from 'vitest';
import { comboCount, exceedsComboLimit, generateCombos, MAX_VARIANT_COMBOS } from '../src/lib/variant-combo.js';
import { parseVariantsPayload } from '../src/lib/product-form.js';
import { mergeVariantGroups } from '../src/lib/variant-csv.js';

function dims(shape: number[]): Array<{ name: string; options: string[] }> {
  return shape.map((n, i) => ({ name: `d${i}`, options: Array.from({ length: n }, (_, j) => `o${j}`) }));
}

describe('comboCount counts without building', () => {
  it('agrees with generateCombos on every shape small enough to build', () => {
    for (const shape of [[], [1], [3], [2, 2], [3, 4], [2, 3, 5], [1, 7]]) {
      expect(comboCount(dims(shape))).toBe(generateCombos(dims(shape)).length);
    }
  });

  it('skips a dimension with no options, exactly as generateCombos does', () => {
    const withEmpty = [{ name: 'a', options: ['x', 'y'] }, { name: 'b', options: [] }];
    expect(comboCount(withEmpty)).toBe(2);
    expect(generateCombos(withEmpty)).toHaveLength(2);
  });

  it('answers for a shape far too large to build, without building it', () => {
    // The point of the whole helper: this returns instantly where generateCombos would allocate
    // 10^40 objects.
    expect(comboCount(dims(Array(40).fill(10)))).toBeGreaterThan(MAX_VARIANT_COMBOS);
    expect(exceedsComboLimit(dims(Array(40).fill(10)))).toBe(true);
  });

  it('is exact at the boundary — the limit itself is allowed, one more is not', () => {
    expect(exceedsComboLimit(dims([MAX_VARIANT_COMBOS]))).toBe(false);
    expect(exceedsComboLimit(dims([MAX_VARIANT_COMBOS + 1]))).toBe(true);
  });
});

describe('the product form gate', () => {
  function form(variants: unknown): FormData {
    const f = new FormData();
    f.set('variants_json', JSON.stringify({ variants, variantStock: {}, variantImages: {} }));
    return f;
  }

  it('accepts a realistic catalogue product', () => {
    const out = parseVariantsPayload(form(dims([5, 8])));
    expect(out.error).toBeUndefined();
    expect(out.variants).toHaveLength(2);
  });

  it('REJECTS an over-limit payload rather than storing a truncated one', () => {
    // Storing a bounded-but-different variant set would silently change what the seller sells.
    const out = parseVariantsPayload(form(dims([50, 50, 50])));
    expect(out.error).toBeTruthy();
    expect(out.variants).toEqual([]);
  });

  it('rejects it FAST — the check happens before the expansion, not after', () => {
    // A regression that moved the check below `generateCombos` would still return the error and
    // still pass the assertion above, while taking minutes and gigabytes to do it. 1,000 dimensions
    // of 10 options is 10^1000 combos: anything that tries to build them does not return at all.
    const started = process.hrtime.bigint();
    expect(parseVariantsPayload(form(dims(Array(1000).fill(10)))).error).toBeTruthy();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(1000);
  });

  it('is not fooled by dimensions that are individually small', () => {
    // Eight two-option dimensions is 256 — no single number in the payload looks unusual.
    expect(parseVariantsPayload(form(dims(Array(8).fill(2)))).error).toBeTruthy();
    expect(parseVariantsPayload(form(dims(Array(7).fill(2)))).error).toBeUndefined();
  });
});

describe('the CSV importer gate', () => {
  // A file has one row per combination, which makes the group look self-limiting — and it is not:
  // the dimensions are the UNION of every row's options, so few rows can declare many combos.
  function row(line: number, options: Array<{ name: string; value: string }>) {
    return {
      line, action: 'create' as const, group: 'G', errors: [],
      input: { name: 'מוצר', price: 10, variantOptions: options },
    } as unknown as Parameters<typeof mergeVariantGroups>[0][number];
  }

  it('rejects a group whose option values imply more combinations than the limit', () => {
    // 3 dimensions × 20 distinct values each = 8,000 combos, declared by 20 lines.
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 2, [
      { name: 'צבע', value: `c${i}` },
      { name: 'מידה', value: `s${i}` },
      { name: 'חומר', value: `m${i}` },
    ]));
    const merged = mergeVariantGroups(rows)[0]!;
    expect(merged.action).toBe('error');
    expect(merged.errors).toContain('variant-too-many-combos');
  });

  it('accepts an ordinary grouped upload', () => {
    const rows = [
      row(2, [{ name: 'צבע', value: 'אדום' }, { name: 'מידה', value: 'S' }]),
      row(3, [{ name: 'צבע', value: 'אדום' }, { name: 'מידה', value: 'M' }]),
      row(4, [{ name: 'צבע', value: 'כחול' }, { name: 'מידה', value: 'S' }]),
      row(5, [{ name: 'צבע', value: 'כחול' }, { name: 'מידה', value: 'M' }]),
    ];
    expect(mergeVariantGroups(rows)[0]!.action).not.toBe('error');
  });
});
