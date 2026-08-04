/**
 * No tracking call site may invent its own item id.
 *
 * This is the grep half of `ad-item-id.test.ts`. That one proves the helper and the feed agree;
 * this one proves every call site actually goes through the helper — which is the part that failed
 * before. The slug-as-id mistake was not one oversight: it was written the same way four separate
 * times, in four files, because each call site chose an identifier locally and `{ id: slug }` reads
 * perfectly well in isolation. Nothing could have caught it except a rule about all of them at once.
 *
 * The check is deliberately blunt — the `id` a track call is handed must be built by `adItemId(`.
 * A future call site that has a genuine reason to pass something else should have to come here and
 * say so, because "the id" is exactly the thing that must not be decided per file.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');
/** The module that owns the rule; it is allowed to define what it exports. */
const OWNER = join('src', 'lib', 'ad-item-id.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|astro)$/.test(full) ? [full] : [];
  });
}

/** How many calls pass an item object directly (the two that take a single product). */
const countItemCalls = (source: string): number =>
  (source.match(/\btrack(ViewContent|AddToCart)\s*\(/g) ?? []).length;

/** How many of those hand `id` straight to the helper. Counted rather than parsed: matching an
 *  object literal across comments and nested calls is what made the first version of this test
 *  fragile, and the rule does not need a parser — one `id: adItemId(` per call is the rule. */
const countHelperIds = (source: string): number =>
  (source.match(/\bid:\s*adItemId\s*\(/g) ?? []).length;

const files = walk(SRC).filter((f) => relative(process.cwd(), f) !== OWNER);

describe('every ad-tracking call site takes its id from lib/ad-item-id.ts', () => {
  const callers = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return /\btrack(ViewContent|AddToCart|InitiateCheckout)\s*\(/.test(src)
      && !f.endsWith(join('lib', 'tracking.ts'));
  });

  it('finds the call sites it is guarding, so a rename cannot make this a no-op', () => {
    // Product page (view + two add buttons), store index card, quick-view modal, checkout.
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of callers) {
    const rel = relative(process.cwd(), file);
    const source = readFileSync(file, 'utf8');

    it(`${rel} imports the helper`, () => {
      expect(source, 'import adItemId — the id is not this file\'s to choose').toContain('ad-item-id.js');
    });

    it(`${rel} builds every tracked id with adItemId()`, () => {
      expect(
        countHelperIds(source),
        'a track call here names an id the helper did not build — a slug is not the catalog id, and is not even unique across stores',
      ).toBeGreaterThanOrEqual(countItemCalls(source));
    });
  }
});
