import { describe, expect, it } from 'vitest';
import { importSeoAdvisory, type AdvisoryExisting } from '../src/lib/csv-import-advisory.js';
import { MIN_DESCRIPTION_LENGTH } from '../src/lib/product-seo-hints.js';
import type { MergedRowResult } from '../src/lib/variant-csv.js';

const LONG = 'ת'.repeat(MIN_DESCRIPTION_LENGTH);
const SHORT = 'ת'.repeat(MIN_DESCRIPTION_LENGTH - 1);

const row = (over: Partial<MergedRowResult> = {}): MergedRowResult => ({
  lines: [2],
  action: 'create',
  errors: [],
  input: { name: 'מוצר', price: 10, description: LONG },
  ...over,
});

const stored = (over: Partial<AdvisoryExisting> = {}): AdvisoryExisting => ({
  description: LONG,
  images: ['https://cdn/x.jpg'],
  ...over,
});

describe('importSeoAdvisory', () => {
  it('counts every created product as image-less — the format carries no image column', () => {
    const a = importSeoAdvisory([row(), row(), row()], new Map());
    expect(a.noImage).toBe(3);
    expect(a.thinDescription).toBe(0);
  });

  it('an update row inherits the stored product\'s images, so an illustrated product is not counted', () => {
    const results = [row({ action: 'update', id: 'p1' }), row({ action: 'update', id: 'p2' })];
    const existing = new Map<string, AdvisoryExisting>([
      ['p1', stored()],
      ['p2', stored({ images: [] })],
    ]);
    expect(importSeoAdvisory(results, existing).noImage).toBe(1);
  });

  it('judges the RESULTING description: a blank cell keeps the stored text', () => {
    const results = [
      row({ action: 'update', id: 'p1', input: { name: 'מוצר', price: 10 } }),          // blank cell, stored text is long
      row({ action: 'update', id: 'p2', input: { name: 'מוצר', price: 10 } }),          // blank cell, stored text is short
      row({ action: 'update', id: 'p1', input: { name: 'מוצר', price: 10, description: SHORT } }), // shortened by the file
    ];
    const existing = new Map<string, AdvisoryExisting>([
      ['p1', stored()],
      ['p2', stored({ description: SHORT })],
    ]);
    expect(importSeoAdvisory(results, existing).thinDescription).toBe(2);
  });

  it('uses the editor\'s own threshold, so the two can never disagree about one product', () => {
    expect(importSeoAdvisory([row({ input: { name: 'מוצר', price: 10, description: SHORT } })], new Map()).thinDescription).toBe(1);
    expect(importSeoAdvisory([row({ input: { name: 'מוצר', price: 10, description: LONG } })], new Map()).thinDescription).toBe(0);
  });

  it('ignores rows nothing is written for — errors and no-op updates', () => {
    const results = [
      row({ action: 'error', errors: ['name-required'], input: undefined }),
      row({ action: 'update', id: 'p1', unchanged: true }),
    ];
    const existing = new Map<string, AdvisoryExisting>([['p1', stored({ images: [], description: SHORT })]]);
    expect(importSeoAdvisory(results, existing)).toEqual({ noImage: 0, thinDescription: 0 });
  });

  it('a clean import reports nothing — the preview then renders no note at all', () => {
    const results = [row({ action: 'update', id: 'p1' })];
    expect(importSeoAdvisory(results, new Map([['p1', stored()]]))).toEqual({ noImage: 0, thinDescription: 0 });
  });
});
