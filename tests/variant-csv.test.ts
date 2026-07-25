import { describe, expect, it } from 'vitest';
import { parseCsv, mapHeader, toRawRows, validateRows, CSV_FIELDS } from '../src/lib/csv-bulk.js';
import { mergeVariantGroups } from '../src/lib/variant-csv.js';
import { productsToCsv } from '../src/lib/store-products-bulk.js';
import { comboKey } from '../src/lib/variant-combo.js';
import type { StoreProduct } from '../src/lib/store-products.js';
import type { StoreCategory } from '../src/lib/store-categories.js';

// Field keys as the header — mapHeader accepts the bare key as an alias, and the sku label ('מק"ט')
// carries a raw double-quote that would need hand-quoting to join into a header row.
const header = CSV_FIELDS.map((f) => f.key);
const { map } = mapHeader(header);

// Columns: id, sku, name, price, stock, category, subcategory1, subcategory2, tags, description, group, variantColor, variantSize
function merge(csvBodies: string[], lang: 'he' | 'en' = 'he', existingIds = new Set<string>()) {
  const rows = parseCsv([header.join(','), ...csvBodies].join('\n'));
  const raw = toRawRows(rows, map);
  return mergeVariantGroups(validateRows(raw, existingIds), lang);
}

describe('mergeVariantGroups — grouping', () => {
  it('collapses three rows sharing a group into one create product with two dimensions, per-combo stock + sku', () => {
    const [product] = merge([
      ',SW-BL-L,Sweatshirt,129.9,5,,,,,,grp,כחול,L',
      ',SW-BL-S,Sweatshirt,129.9,8,,,,,,grp,כחול,S',
      ',SW-OR-L,Sweatshirt,129.9,3,,,,,,grp,כתום,L',
    ]);
    expect(product!.action).toBe('create');
    expect(product!.variantCount).toBe(3);
    expect(product!.lines).toEqual([2, 3, 4]);
    const input = product!.input!;
    expect(input.name).toBe('Sweatshirt');
    expect(input.variants).toEqual([
      { name: 'צבע', options: ['כחול', 'כתום'] },
      { name: 'מידה', options: ['L', 'S'] },
    ]);
    // Stock + sku keyed by comboKey; product-level stock is the total.
    const blL = comboKey({ צבע: 'כחול', מידה: 'L' });
    const orL = comboKey({ צבע: 'כתום', מידה: 'L' });
    expect(input.variantStock![blL]).toBe(5);
    expect(input.variantStock![orL]).toBe(3);
    expect(input.variantSku![blL]).toBe('SW-BL-L');
    expect(input.variantSku![orL]).toBe('SW-OR-L');
    expect(input.stock).toBe(16); // 5 + 8 + 3
  });

  it('leaves a standalone row (no group) untouched and passes it through as its own product', () => {
    const results = merge([
      ',,Plain product,49.9,10,,,,,,,,',
      ',C-1,Shirt,79,4,,,,,,g1,אדום,M',
      ',C-2,Shirt,79,6,,,,,,g1,כחול,M',
    ]);
    expect(results.length).toBe(2);
    expect(results[0]!.variantCount).toBeUndefined();
    expect(results[0]!.input!.name).toBe('Plain product');
    expect(results[1]!.variantCount).toBe(2);
  });

  it('supports a single-dimension (color-only) group', () => {
    const [product] = merge([
      ',R,Mug,20,3,,,,,,mugs,אדום,',
      ',B,Mug,20,7,,,,,,mugs,כחול,',
    ]);
    expect(product!.input!.variants).toEqual([{ name: 'צבע', options: ['אדום', 'כחול'] }]);
    expect(product!.input!.stock).toBe(10);
  });

  it('names the dimensions in English when lang is en', () => {
    const [product] = merge([
      ',X,Tee,30,1,,,,,,g,Blue,L',
      ',Y,Tee,30,1,,,,,,g,Blue,M',
    ], 'en');
    expect(product!.input!.variants!.map((v) => v.name)).toEqual(['Color', 'Size']);
  });

  it('preserves output order by first group appearance, interleaved with standalone rows', () => {
    const results = merge([
      ',,Alpha,10,1,,,,,,,,',
      ',b1,Beta,10,1,,,,,,gB,אדום,S',
      ',,Gamma,10,1,,,,,,,,',
      ',b2,Beta,10,1,,,,,,gB,אדום,M',
    ]);
    expect(results.map((r) => r.input?.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(results[1]!.variantCount).toBe(2);
  });
});

describe('mergeVariantGroups — updates', () => {
  it('marks a group whose rows carry a known id as an update to that product', () => {
    const [product] = merge([
      'p1,A,Item,10,2,,,,,,g,אדום,S',
      'p1,B,Item,10,4,,,,,,g,כחול,S',
    ], 'he', new Set(['p1']));
    expect(product!.action).toBe('update');
    expect(product!.id).toBe('p1');
  });
});

describe('mergeVariantGroups — validation', () => {
  it('rejects a group with a duplicate color+size combo', () => {
    const [product] = merge([
      ',A,Item,10,1,,,,,,g,אדום,S',
      ',B,Item,10,1,,,,,,g,אדום,S',
    ]);
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('variant-duplicate-combo');
  });

  it('rejects a group where a dimension is present on some rows but blank on others', () => {
    const [product] = merge([
      ',A,Item,10,1,,,,,,g,אדום,S',
      ',B,Item,10,1,,,,,,g,כחול,',
    ]);
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('variant-inconsistent-dimensions');
  });

  it('rejects a grouped row that has neither color nor size', () => {
    const [product] = merge([
      ',A,Item,10,1,,,,,,g,,',
      ',B,Item,10,1,,,,,,g,,',
    ]);
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('variant-missing-option');
  });

  it('rejects a group whose rows point at different existing ids', () => {
    const [product] = merge([
      'p1,A,Item,10,1,,,,,,g,אדום,S',
      'p2,B,Item,10,1,,,,,,g,כחול,S',
    ], 'he', new Set(['p1', 'p2']));
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('variant-group-mixed-id');
  });

  it('fails the whole group when any single row has a per-row error (e.g. bad price)', () => {
    const [product] = merge([
      ',A,Item,10,1,,,,,,g,אדום,S',
      ',B,Item,notaprice,1,,,,,,g,כחול,S',
    ]);
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('price-invalid');
    expect(product!.lines).toEqual([2, 3]);
  });

  it('flags a per-combo sku that collides with another combo in the same batch', () => {
    // DUP is claimed by the first group's row, then reused in the second group — a cross-product clash.
    const results = merge([
      ',DUP,Item,10,1,,,,,,g1,אדום,S',
      ',X,Item,10,1,,,,,,g1,כחול,S',
      ',DUP,Other,10,1,,,,,,g2,אדום,S',
      ',Y,Other,10,1,,,,,,g2,כחול,S',
    ]);
    expect(results[1]!.action).toBe('error'); // the group containing the duplicate DUP row
    expect(results[1]!.errors).toContain('sku-duplicate');
  });
});

describe('productsToCsv variant round trip', () => {
  const categories: StoreCategory[] = [
    { id: 'c1', storeId: 's1', name: 'Clothing', parentId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  it('expands a color/size product to one row per combo and re-imports to the same variant matrix', () => {
    const blL = comboKey({ צבע: 'כחול', מידה: 'L' });
    const blS = comboKey({ צבע: 'כחול', מידה: 'S' });
    const orL = comboKey({ צבע: 'כתום', מידה: 'L' });
    const product: StoreProduct = {
      id: 'p1', storeId: 's1', slug: 'sweatshirt', name: 'Sweatshirt', description: 'Warm',
      price: 129.9, stock: 16, categoryId: 'c1',
      variants: [{ name: 'צבע', options: ['כחול', 'כתום'] }, { name: 'מידה', options: ['L', 'S'] }],
      variantStock: { [blL]: 5, [blS]: 8, [orL]: 3 },
      variantSku: { [blL]: 'SW-BL-L', [blS]: 'SW-BL-S', [orL]: 'SW-OR-L' },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const csv = productsToCsv([product], categories, 'he');
    const rows = parseCsv(csv);
    // Only combos with stock in generateCombos order — 4 combos (2×2), all present.
    expect(rows.length - 1).toBe(4); // header excluded
    const merged = mergeVariantGroups(validateRows(toRawRows(rows, map), new Set(['p1'])), 'he');
    expect(merged.length).toBe(1);
    const input = merged[0]!.input!;
    expect(merged[0]!.action).toBe('update');
    expect(input.variantSku![blL]).toBe('SW-BL-L');
    expect(input.variantStock![orL]).toBe(3);
    expect(input.variants).toEqual(product.variants);
  });

  it('exports a product with a non-color/size dimension as a single flat row (no variant columns)', () => {
    const product: StoreProduct = {
      id: 'p2', storeId: 's1', slug: 'table', name: 'Table', description: '', price: 500, stock: 2,
      variants: [{ name: 'חומר', options: ['עץ', 'מתכת'] }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const csv = productsToCsv([product], [], 'he');
    const rows = parseCsv(csv);
    expect(rows.length - 1).toBe(1);
    const [raw] = toRawRows(rows, map);
    expect(raw!.cells.group).toBeFalsy();
    expect(raw!.cells.variantColor).toBeFalsy();
  });
});
