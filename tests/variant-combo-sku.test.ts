/**
 * The per-combination code, from the seller's own keyboard.
 *
 * A POS counts blue-L and calls it `SW-BL-L`, and that string is the whole link between this
 * catalogue and the seller's own inventory system: `variant-sku-match.ts` resolves an inbound feed
 * row by it. Until 2026-08-19 it could only be set through the CSV round-trip — export, fill a
 * column, re-import — which put the external sync out of reach of every seller who does not live in
 * a spreadsheet (owner, the same day: *"אמרת קודם משהו שאתה יכול לבנות עם המק״ט למה לא בנית?"*).
 * The combo table has a column for it now, and this pins the three rules that column needs to obey.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { comboKey } from '../src/lib/variant-combo.js';
import { collectComboSkus, normalizeComboSku, COMBO_SKU_MAXLENGTH } from '../src/lib/variant-sku-field.js';
import { query } from '../src/lib/db.js';
import { createProduct, comboSkusTaken } from '../src/lib/store-products.js';

const S = comboKey({ מידה: 'S' });
const M = comboKey({ מידה: 'M' });
const VALID = new Set([S, M]);

describe('normalizeComboSku — blank is an answer, not an empty string', () => {
  it('trims, and reads nothing as nothing', () => {
    expect(normalizeComboSku('  SW-BL-L ')).toBe('SW-BL-L');
    // Not '' — a code that exists and matches nothing is worse than no code, because the feed
    // lookup would then hold an entry for it.
    expect(normalizeComboSku('   ')).toBeUndefined();
    expect(normalizeComboSku(undefined)).toBeUndefined();
  });

  it('caps the length rather than rejecting the row', () => {
    expect(normalizeComboSku('x'.repeat(500))).toHaveLength(COMBO_SKU_MAXLENGTH);
  });
});

describe('collectComboSkus — what a submitted map may store', () => {
  it('keeps only codes for combos the product still declares', () => {
    const { skus } = collectComboSkus({ [S]: 'A-1', 'מידה=XL': 'A-9' }, VALID);
    expect(skus).toEqual({ [S]: 'A-1' });
  });

  it('refuses one code typed onto two combos of the same product', () => {
    // Not dropped quietly: the importer resolves a code to exactly ONE combo, so the second would
    // silently stop syncing — and only the seller knows which of the two they meant.
    const { duplicate } = collectComboSkus({ [S]: 'A-1', [M]: 'A-1' }, VALID);
    expect(duplicate).toBe('A-1');
  });

  it('is not confused by two combos with different codes', () => {
    const { skus, duplicate } = collectComboSkus({ [S]: 'A-1', [M]: 'A-2' }, VALID);
    expect(duplicate).toBeUndefined();
    expect(skus).toEqual({ [S]: 'A-1', [M]: 'A-2' });
  });
});

describe('comboSkusTaken — product codes and combo codes are ONE namespace', () => {
  async function freshStore(): Promise<string> {
    const sellerId = crypto.randomUUID();
    const storeId = crypto.randomUUID();
    await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
      [sellerId, `${storeId}@example.test`]);
    await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
      [storeId, sellerId, `combo-sku-${crypto.randomBytes(4).toString('hex')}`]);
    return storeId;
  }

  it('finds a code already used at PRODUCT level', async () => {
    const storeId = await freshStore();
    await createProduct(storeId, { name: 'Plain', price: 10, stock: 1, description: '', sku: 'DUP-1' });
    expect(await comboSkusTaken(storeId, ['DUP-1', 'FREE-1'])).toEqual(['DUP-1']);
  });

  it('finds a code already used on another product\'s COMBINATION', async () => {
    // The half a product-level-only check misses — and the half that matters most, because it is
    // exactly the code an inbound feed row carries.
    const storeId = await freshStore();
    await createProduct(storeId, {
      name: 'Shirt', price: 10, stock: 4, description: '',
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantSku: { [S]: 'SH-S' },
    });
    expect(await comboSkusTaken(storeId, ['SH-S'])).toEqual(['SH-S']);
  });

  it('does not report a product\'s own codes back to it', async () => {
    const storeId = await freshStore();
    const p = await createProduct(storeId, {
      name: 'Shirt', price: 10, stock: 4, description: '', sku: 'OWN-P',
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantSku: { [S]: 'OWN-S' },
    });
    // Re-saving the same form must not read as a collision with itself.
    expect(await comboSkusTaken(storeId, ['OWN-S', 'OWN-P'], p.id)).toEqual([]);
  });

  it('is scoped to the store — another shop\'s codes are not ours to refuse', async () => {
    const mine = await freshStore();
    const theirs = await freshStore();
    await createProduct(theirs, { name: 'Theirs', price: 10, stock: 1, description: '', sku: 'X-1' });
    expect(await comboSkusTaken(mine, ['X-1'])).toEqual([]);
  });
});
