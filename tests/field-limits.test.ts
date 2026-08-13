import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIELD_LIMIT, findFieldOverLimit, productFieldsOverLimit, fieldLimitRejectionMessage,
} from '../src/lib/field-limits.js';

const SRC = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('field length ceilings', () => {
  it('passes text within the limit', () => {
    expect(productFieldsOverLimit({ name: 'חולצה', description: 'א'.repeat(FIELD_LIMIT.description) })).toBeNull();
  });

  it('catches a description one character over', () => {
    const v = productFieldsOverLimit({ name: 'חולצה', description: 'א'.repeat(FIELD_LIMIT.description + 1) });
    expect(v).not.toBeNull();
    expect(v!.label).toBe('תיאור');
    expect(v!.actual).toBe(FIELD_LIMIT.description + 1);
  });

  it('counts code points, not UTF-16 units — an emoji is one character', () => {
    // '😀' is a surrogate pair: `.length` says 2. A seller writing emoji would otherwise get half
    // the allowance, which is the bug this asserts against.
    const justAtLimit = '😀'.repeat(FIELD_LIMIT.name);
    expect(findFieldOverLimit([{ value: justAtLimit, limit: FIELD_LIMIT.name, label: 'x' }])).toBeNull();
  });

  it('caps a single tag without capping the number of tags', () => {
    const manyShort = Array.from({ length: 40 }, () => 'קיץ');
    expect(productFieldsOverLimit({ name: 'x', tags: manyShort })).toBeNull();
    expect(productFieldsOverLimit({ name: 'x', tags: ['א'.repeat(FIELD_LIMIT.tag + 1)] })).not.toBeNull();
  });

  it('reports the first violation only, and names real numbers in the message', () => {
    const v = productFieldsOverLimit({ name: 'א'.repeat(FIELD_LIMIT.name + 5), description: 'ב'.repeat(FIELD_LIMIT.description + 5) });
    expect(v!.label).toBe('שם המוצר');
    const msg = fieldLimitRejectionMessage(v!);
    expect(msg).toContain('שם המוצר');
    expect(msg).toContain(FIELD_LIMIT.name.toLocaleString('he-IL'));
  });

  it('never silently truncates — it only ever reports', () => {
    const long = 'א'.repeat(FIELD_LIMIT.description + 1);
    const v = productFieldsOverLimit({ name: 'x', description: long });
    // The input object is untouched; a caller that ignores the violation stores the original,
    // which is the intended failure mode (loud), not a quietly shortened body.
    expect(long).toHaveLength(FIELD_LIMIT.description + 1);
    expect(v!.actual).toBe(FIELD_LIMIT.description + 1);
  });
});

/**
 * The guard half. These greps are what stops the ceiling being added once and then forgotten by the
 * next route that accepts the same text — the failure mode the spam filter already had, where
 * /api/store's own name and description were never gated at all until 2026-08-12.
 */
describe('every seller free-text writer gates through field-limits', () => {
  const ROUTES = [
    'pages/api/product.ts',
    'pages/api/store.ts',
    'pages/api/store-category.ts',
    // The no-JS native-POST fallback. It writes the SAME public store text the API twin does, and
    // it had neither gate until 2026-08-12 — the same shape as the authorization hole found in this
    // file on 2026-08-06 (area-audit row 4). It is in the list precisely because it is the one a
    // reviewer forgets: it is a page, not a route.
    'pages/seller/dashboard.astro',
  ];

  it.each(ROUTES)('%s imports the shared ceiling', (route) => {
    expect(read(route)).toMatch(/from '\.\.\/\.\.\/lib\/field-limits\.js'/);
  });

  it('/api/product checks BOTH the create and the merged-update path', () => {
    const src = read('pages/api/product.ts');
    expect(src.match(/productFieldsOverLimit\(/g) ?? []).toHaveLength(2);
  });

  it('/api/store gates its own name, tagline and description', () => {
    const src = read('pages/api/store.ts');
    expect(src).toContain('storeTextOverLimit(');
    // The store text is spam-gated too now, not only the sale banner it used to be alone in
    // checking — that asymmetry was the hole.
    expect(src).toMatch(/findSpamKeyword\(name, storeTagline, storeDescription/);
  });

  it('the dashboard fallback gates BOTH the create and the settings-save path', () => {
    const src = read('pages/seller/dashboard.astro');
    expect(src.match(/storeTextOverLimit\(/g) ?? []).toHaveLength(2);
    expect(src.match(/findSpamKeyword\(name, tagline, description\)/g) ?? []).toHaveLength(2);
  });

  it('the labels have exactly one definition, in the shared module', () => {
    // If a route spells a label itself, the two copies drift and the seller sees a different field
    // name depending on which form they used.
    for (const route of ROUTES) expect(read(route)).not.toContain('שם החנות');
  });

  it('no route hand-rolls a numeric length check on a text field instead', () => {
    for (const route of ROUTES) {
      // A literal comparison like `description.length > 5000` is the second definition of the rule
      // this module exists to be the only copy of.
      expect(read(route)).not.toMatch(/\b(description|tagline|name)\b[^\n]*\.length\s*>\s*\d{3,}/);
    }
  });
});
