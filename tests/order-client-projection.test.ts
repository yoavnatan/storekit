/**
 * Fields an API route must strip before an `Order` reaches a client.
 *
 * **The class, not the field.** Both routes that hand orders to a browser build the payload by
 * spreading a whole `Order` and removing what must not travel. That shape is convenient and it
 * leaks by default: every field the model gains ships to every client until someone remembers to
 * add it to the destructure. `sellerNotes` is how it was learned — the whole per-store map, one
 * seller's private notes readable by another seller on a shared order — and `attribution` (the ad
 * click behind the purchase, migration 0010) would have been the second, because a whole-object
 * spread does not ask permission.
 *
 * So the guard is on the SHAPE: a route that strips `sellerNotes` has declared itself a
 * client-facing order projection, and every field on this list must be stripped there too. A third
 * such route fails this test on the day it is written rather than on the day someone reads the
 * payload.
 *
 * Why each field is on the list:
 *   · `sellerNotes`  — one seller's private notes must never reach another seller, or the buyer.
 *   · `attribution`  — the platform advertises out of ONE Google account and ONE Meta pixel for
 *                      every store, so those UTM tags are the OWNER's marketing structure, not the
 *                      seller's data; and echoing a shopper's click id back into their own browser
 *                      undoes the point of keeping it in an httpOnly cookie.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const API_DIR = join(process.cwd(), 'src/pages/api');

/** Fields that must appear in the destructure of any route that strips `sellerNotes`. */
const MUST_STRIP = ['sellerNotes', 'attribution'] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** The `{ a, b, ...rest }` destructures in a file, as their inner text. */
function restDestructures(source: string): string[] {
  return [...source.matchAll(/\{([^{}]*?\.\.\.\w+)\s*\}/g)].map((m) => m[1]!);
}

describe('an Order handed to a client is stripped of the fields that are not the client\'s', () => {
  const routes = walk(API_DIR);

  it('finds the routes it is guarding, so a rename cannot turn this into a no-op', () => {
    const projecting = routes.filter((f) => readFileSync(f, 'utf8').includes('sellerNotes'));
    // Both known ones: the seller's own orders list and the buyer's. A test that silently guards
    // nothing is worse than no test.
    expect(projecting.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of routes) {
    const source = readFileSync(file, 'utf8');
    const projections = restDestructures(source).filter((d) => d.includes('sellerNotes'));
    if (!projections.length) continue;

    it(`${relative(process.cwd(), file)} strips every internal field`, () => {
      for (const destructure of projections) {
        for (const field of MUST_STRIP) {
          expect(destructure, `add \`${field}\` to the destructure — it must not reach a client`)
            .toContain(field);
        }
      }
    });
  }
});
