import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreProduct } from '../src/lib/store-products.js';
import type { StoreCategory } from '../src/lib/store-categories.js';
import { comboKey } from '../src/lib/variant-combo.js';

let db: StoreProduct[] = [];
let categoriesDb: StoreCategory[] = [];
// Route reads/writes by path so the products / categories / notifications stores don't collide.
vi.mock('node:fs', () => ({
  default: {
    readFileSync: (p: string) =>
      JSON.stringify(String(p).includes('categor') ? categoriesDb : String(p).includes('notification') ? [] : db),
    writeFileSync: (p: string, data: string) => {
      if (String(p).includes('categor')) categoriesDb = JSON.parse(data);
      else if (!String(p).includes('notification')) db = JSON.parse(data);
    },
  },
}));

const { CSV_FIELDS } = await import('../src/lib/csv-bulk.js');
const { productsToCsv } = await import('../src/lib/store-products-bulk.js');
const { runProductImport } = await import('../src/lib/store-products-import.js');

const COLS = CSV_FIELDS.map((f) => f.key);
const row = (cells: Partial<Record<string, string>>): string => COLS.map((k) => cells[k] ?? '').join(',');

// A 2×2 (colour × size) variant product → four combos.
function seedVariantProduct(): StoreProduct {
  const vs: Record<string, number> = {};
  const sk: Record<string, string> = {};
  let i = 0;
  for (const c of ['אדום', 'כחול']) for (const s of ['S', 'L']) {
    const k = comboKey({ צבע: c, מידה: s });
    vs[k] = 5; sk[k] = `SK-${i++}`;
  }
  return {
    id: 'p1', storeId: 's1', slug: 'chair', name: 'Chair', description: '', price: 100, stock: 20,
    variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }],
    variantStock: vs, variantSku: sk, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

type PreviewRow = {
  action: string; unchanged?: boolean; variantCount?: number; errors: string[];
  changedCombos?: Array<{ line: number; label: string }>; comboLineByKey?: Record<string, number>;
};
const preview = (csv: string) =>
  (runProductImport({ storeId: 's1', sellerId: 'seller', csv, commit: false }).body as { results: PreviewRow[] }).results;

beforeEach(() => { categoriesDb = []; db = [seedVariantProduct()]; });

describe('runProductImport — a variant product is ONE row to update, never N', () => {
  it('re-importing the unchanged export is a single no-op (not four updates)', () => {
    const results = preview(productsToCsv(db, [], 'he'));
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.unchanged).toBe(true);
    expect(results[0]!.variantCount).toBe(4);
  });

  it('editing one combo shows exactly one changed update, pointing at that one row + variant', () => {
    const csv = productsToCsv(db, [], 'he').replace(',5,', ',9,'); // bump the first combo's stock
    const results = preview(csv);
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.unchanged).toBe(false);
    // The whole product spans lines 2–5, but only the first combo changed — the preview pins that row.
    expect(results[0]!.changedCombos).toEqual([{ line: 2, label: 'אדום / S' }]);
    // Internal per-combo maps are stripped from the response.
    expect(results[0]!.comboLineByKey).toBeUndefined();
  });

  it('groups combo rows that share the id even when the group column is blank', () => {
    // Four id-matched rows, each a real combo (option columns filled) but NO group value — the shape
    // that used to surface as four separate "updates" to the same product.
    const csv = [
      COLS.join(','),
      row({ id: 'p1', sku: 'SK-0', name: 'Chair', price: '100', stock: '9', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ id: 'p1', sku: 'SK-1', name: 'Chair', price: '100', stock: '5', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'L' }),
      row({ id: 'p1', sku: 'SK-2', name: 'Chair', price: '100', stock: '5', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'S' }),
      row({ id: 'p1', sku: 'SK-3', name: 'Chair', price: '100', stock: '5', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'L' }),
    ].join('\n');
    const results = preview(csv);
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.variantCount).toBe(4);
  });

  it('id-matched rows with no group AND no option columns collapse to one clear error, not N phantom updates', () => {
    const csv = [
      COLS.join(','),
      row({ id: 'p1', name: 'Chair', price: '100', stock: '9' }),
      row({ id: 'p1', name: 'Chair', price: '100', stock: '7' }),
    ].join('\n');
    const results = preview(csv);
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('error');
    expect(results[0]!.errors).toContain('variant-missing-option');
  });
});

// A purchase of a variant product decrements that combo's own bucket (resolveStockField in
// store-products.ts), so a product-level stock number governs nothing once variantStock exists.
// Writing one anyway reported "updated" while every combo kept selling its old quantity — the
// oversell path a sku+stock feed walks into.
describe('runProductImport — a single stock number can never move a per-combo product', () => {
  it('rejects a flat row that changes stock on a variant product', () => {
    const csv = [COLS.join(','), row({ id: 'p1', name: 'Chair', price: '100', stock: '3' })].join('\n');
    const results = preview(csv);
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('error');
    expect(results[0]!.errors).toContain('variant-stock-needs-combos');
  });

  it('commits nothing for that row — the combo buckets and the total both stand', () => {
    const csv = [COLS.join(','), row({ id: 'p1', name: 'Chair', price: '100', stock: '3' })].join('\n');
    runProductImport({ storeId: 's1', sellerId: 'seller', csv, commit: true });
    expect(db[0]!.stock).toBe(20);
    expect(Object.values(db[0]!.variantStock!)).toEqual([5, 5, 5, 5]);
  });

  it('leaves a stock cell that matches the existing total as a plain no-op, not an error', () => {
    // The 4+-dimension export is a flat row carrying the total — a faithful round-trip must stay quiet.
    const csv = [COLS.join(','), row({ id: 'p1', name: 'Chair', price: '100', stock: '20' })].join('\n');
    const results = preview(csv);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.unchanged).toBe(true);
  });

  it('points a 4-dimension product at the dashboard — the option columns cannot express it', () => {
    // Four dimensions is why the export went flat in the first place; "fill in the option columns"
    // would send this seller after a fourth column pair that does not exist in the header.
    const p = db[0]!;
    p.variants = [...p.variants!, { name: 'חומר', options: ['עץ'] }, { name: 'נפח', options: ['1L'] }];
    const csv = [COLS.join(','), row({ id: 'p1', name: 'Chair', price: '100', stock: '3' })].join('\n');
    const results = preview(csv);
    expect(results[0]!.action).toBe('error');
    expect(results[0]!.errors).toContain('variant-stock-dashboard-only');
  });

  it('still applies a flat row that leaves the stock cell blank', () => {
    const csv = [COLS.join(','), row({ id: 'p1', name: 'Renamed', price: '100' })].join('\n');
    const results = preview(csv);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.errors).toEqual([]);
  });
});
