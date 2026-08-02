/**
 * The CSV import pipeline, against a real Postgres (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * `notifications` is the one thing still mocked: it has not moved off `data/*.json` yet, and a
 * committing test would otherwise write into the developer's real notification file. Everything
 * else — the catalog it reads, resolves against and writes — is the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { comboKey } from '../src/lib/variant-combo.js';

vi.mock('../src/lib/notifications.js', () => ({
  createNotification: () => {},
  deleteNotificationsByRelatedIds: () => {},
}));

const { query } = await import('../src/lib/db.js');
const { CSV_FIELDS } = await import('../src/lib/csv-bulk.js');
const { createProduct, getProductById } = await import('../src/lib/store-products.js');
const { productsToCsv } = await import('../src/lib/store-products-bulk.js');
const { runProductImport } = await import('../src/lib/store-products-import.js');

const COLS = CSV_FIELDS.map((f) => f.key);
const row = (cells: Partial<Record<string, string>>): string => COLS.map((k) => cells[k] ?? '').join(',');

let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `import-test-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

/** A 2×2 (colour × size) variant product → four combos, each with its own stock and code. */
async function seedVariantProduct(storeId: string) {
  const variantStock: Record<string, number> = {};
  const variantSku: Record<string, string> = {};
  let i = 0;
  for (const c of ['אדום', 'כחול']) for (const s of ['S', 'L']) {
    const k = comboKey({ צבע: c, מידה: s });
    variantStock[k] = 5;
    variantSku[k] = `SK-${i++}`;
  }
  return createProduct(storeId, {
    name: 'Chair', price: 100, stock: 20, description: '',
    variants: [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }],
    variantStock, variantSku,
  });
}

type PreviewRow = {
  action: string; unchanged?: boolean; variantCount?: number; errors: string[];
  changedCombos?: Array<{ line: number; label: string }>; comboLineByKey?: Record<string, number>;
};

let storeId = '';
let chairId = '';

const preview = async (csv: string) =>
  ((await runProductImport({ storeId, sellerId: 'seller', csv, commit: false })).body as { results: PreviewRow[] }).results;

beforeEach(async () => {
  storeId = await freshStore();
  chairId = (await seedVariantProduct(storeId)).id;
});

describe('runProductImport — a variant product is ONE row to update, never N', () => {
  it('re-importing the unchanged export is a single no-op (not four updates)', async () => {
    const chair = (await getProductById(chairId))!;
    const results = await preview(productsToCsv([chair], [], 'he'));
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.unchanged).toBe(true);
    expect(results[0]!.variantCount).toBe(4);
  });

  it('editing one combo shows exactly one changed update, pointing at that one row + variant', async () => {
    const chair = (await getProductById(chairId))!;
    const csv = productsToCsv([chair], [], 'he').replace(',5,', ',9,'); // bump the first combo's stock
    const results = await preview(csv);
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.unchanged).toBe(false);
    // The whole product spans lines 2–5, but only the first combo changed — the preview pins that row.
    expect(results[0]!.changedCombos).toEqual([{ line: 2, label: 'אדום / S' }]);
    // Internal per-combo maps are stripped from the response.
    expect(results[0]!.comboLineByKey).toBeUndefined();
  });

  it('groups combo rows that share the id even when the group column is blank', async () => {
    // Four id-matched rows, each a real combo (option columns filled) but NO group value — the shape
    // that used to surface as four separate "updates" to the same product.
    const csv = [
      COLS.join(','),
      row({ id: chairId, sku: 'SK-0', name: 'Chair', price: '100', stock: '9', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'S' }),
      row({ id: chairId, sku: 'SK-1', name: 'Chair', price: '100', stock: '5', option1Name: 'צבע', option1Value: 'אדום', option2Name: 'מידה', option2Value: 'L' }),
      row({ id: chairId, sku: 'SK-2', name: 'Chair', price: '100', stock: '5', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'S' }),
      row({ id: chairId, sku: 'SK-3', name: 'Chair', price: '100', stock: '5', option1Name: 'צבע', option1Value: 'כחול', option2Name: 'מידה', option2Value: 'L' }),
    ].join('\n');
    const results = await preview(csv);
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.variantCount).toBe(4);
  });

  it('id-matched rows with no group AND no option columns collapse to one clear error, not N phantom updates', async () => {
    const csv = [
      COLS.join(','),
      row({ id: chairId, name: 'Chair', price: '100', stock: '9' }),
      row({ id: chairId, name: 'Chair', price: '100', stock: '7' }),
    ].join('\n');
    const results = await preview(csv);
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('error');
    expect(results[0]!.errors).toContain('variant-missing-option');
  });

  it('commits a changed combo to the product\'s own bucket', async () => {
    const chair = (await getProductById(chairId))!;
    const csv = productsToCsv([chair], [], 'he').replace(',5,', ',9,');
    await runProductImport({ storeId, sellerId: 'seller', csv, commit: true });
    const after = (await getProductById(chairId))!;
    expect(after.variantStock![comboKey({ צבע: 'אדום', מידה: 'S' })]).toBe(9);
    expect(after.variantSku![comboKey({ צבע: 'אדום', מידה: 'S' })]).toBe('SK-0');
  });
});

