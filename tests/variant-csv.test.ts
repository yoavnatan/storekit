import { describe, expect, it } from 'vitest';
import { parseCsv, mapHeader, toRawRows, validateRows, CSV_FIELDS } from '../src/lib/csv-bulk.js';
import { mergeVariantGroups } from '../src/lib/variant-csv.js';
import { productsToCsv } from '../src/lib/store-products-bulk.js';
import { comboKey } from '../src/lib/variant-combo.js';
import type { StoreProduct } from '../src/lib/store-products.js';
import type { StoreCategory } from '../src/lib/store-categories.js';

// Field keys as the header — mapHeader accepts the bare key as an alias, and the sku label ('מק"ט')
// carries a raw double-quote that would need hand-quoting to join into a header row.
const COLS = CSV_FIELDS.map((f) => f.key);
const { map } = mapHeader(COLS);

// Build a row by column key so tests stay readable across 17 columns (id, sku, name, price, stock,
// category, subcategory1/2, tags, description, group, option{1,2,3}Name/Value).
function row(cells: Partial<Record<string, string>>): string {
  return COLS.map((k) => cells[k] ?? '').join(',');
}

function merge(rows: string[], existingIds = new Set<string>()) {
  const parsed = parseCsv([COLS.join(','), ...rows].join('\n'));
  const raw = toRawRows(parsed, map);
  return mergeVariantGroups(validateRows(raw, existingIds));
}

