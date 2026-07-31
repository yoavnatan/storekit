import { describe, expect, it } from 'vitest';
import { getT } from '../src/i18n/index.js';

/**
 * Every string exists in BOTH languages, or neither.
 *
 * `translations.ts` is two large object literals maintained by hand, one per language, and a new
 * string means editing both — hundreds of lines apart. Miss one and nothing fails: `getT('en')`
 * returns an object without the key, the page renders `undefined` (or an empty string, if the
 * call site guarded), and the only way anyone finds out is by browsing the site in that language.
 * TypeScript does not catch it either — the type is inferred from one side, so the OTHER side is
 * the one free to drift.
 *
 * Written when the tree was at perfect parity (0 keys missing in either direction, measured
 * 2026-07-31), so it starts green and stays a real gate rather than a frozen backlog. If it fails,
 * add the missing key — never delete its twin to balance the sides.
 */

/** Every leaf path in a nested translation object — `store.haltedTitle`, not `store`. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('translations', () => {
  const he = new Set(leafPaths(getT('he')));
  const en = new Set(leafPaths(getT('en')));

  it('has no Hebrew string missing its English twin', () => {
    const missing = [...he].filter((k) => !en.has(k));
    expect(missing, `missing from the English block:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no English string missing its Hebrew twin', () => {
    const missing = [...en].filter((k) => !he.has(k));
    expect(missing, `missing from the Hebrew block:\n${missing.join('\n')}`).toEqual([]);
  });

  // A key present in both but empty on one side is the same bug wearing a different hat: the page
  // renders a blank where a sentence should be, and the parity check above is satisfied.
  it('has no empty string on one side only', () => {
    const read = (obj: unknown, path: string): unknown =>
      path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], obj);
    const lopsided = [...he].filter((k) => {
      const a = read(getT('he'), k);
      const b = read(getT('en'), k);
      return typeof a === 'string' && typeof b === 'string' && (a.trim() === '') !== (b.trim() === '');
    });
    expect(lopsided, `blank in one language only:\n${lopsided.join('\n')}`).toEqual([]);
  });
});