// A purchase of a variant product decrements that combo's own bucket (resolveStockField in
// store-products.ts), so a product-level stock number governs nothing once variantStock exists.
// Writing one anyway reported "updated" while every combo kept selling its old quantity — the
// oversell path a sku+stock feed walks into.
describe('runProductImport — a single stock number can never move a per-combo product', () => {
  it('rejects a flat row that changes stock on a variant product', async () => {
    const csv = [COLS.join(','), row({ id: chairId, name: 'Chair', price: '100', stock: '3' })].join('\n');
    const results = await preview(csv);
    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe('error');
    expect(results[0]!.errors).toContain('variant-stock-needs-combos');
  });

  it('commits nothing for that row — the combo buckets and the total both stand', async () => {
    const csv = [COLS.join(','), row({ id: chairId, name: 'Chair', price: '100', stock: '3' })].join('\n');
    await runProductImport({ storeId, sellerId: 'seller', csv, commit: true });
    const after = (await getProductById(chairId))!;
    expect(after.stock).toBe(20);
    expect(Object.values(after.variantStock!)).toEqual([5, 5, 5, 5]);
  });

  it('leaves a stock cell that matches the existing total as a plain no-op, not an error', async () => {
    // The 4+-dimension export is a flat row carrying the total — a faithful round-trip must stay quiet.
    const csv = [COLS.join(','), row({ id: chairId, name: 'Chair', price: '100', stock: '20' })].join('\n');
    const results = await preview(csv);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.unchanged).toBe(true);
  });

  it('points a 4-dimension product at the dashboard — the option columns cannot express it', async () => {
    // Four dimensions is why the export went flat in the first place; "fill in the option columns"
    // would send this seller after a fourth column pair that does not exist in the header.
    const chair = (await getProductById(chairId))!;
    const { updateProduct } = await import('../src/lib/store-products.js');
    await updateProduct(chairId, {
      variants: [...chair.variants!, { name: 'חומר', options: ['עץ'] }, { name: 'נפח', options: ['1L'] }],
    });
    const csv = [COLS.join(','), row({ id: chairId, name: 'Chair', price: '100', stock: '3' })].join('\n');
    const results = await preview(csv);
    expect(results[0]!.action).toBe('error');
    expect(results[0]!.errors).toContain('variant-stock-dashboard-only');
  });

  it('still applies a flat row that leaves the stock cell blank', async () => {
    const csv = [COLS.join(','), row({ id: chairId, name: 'Renamed', price: '100' })].join('\n');
    const results = await preview(csv);
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.errors).toEqual([]);
  });
});
