import { describe, expect, it } from 'vitest';
import { guessMapping, buildCanonicalCsv, mappingStatus, mappingToRecord, normalizeHeader } from '../src/lib/feed-mapping.js';
import { parseCsv, mapHeader, toRawRows, resolveSkuMatches, validateRows, type SkuMatchTarget } from '../src/lib/csv-bulk.js';

describe('guessMapping', () => {
  it('maps common external headers (he + en synonyms) to canonical keys', () => {
    const m = guessMapping(['Item Code', 'Product Name', 'Qty', 'Price', 'random note']);
    expect(m.map((e) => e.key)).toEqual(['sku', 'name', 'stock', 'price', null]);
  });

  it('matches Hebrew headers', () => {
    const m = guessMapping(['מק"ט', 'שם מוצר', 'כמות במלאי']);
    expect(m.map((e) => e.key)).toEqual(['sku', 'name', 'stock']);
  });

  it('never maps two source columns to the same canonical field (first wins)', () => {
    const m = guessMapping(['sku', 'item code']);
    expect(m.map((e) => e.key)).toEqual(['sku', null]);
  });

  it('lets a saved mapping override the synonym guess', () => {
    const m = guessMapping(['Barkod', 'Amount'], { Barkod: 'sku', Amount: 'stock' });
    expect(m.map((e) => e.key)).toEqual(['sku', 'stock']);
  });

  it('is case/whitespace/quote insensitive', () => {
    expect(normalizeHeader('  "SKU" ')).toBe('sku');
    expect(guessMapping(['  INVENTORY '])[0]!.key).toBe('stock');
  });

  /**
   * The quantity column, in the spellings a till actually prints.
   *
   * "Qty On Hand" was NOT among them until 2026-08-19, and the failure it produced is the quiet
   * kind this whole module exists to avoid: every other column maps, the stock column falls to
   * "don't import", and the import then changes nothing while reporting success — because a blank
   * cell means "leave unchanged" everywhere downstream. It went unnoticed because the repo's own
   * feed test used that exact header with an explicit saved mapping, which never asks the guess.
   */
  it('recognises the quantity column however the till spells it', () => {
    for (const header of [
      'Qty On Hand', 'QTY ON HAND', 'Qty on-hand', 'Quantity On Hand', 'Stock On Hand',
      'On Hand', 'Units In Stock', 'Available Qty', 'Qty Available', 'כמות זמינה',
    ]) {
      expect(guessMapping([header])[0]!.key, `${header} did not map to stock`).toBe('stock');
    }
  });

  it('and the new spellings steal nothing from another field', () => {
    // A synonym list grows by being generous; the cost of being generous is a header that a
    // DIFFERENT key used to claim. This is the whole guess, over one realistic export.
    const m = guessMapping(['Item Code', 'Item Name', 'Variant', 'Qty On Hand', 'Unit Price', 'Last Counted']);
    expect(m.map((e) => e.key)).toEqual(['sku', 'name', null, 'stock', 'price', null]);
  });
});

describe('mappingStatus', () => {
  it('flags a missing matcher and missing stock', () => {
    const s = mappingStatus(guessMapping(['name', 'price']));
    expect(s.hasMatcher).toBe(false);
    expect(s.hasStock).toBe(false);
  });

  it('sees sku as a matcher and stock as present', () => {
    const s = mappingStatus(guessMapping(['sku', 'stock']));
    expect(s.hasMatcher).toBe(true);
    expect(s.hasStock).toBe(true);
  });
});

describe('buildCanonicalCsv', () => {
  it('rewrites an arbitrary feed into a canonical file the existing pipeline can read', () => {
    const rows = parseCsv('Item Code,Qty,Ignore me\nABC-1,7,foo\nABC-2,0,bar');
    const entries = guessMapping(rows[0]!);
    const canonical = buildCanonicalCsv(rows, entries);

    // Canonical CSV always emits ALL columns (blank for unmapped ones), so every required header is
    // present even for a sku+stock-only feed — name/price ride through blank ("leave unchanged" /
    // backfilled from the matched product server-side), never a missing-columns rejection.
    const parsed = parseCsv(canonical);
    const { missing, map } = mapHeader(parsed[0]!);
    expect(missing).toEqual([]);
    const raw = toRawRows(parsed, map);
    expect(raw.map((r) => ({ sku: r.cells.sku, stock: r.cells.stock }))).toEqual([
      { sku: 'ABC-1', stock: '7' },
      { sku: 'ABC-2', stock: '0' },
    ]);
  });

  it('mappingToRecord keeps only mapped columns', () => {
    expect(mappingToRecord(guessMapping(['sku', 'nope', 'stock']))).toEqual({ sku: 'sku', stock: 'stock' });
  });
});

describe('resolveSkuMatches (sku matching — runs on every import: manual upload + external feed)', () => {
  const catalog = new Map<string, SkuMatchTarget>([
    ['ABC-1', { id: 'prod-1', name: 'Existing Widget', price: 50 }],
  ]);

  it('turns a sku+stock-only row into an id-matched update, backfilling name/price', () => {
    const raw = toRawRows(parseCsv('sku,stock\nABC-1,3'), mapHeader(['sku', 'stock']).map);
    resolveSkuMatches(raw, catalog);
    expect(raw[0]!.cells.id).toBe('prod-1');
    expect(raw[0]!.cells.name).toBe('Existing Widget');
    expect(raw[0]!.cells.price).toBe('50');

    // And it validates as a clean update (no name/price/sku-duplicate error).
    const results = validateRows(raw, new Set(['prod-1']), new Map([['ABC-1', 'prod-1']]));
    expect(results[0]!.action).toBe('update');
    expect(results[0]!.errors).toEqual([]);
    expect(results[0]!.input?.stock).toBe(3);
  });

  it('leaves an unknown sku alone so it flows through as a create', () => {
    const raw = toRawRows(parseCsv('sku,name,price,stock\nNEW-9,New thing,20,5'), mapHeader(['sku', 'name', 'price', 'stock']).map);
    resolveSkuMatches(raw, catalog);
    expect(raw[0]!.cells.id).toBeUndefined();
    const results = validateRows(raw, new Set(['prod-1']), new Map([['ABC-1', 'prod-1']]));
    expect(results[0]!.action).toBe('create');
    expect(results[0]!.errors).toEqual([]);
  });

  it('does not overwrite name/price a foreign feed DID provide', () => {
    const raw = toRawRows(parseCsv('sku,name,price,stock\nABC-1,Renamed,99,2'), mapHeader(['sku', 'name', 'price', 'stock']).map);
    resolveSkuMatches(raw, catalog);
    expect(raw[0]!.cells.name).toBe('Renamed');
    expect(raw[0]!.cells.price).toBe('99');
    expect(raw[0]!.cells.id).toBe('prod-1');
  });

  it('an explicit internal id always wins over sku matching', () => {
    const raw = toRawRows(parseCsv('id,sku,stock\nprod-other,ABC-1,4'), mapHeader(['id', 'sku', 'stock']).map);
    resolveSkuMatches(raw, catalog);
    expect(raw[0]!.cells.id).toBe('prod-other');
  });
});
