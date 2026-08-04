// The one rule about a product's weight, and the distinction the whole field rests on: an absent
// weight is not a zero-gram parcel. Zero would be a carrier quote of ₪0 — which a carrier will
// happily return — where the truth is that the seller has not answered yet.

import { describe, expect, it } from 'vitest';
import { MAX_WEIGHT_GRAMS, feedShippingWeight, parseWeightGrams } from '../src/lib/product-weight.js';
import { CSV_FIELDS, mapHeader, toRawRows, validateRows } from '../src/lib/csv-bulk.js';

describe('parseWeightGrams', () => {
  it('takes a whole number of grams', () => {
    expect(parseWeightGrams('250')).toBe(250);
    expect(parseWeightGrams(1500)).toBe(1500);
    expect(parseWeightGrams(' 80 ')).toBe(80);
  });

  it('reads "not stated" as absent, never as zero', () => {
    for (const input of ['', null, undefined, '   ', 'abc', {}]) {
      expect(parseWeightGrams(input)).toBeUndefined();
    }
  });

  it('refuses zero and negatives — both would price a parcel at nothing', () => {
    expect(parseWeightGrams(0)).toBeUndefined();
    expect(parseWeightGrams('0')).toBeUndefined();
    expect(parseWeightGrams(-5)).toBeUndefined();
  });

  it('rounds a fraction rather than rejecting it', () => {
    // Someone thinking in kilograms typed 0.5. 1g is a truer answer than an error message.
    expect(parseWeightGrams(0.5)).toBe(1);
    expect(parseWeightGrams(249.4)).toBe(249);
  });

  it('refuses a number far past any parcel, which is the unit mistake', () => {
    expect(parseWeightGrams(MAX_WEIGHT_GRAMS)).toBe(MAX_WEIGHT_GRAMS);
    expect(parseWeightGrams(MAX_WEIGHT_GRAMS + 1)).toBeUndefined();
    expect(parseWeightGrams(2_500_000)).toBeUndefined();
  });
});

describe('how a weight is published', () => {
  it('uses the machine format, which is deliberately not a Hebrew one', () => {
    // Merchant Center takes a fixed English unit vocabulary; a Hebrew unit here is a rejected item.
    expect(feedShippingWeight(250)).toBe('250 g');
    expect(feedShippingWeight(18_000)).toBe('18000 g');
  });

  it('publishes NOTHING when the seller has not stated a weight', () => {
    // Not "0 g" — Merchant Center turns this into a shipping estimate, and a zero-gram parcel is a
    // delivery price the checkout would then contradict.
    expect(feedShippingWeight(undefined)).toBe('');
    expect(feedShippingWeight(0)).toBe('');
  });
});

describe('the CSV column', () => {
  /** A file with the canonical header, so the column mapping under test is the real one. */
  function importRows(weightCells: string[]) {
    const header = CSV_FIELDS.map((f) => f.en);
    const weightIdx = CSV_FIELDS.findIndex((f) => f.key === 'weight');
    const rows = weightCells.map((cell) => {
      const row = CSV_FIELDS.map(() => '');
      row[CSV_FIELDS.findIndex((f) => f.key === 'name')] = 'A product';
      row[CSV_FIELDS.findIndex((f) => f.key === 'price')] = '99';
      row[weightIdx] = cell;
      return row;
    });
    const { map, missing } = mapHeader(header);
    expect(missing).toEqual([]);
    // toRawRows takes the whole parsed file, header row included — it skips it itself.
    return validateRows(toRawRows([header, ...rows], map), new Set());
  }

  it('is appended, so a seller\'s older file still imports', () => {
    // The column list is positional and append-only: a file written before this column existed is
    // simply short a trailing cell, which reads as blank, which means "leave unchanged".
    expect(CSV_FIELDS[CSV_FIELDS.length - 1]!.key).toBe('weight');
  });

  it('imports a stated weight and leaves a blank cell alone', () => {
    const [stated, blank] = importRows(['250', '']);
    expect(stated!.action).toBe('create');
    expect(stated!.input?.weightGrams).toBe(250);
    expect(blank!.action).toBe('create');
    expect(blank!.input?.weightGrams).toBeUndefined();
  });

  it('FAILS the row on a weight it cannot use, rather than importing it weightless', () => {
    // The quiet failure this prevents: a seller types 2.5 meaning kilograms, the row imports
    // cleanly with no weight, and nobody finds out until a carrier quote is wrong months later.
    const [zero, huge, text] = importRows(['0', '900000', 'heavy']);
    expect(zero!.errors).toContain('weight-invalid');
    expect(huge!.errors).toContain('weight-invalid');
    expect(text!.errors).toContain('weight-invalid');
  });
});