describe('mergeVariantGroups — grouping', () => {
  it('collapses three rows sharing a group into one create product with two dimensions, per-combo stock + sku', () => {
    const [product] = merge([
      row({ sku: 'SW-BL-L', name: 'Sweatshirt', price: '129.9', stock: '5', group: 'grp', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'L' }),
      row({ sku: 'SW-BL-S', name: 'Sweatshirt', price: '129.9', stock: '8', group: 'grp', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'S' }),
      row({ sku: 'SW-OR-L', name: 'Sweatshirt', price: '129.9', stock: '3', group: 'grp', option1Name: 'צבע', option1Value: 'כתום', option2Name: 'מידה', option2Value: 'L' }),
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
      row({ name: 'Plain product', price: '49.9', stock: '10' }),
      row({ sku: 'C-1', name: 'Shirt', price: '79', stock: '4', group: 'g1', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'M' }),
      row({ sku: 'C-2', name: 'Shirt', price: '79', stock: '6', group: 'g1', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'M' }),
    ]);
    expect(results.length).toBe(2);
    expect(results[0]!.variantCount).toBeUndefined();
    expect(results[0]!.input!.name).toBe('Plain product');
    expect(results[1]!.variantCount).toBe(2);
  });

  it('supports a single-dimension group', () => {
    const [product] = merge([
      row({ sku: 'R', name: 'Mug', price: '20', stock: '3', group: 'mugs', option1Name: 'צבע', option1Value: 'אדום' }),
      row({ sku: 'B', name: 'Mug', price: '20', stock: '7', group: 'mugs', option1Name: 'צבע', option1Value: 'כחול' }),
    ]);
    expect(product!.input!.variants).toEqual([{ name: 'צבע', options: ['אדום', 'כחול'] }]);
    expect(product!.input!.stock).toBe(10);
  });

  it('takes the dimension name verbatim from the option-name column — any dimension, not just color/size', () => {
    const [product] = merge([
      row({ sku: 'T-W', name: 'Table', price: '450', stock: '4', group: 'tbl', option1Name: 'חומר', option1Value: 'עץ' }),
      row({ sku: 'T-M', name: 'Table', price: '450', stock: '2', group: 'tbl', option1Name: 'חומר', option1Value: 'מתכת' }),
    ]);
    expect(product!.input!.variants).toEqual([{ name: 'חומר', options: ['עץ', 'מתכת'] }]);
    expect(product!.input!.variantStock![comboKey({ חומר: 'עץ' })]).toBe(4);
  });

  it('supports three dimensions', () => {
    const [product] = merge([
      row({ sku: 'A', name: 'Shoe', price: '200', stock: '1', group: 'sh', option1Name: 'צבע', option1Value: 'שחור', option2Name: 'מידה', option2Value: '42', option3Name: 'רוחב', option3Value: 'רגיל' }),
    ]);
    expect(product!.input!.variants!.map((v) => v.name)).toEqual(['צבע', 'מידה', 'רוחב']);
  });

  it('preserves output order by first group appearance, interleaved with standalone rows', () => {
    const results = merge([
      row({ name: 'Alpha', price: '10', stock: '1' }),
      row({ sku: 'b1', name: 'Beta', price: '10', stock: '1', group: 'gB', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ name: 'Gamma', price: '10', stock: '1' }),
      row({ sku: 'b2', name: 'Beta', price: '10', stock: '1', group: 'gB', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'M' }),
    ]);
    expect(results.map((r) => r.input?.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(results[1]!.variantCount).toBe(2);
  });
});

describe('mergeVariantGroups — updates', () => {
  it('marks a group whose rows carry a known id as an update to that product', () => {
    const [product] = merge([
      row({ id: 'p1', sku: 'A', name: 'Item', price: '10', stock: '2', group: 'g', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ id: 'p1', sku: 'B', name: 'Item', price: '10', stock: '4', group: 'g', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'S' }),
    ], new Set(['p1']));
    expect(product!.action).toBe('update');
    expect(product!.id).toBe('p1');
  });
});

describe('mergeVariantGroups — validation', () => {
  it('rejects a group with a duplicate option combination', () => {
    const [product] = merge([
      row({ sku: 'A', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ sku: 'B', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
    ]);
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('variant-duplicate-combo');
  });

  it('rejects a group where one row declares a dimension the others omit', () => {
    const [product] = merge([
      row({ sku: 'A', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ sku: 'B', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'כחול' }),
    ]);
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('variant-inconsistent-dimensions');
  });

  it('rejects a grouped row with no option columns at all', () => {
    const [product] = merge([
      row({ sku: 'A', name: 'Item', price: '10', stock: '1', group: 'g' }),
      row({ sku: 'B', name: 'Item', price: '10', stock: '1', group: 'g' }),
    ]);
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('variant-missing-option');
  });

  it('rejects a grouped row whose option has a name but a blank value', () => {
    const [product] = merge([
      row({ sku: 'A', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'אדום' }),
      row({ sku: 'B', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: '' }),
    ]);
    expect(product!.action).toBe('error');
    // Second row has an option name with no value → missing-option (a half-filled dimension).
    expect(product!.errors.some((e) => e === 'variant-missing-option' || e === 'variant-inconsistent-dimensions')).toBe(true);
  });

  it('rejects a group whose rows point at different existing ids', () => {
    const [product] = merge([
      row({ id: 'p1', sku: 'A', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ id: 'p2', sku: 'B', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'S' }),
    ], new Set(['p1', 'p2']));
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('variant-group-mixed-id');
  });

  it('fails the whole group when any single row has a per-row error (e.g. bad price)', () => {
    const [product] = merge([
      row({ sku: 'A', name: 'Item', price: '10', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ sku: 'B', name: 'Item', price: 'notaprice', stock: '1', group: 'g', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'S' }),
    ]);
    expect(product!.action).toBe('error');
    expect(product!.errors).toContain('price-invalid');
    expect(product!.lines).toEqual([2, 3]);
  });

  it('flags a per-combo sku that collides with another combo in the same batch', () => {
    // DUP is claimed by the first group's row, then reused in the second group — a cross-product clash.
    const results = merge([
      row({ sku: 'DUP', name: 'Item', price: '10', stock: '1', group: 'g1', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ sku: 'X', name: 'Item', price: '10', stock: '1', group: 'g1', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'S' }),
      row({ sku: 'DUP', name: 'Other', price: '10', stock: '1', group: 'g2', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ sku: 'Y', name: 'Other', price: '10', stock: '1', group: 'g2', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'S' }),
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
    expect(rows.length - 1).toBe(4); // 2×2 combos, header excluded
    const merged = mergeVariantGroups(validateRows(toRawRows(rows, map), new Set(['p1'])));
    expect(merged.length).toBe(1);
    const input = merged[0]!.input!;
    expect(merged[0]!.action).toBe('update');
    expect(input.variantSku![blL]).toBe('SW-BL-L');
    expect(input.variantStock![orL]).toBe(3);
    expect(input.variants).toEqual(product.variants);
  });

  it('now expands a NON-color/size dimension (material) too, and round-trips it', () => {
    const wood = comboKey({ חומר: 'עץ' });
    const metal = comboKey({ חומר: 'מתכת' });
    const product: StoreProduct = {
      id: 'p2', storeId: 's1', slug: 'table', name: 'Table', description: '', price: 500, stock: 6,
      variants: [{ name: 'חומר', options: ['עץ', 'מתכת'] }],
      variantStock: { [wood]: 4, [metal]: 2 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const csv = productsToCsv([product], [], 'he');
    const rows = parseCsv(csv);
    expect(rows.length - 1).toBe(2); // one row per material, no longer a single flat row
    const merged = mergeVariantGroups(validateRows(toRawRows(rows, map), new Set(['p2'])));
    expect(merged.length).toBe(1);
    expect(merged[0]!.input!.variants).toEqual(product.variants);
    expect(merged[0]!.input!.variantStock![wood]).toBe(4);
  });

  it('exports a product with 4+ dimensions as a single flat row (can not fit three option pairs)', () => {
    const product: StoreProduct = {
      id: 'p3', storeId: 's1', slug: 'complex', name: 'Complex', description: '', price: 10, stock: 5,
      variants: [
        { name: 'צבע', options: ['אדום'] }, { name: 'מידה', options: ['S'] },
        { name: 'חומר', options: ['עץ'] }, { name: 'נפח', options: ['1L'] },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const csv = productsToCsv([product], [], 'he');
    const rows = parseCsv(csv);
    expect(rows.length - 1).toBe(1);
    const [raw] = toRawRows(rows, map);
    expect(raw!.cells.group).toBeFalsy();
    expect(raw!.cells.option1Name).toBeFalsy();
  });
});

/**
 * ── A product's own columns are stated ONCE, not on every combo (owner, 2026-09-08) ──
 *
 * *"בלתי אפשרי לערוך את זה, זה תוקע לחלוטין את המחשב באקסל, אז מה השימוש של זה בכלל?"* — on the
 * `סהר` showcase store the export was 112 products, 1,163 rows, and every one of those rows carried
 * the same name, price, category, tag list, sale price, weight and a description up to 360
 * characters long. 350KB of file for about 25KB of facts.
 *
 * It was worse than noise. `finalizeGroup` reads the shared fields from the group's FIRST row and
 * ignores the rest, so editing the price on row 5 of 12 changed nothing and reported nothing — a
 * silent no-op on a money column.
 *
 * Continuation rows are blank now, which is Shopify's own convention for the same file, and the
 * same store exports at 148KB. What each case below holds:
 *   · the export really does leave them blank, and keeps what identifies the row;
 *   · that file round-trips to the same product, which is the only thing that makes it safe;
 *   · a file with every value REPEATED — every export written before today, and every file a seller
 *     keeps in his own system — still imports identically, because the pass fills blanks and never
 *     overwrites;
 *   · a group never inherits from the product above it.
 */
describe('a variant group states the product once', () => {
  const cats = [{ id: 'c1', storeId: 's1', name: 'הנעלה', parentId: null, position: 0 }] as unknown as StoreCategory[];
  const shoe = {
    id: 'p9', storeId: 's1', slug: 'boot', name: 'מגף', description: 'תיאור ארוך מאוד',
    price: 559, stock: 30, categoryId: 'c1', tags: ['חורף'],
    variants: [{ name: 'מידה', options: ['37', '38'] }],
    variantStock: { [comboKey({ מידה: '37' })]: 20, [comboKey({ מידה: '38' })]: 10 },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as unknown as StoreProduct;

  /** The export's data rows, split on commas — every cell in these fixtures is comma-free. */
  const exported = (): string[][] =>
    productsToCsv([shoe], cats, 'he').split('\r\n').slice(1).map((l) => l.split(','));
  const at = (r: string[], key: (typeof COLS)[number]): string => r[COLS.indexOf(key)] ?? '';

  it('writes the shared columns on the first row and blanks them on the rest', () => {
    const [first, second] = exported();
    expect(at(first!, 'name')).toBe('מגף');
    expect(at(first!, 'price')).toBe('559');
    expect(at(first!, 'description')).toBe('תיאור ארוך מאוד');
    expect(at(first!, 'category')).toBe('הנעלה');

    for (const key of ['name', 'price', 'description', 'category', 'tags', 'weight', 'salePrice'] as const) {
      expect(at(second!, key), `${key} is repeated on a continuation row`).toBe('');
    }
    // What a continuation row is FOR — and the group label, which is what ties it to the row above.
    expect(at(second!, 'id')).toBe('p9');
    expect(at(second!, 'stock')).toBe('10');
    expect(at(second!, 'option1Value')).toBe('38');
    expect(at(second!, 'group')).toBe('מגף');
  });

  it('round-trips: the blank file imports back to the same product', () => {
    const csv = productsToCsv([shoe], cats, 'he');
    const merged = mergeVariantGroups(validateRows(toRawRows(parseCsv(csv), map), new Set(['p9'])));
    expect(merged.length).toBe(1);
    expect(merged[0]!.action).toBe('update');
    const input = merged[0]!.input!;
    expect(input.name).toBe('מגף');
    expect(input.price).toBe(559);
    expect(input.description).toBe('תיאור ארוך מאוד');
    expect(input.variantStock![comboKey({ מידה: '38' })]).toBe(10);
  });

  it('still accepts a file that repeats every value on every row', () => {
    // The compatibility case, and the reason the pass FILLS rather than sets: this is what every
    // export written before today looks like, and what a seller's own spreadsheet will keep looking
    // like. It must produce exactly what the blank form produces.
    const repeated = merge([
      row({ id: 'p9', name: 'מגף', price: '559', description: 'תיאור ארוך מאוד', category: 'הנעלה', stock: '20', group: 'מגף', option1Name: 'מידה', option1Value: '37' }),
      row({ id: 'p9', name: 'מגף', price: '559', description: 'תיאור ארוך מאוד', category: 'הנעלה', stock: '10', group: 'מגף', option1Name: 'מידה', option1Value: '38' }),
    ], new Set(['p9']));
    expect(repeated.length).toBe(1);
    expect(repeated[0]!.action).toBe('update');
    expect(repeated[0]!.input!.price).toBe(559);
    expect(repeated[0]!.input!.variantStock![comboKey({ מידה: '38' })]).toBe(10);
  });

  it('never inherits across two adjacent products', () => {
    // The failure this shape could have: a blank name on the first row of the SECOND group reading
    // as the first group's product. Two groups, and the second one's own values have to survive.
    const both = merge([
      row({ name: 'מגף', price: '559', stock: '20', group: 'a', option1Name: 'מידה', option1Value: '37' }),
      row({ stock: '10', group: 'a', option1Name: 'מידה', option1Value: '38' }),
      row({ name: 'סנדל', price: '199', stock: '4', group: 'b', option1Name: 'מידה', option1Value: '37' }),
      row({ stock: '6', group: 'b', option1Name: 'מידה', option1Value: '38' }),
    ]);
    expect(both.length).toBe(2);
    expect(both[0]!.input!.name).toBe('מגף');
    expect(both[0]!.input!.price).toBe(559);
    expect(both[1]!.input!.name).toBe('סנדל');
    expect(both[1]!.input!.price).toBe(199);
  });
});
