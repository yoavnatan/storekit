import { describe, expect, it } from 'vitest';
import { parseCsv, mapHeader, toRawRows, validateRows, templateCsv, CSV_FIELDS } from '../src/lib/csv-bulk.js';
import { mergeVariantGroups } from '../src/lib/variant-csv.js';
import { productsToCsv, productsToFeedJson } from '../src/lib/store-products-bulk.js';
import type { StoreProduct } from '../src/lib/store-products.js';
import type { StoreCategory } from '../src/lib/store-categories.js';

describe('parseCsv', () => {
  it('parses plain comma-separated rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quoted fields with embedded commas and newlines', () => {
    const csv = 'name,desc\n"Widget, deluxe","Line one\nLine two"';
    expect(parseCsv(csv)).toEqual([['name', 'desc'], ['Widget, deluxe', 'Line one\nLine two']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']]);
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('mapHeader', () => {
  it('recognizes Hebrew headers', () => {
    const { map, missing } = mapHeader(['מזהה (אל תשנה/תמחקי)', 'מק"ט', 'שם *', 'מחיר *', 'מלאי']);
    expect(missing).toEqual([]);
    expect(map.get(1)).toBe('sku');
    expect(map.get(2)).toBe('name');
    expect(map.get(3)).toBe('price');
  });

  it('recognizes English headers regardless of current UI language', () => {
    const { map, missing } = mapHeader(['ID (do not edit/remove)', 'SKU', 'Name *', 'Price *']);
    expect(missing).toEqual([]);
    expect(map.get(1)).toBe('sku');
    expect(map.get(2)).toBe('name');
  });

  it('flags missing required columns', () => {
    const { missing } = mapHeader(['ID (do not edit/remove)', 'Stock']);
    expect(missing).toEqual(['name', 'price']);
  });
});

describe('line numbers stay accurate across blank lines', () => {
  it('reports the true file line for a row after a blank line, not a post-filter index', () => {
    const header = CSV_FIELDS.map((f) => f.key).join(',');
    // line 1 = header, line 2 = blank, line 3 = the real (invalid) row
    const csv = [header, '', ',,,bad-price,,,,'].join('\n');
    const rows = parseCsv(csv);
    const { map } = mapHeader(rows[0]!);
    const [raw] = toRawRows(rows, map);
    expect(raw.line).toBe(3);
  });
});

describe('toRawRows + validateRows', () => {
  // Field keys, not display labels — the sku label ('מק"ט') contains a raw
  // double-quote that would need proper CSV quoting to join into a header
  // row by hand; mapHeader already accepts the bare key as an alias, and
  // label-recognition itself is covered by the mapHeader describe block above.
  const header = CSV_FIELDS.map((f) => f.key);
  const { map } = mapHeader(header);
  const existingIds = new Set(['p1']);

  // Columns in fixture order: id, sku, name, price, stock, category, subcategory1, subcategory2, tags, description
  function rowsFrom(csvBody: string) {
    const rows = parseCsv([header.join(','), csvBody].join('\n'));
    return toRawRows(rows, map);
  }

  it('marks a row with no id as a create', () => {
    const [result] = validateRows(rowsFrom(',,New product,49.9,10,,,'), existingIds);
    expect(result).toMatchObject({ action: 'create', errors: [] });
    expect(result.input).toMatchObject({ name: 'New product', price: 49.9, stock: 10 });
  });

  it('marks a row with a known id as an update', () => {
    const [result] = validateRows(rowsFrom('p1,,Renamed,60,5,,,'), existingIds);
    expect(result).toMatchObject({ action: 'update', id: 'p1', errors: [] });
  });

  it('rejects an unknown id', () => {
    const [result] = validateRows(rowsFrom('ghost,,X,10,1,,,'), existingIds);
    expect(result.action).toBe('error');
    expect(result.errors).toContain('id-not-found');
  });

  it('rejects a missing name', () => {
    const [result] = validateRows(rowsFrom(',,,10,1,,,'), existingIds);
    expect(result.errors).toContain('name-required');
  });

  it('rejects a negative or non-numeric price', () => {
    const [neg] = validateRows(rowsFrom(',,X,-5,1,,,'), existingIds);
    expect(neg.errors).toContain('price-invalid');
    const [nan] = validateRows(rowsFrom(',,X,abc,1,,,'), existingIds);
    expect(nan.errors).toContain('price-invalid');
  });

  it('rejects a negative stock but leaves a blank stock cell as undefined ("no change" on update, 0 on create)', () => {
    const [neg] = validateRows(rowsFrom(',,X,10,-1,,,'), existingIds);
    expect(neg.errors).toContain('stock-invalid');
    const [empty] = validateRows(rowsFrom(',,X,10,,,,'), existingIds);
    expect(empty.input?.stock).toBeUndefined();
  });

  it('an update row with blank stock/category/tags/sku cells carries them as undefined, not overwritten values', () => {
    const [result] = validateRows(rowsFrom('p1,,Renamed,60,,,,,,'), existingIds);
    expect(result.action).toBe('update');
    expect(result.input).toMatchObject({ stock: undefined, categoryPath: undefined, tags: undefined, sku: undefined });
  });

  it('splits and normalizes tags', () => {
    const [result] = validateRows(rowsFrom(',,X,10,1,,,,"Red, BLUE ",'), existingIds);
    expect(result.input?.tags).toEqual(['red', 'blue']);
  });

  it('passes sku through as a plain field, not used to find/match the row', () => {
    const [result] = validateRows(rowsFrom(',NEW-SKU,X,10,1,,,'), existingIds);
    expect(result.action).toBe('create');
    expect(result.input?.sku).toBe('NEW-SKU');
  });

  it('rejects a row whose product name contains a blocklisted spam keyword', () => {
    const [result] = validateRows(rowsFrom(',,Online Casino Bonus,10,1,,,'), existingIds);
    expect(result.action).toBe('error');
    expect(result.errors).toContain('spam-keyword');
  });

  it('rejects a row whose tags column contains a blocklisted spam keyword', () => {
    const [result] = validateRows(rowsFrom(',,Legit product,10,1,,,,viagra,'), existingIds);
    expect(result.action).toBe('error');
    expect(result.errors).toContain('spam-keyword');
  });

  it('rejects a row whose tags column repeats the same word far beyond natural writing (keyword stuffing, distinct from the blocklist check)', () => {
    const [result] = validateRows(rowsFrom(',,Legit product,10,1,,,,"מילה מילה מילה מילה מילה מילה מילה מילה",'), existingIds);
    expect(result.action).toBe('error');
    expect(result.errors).toContain('keyword-stuffing');
  });
});

describe('validateRows sku-duplicate detection', () => {
  const header = CSV_FIELDS.map((f) => f.key);
  const { map } = mapHeader(header);
  const existingIds = new Set(['p1']);

  function rowsFrom(...csvBodies: string[]) {
    const rows = parseCsv([header.join(','), ...csvBodies].join('\n'));
    return toRawRows(rows, map);
  }

  it('rejects a create row whose sku already belongs to another existing product', () => {
    const existingSkuOwners = new Map([['W-1', 'p1']]);
    const [result] = validateRows(rowsFrom(',W-1,New Product,10,1,,,'), existingIds, existingSkuOwners);
    expect(result.action).toBe('error');
    expect(result.errors).toContain('sku-duplicate');
  });

  it('allows an update row to keep its own existing sku (no self-conflict)', () => {
    const existingSkuOwners = new Map([['W-1', 'p1']]);
    const [result] = validateRows(rowsFrom('p1,W-1,Renamed,10,1,,,'), existingIds, existingSkuOwners);
    expect(result.action).toBe('update');
    expect(result.errors).toEqual([]);
  });

  it('rejects an update row that steals another existing product\'s sku', () => {
    const existingSkuOwners = new Map([['W-1', 'other-product-id']]);
    const [result] = validateRows(rowsFrom('p1,W-1,Renamed,10,1,,,'), existingIds, existingSkuOwners);
    expect(result.action).toBe('error');
    expect(result.errors).toContain('sku-duplicate');
  });

  it('rejects the second of two rows in the same batch that both claim the same new sku', () => {
    const [first, second] = validateRows(rowsFrom(',DUP-1,Row A,10,1,,,', ',DUP-1,Row B,10,1,,,'), existingIds);
    expect(first.action).toBe('create');
    expect(second.action).toBe('error');
    expect(second.errors).toContain('sku-duplicate');
  });

  it('does not flag two rows with no sku at all as conflicting', () => {
    const results = validateRows(rowsFrom(',,Row A,10,1,,,', ',,Row B,10,1,,,'), existingIds);
    expect(results.every((r) => r.action !== 'error')).toBe(true);
  });
});

describe('productsToCsv formula-injection sanitization', () => {
  it('prefixes a name/description/category/tags/sku cell starting with =, +, -, @, tab or CR with a quote', () => {
    const categories: StoreCategory[] = [{
      id: 'c1', storeId: 's1', name: '@SUM(A1)', parentId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const products: StoreProduct[] = [{
      id: 'p1', storeId: 's1', slug: 'x', name: '=HYPERLINK("http://evil.example")',
      description: '+cmd', price: 1, stock: 1, categoryId: 'c1', tags: ['-danger'], sku: '=BAD',
      createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const csv = productsToCsv(products, categories, 'en');
    const rows = parseCsv(csv);
    const { map } = mapHeader(rows[0]!);
    const [raw] = toRawRows(rows, map);
    expect(raw.cells.name).toBe("'=HYPERLINK(\"http://evil.example\")");
    expect(raw.cells.description).toBe("'+cmd");
    expect(raw.cells.category).toBe("'@SUM(A1)");
    expect(raw.cells.tags).toBe("'-danger");
    expect(raw.cells.sku).toBe("'=BAD");
  });

  it('leaves an ordinary cell untouched', () => {
    const products: StoreProduct[] = [{
      id: 'p1', storeId: 's1', slug: 'x', name: 'Widget', description: '', price: 1, stock: 1, createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const csv = productsToCsv(products, [], 'en');
    expect(csv).toContain('Widget');
    expect(csv).not.toContain("'Widget");
  });
});

describe('templateCsv', () => {
  it('produces a header + example rows (one standalone + a color/size group + a material group) that all validate cleanly (both languages)', () => {
    for (const lang of ['he', 'en'] as const) {
      const rows = parseCsv(templateCsv(lang));
      expect(rows.length).toBe(7); // header + standalone + 3 sweatshirt rows + 2 table rows
      const { map, missing } = mapHeader(rows[0]!);
      expect(missing).toEqual([]);
      const raw = toRawRows(rows, map);
      expect(raw.length).toBe(6);
      const results = validateRows(raw, new Set());
      expect(results.every((r) => r.action === 'create' && r.errors.length === 0)).toBe(true);
      // The five variant rows carry a group value across two distinct groups; the standalone one has none.
      const groups = results.map((r) => r.group).filter(Boolean);
      expect(groups.length).toBe(5);
      expect(new Set(groups).size).toBe(2);
      expect(results[0]!.group).toBeUndefined();
      // End-to-end: the two groups assemble into valid variant products — including the material
      // group, proving the format is not limited to color/size.
      const merged = mergeVariantGroups(results);
      expect(merged.every((r) => r.action !== 'error')).toBe(true);
      const material = lang === 'he' ? 'חומר' : 'Material';
      expect(merged.some((r) => r.input?.variants?.some((v) => v.name === material))).toBe(true);
    }
  });
});

describe('productsToFeedJson (outbound feed)', () => {
  const categories: StoreCategory[] = [
    { id: 'c1', storeId: 's1', name: 'Clothing', parentId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c2', storeId: 's1', name: 'Men', parentId: 'c1', order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  it('serializes a plain product with a nested category path and current stock', () => {
    const products: StoreProduct[] = [{
      id: 'p1', storeId: 's1', slug: 'shirt', name: 'Shirt', description: 'nice', price: 49.9, stock: 7,
      categoryId: 'c2', tags: ['summer'], sku: 'SH-1', createdAt: '2026-01-01T00:00:00.000Z',
    }];
    expect(productsToFeedJson(products, categories)).toEqual([{
      id: 'p1', sku: 'SH-1', name: 'Shirt', price: 49.9, stock: 7,
      categoryPath: ['Clothing', 'Men'], tags: ['summer'], description: 'nice',
    }]);
  });

  it('includes the variant matrix (options + per-combo stock/sku) when present', () => {
    const products: StoreProduct[] = [{
      id: 'p2', storeId: 's1', slug: 'tee', name: 'Tee', description: '', price: 30, stock: 5,
      variants: [{ name: 'צבע', options: ['כחול'] }],
      variantStock: { 'צבע:כחול': 5 }, variantSku: { 'צבע:כחול': 'TEE-BL' },
      createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const [json] = productsToFeedJson(products, categories);
    expect(json!.variants).toEqual([{ name: 'צבע', options: ['כחול'], stock: { 'צבע:כחול': 5 }, sku: { 'צבע:כחול': 'TEE-BL' } }]);
  });
});
describe('productsToCsv round trip', () => {
  it('re-parses to the same field values, including tags with embedded commas and sku', () => {
    const categories: StoreCategory[] = [{
      id: 'c1', storeId: 's1', name: 'Tools', parentId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const products: StoreProduct[] = [{
      id: 'p1', storeId: 's1', slug: 'widget', name: 'Widget',
      description: 'A great, useful widget', price: 49.9, stock: 3,
      categoryId: 'c1', tags: ['sale', 'new'], sku: 'W-1', createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const csv = productsToCsv(products, categories, 'en');
    const rows = parseCsv(csv);
    const { map } = mapHeader(rows[0]!);
    const [raw] = toRawRows(rows, map);
    expect(raw.cells.name).toBe('Widget');
    expect(raw.cells.price).toBe('49.9');
    expect(raw.cells.stock).toBe('3');
    expect(raw.cells.description).toBe('A great, useful widget');
    expect(raw.cells.tags).toBe('sale, new');
    expect(raw.cells.sku).toBe('W-1');
  });
});
