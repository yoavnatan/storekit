import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — a plain .mjs data module shared with the seeder; it has no types and needs none.
import { BANNER_DELIVERED_RATIO, BANNER_ASPECT } from '../scripts/lib/showcase/identity.mjs';
import { BANNER_RATIO } from '../src/lib/cdn.js';

/**
 * The showcase banner is stored at the ratio the page shows it at, and this pins the two halves of
 * that sentence together.
 *
 * The generator centre-crops each banner to `BANNER_DELIVERED_RATIO` before uploading, so that
 * `cdnBand`'s `ar_3,c_fill,g_auto` has nothing left to crop. That only holds while the two numbers
 * agree, and they live in files that cannot import each other — a `.mjs` build script and a
 * TypeScript module compiled into the site.
 *
 * Drift here is silent and expensive in the one way this project cares about: nothing errors,
 * nothing looks wrong in a diff, and the next generated banner simply starts losing its edges to a
 * saliency crop again — which is the defect that took four rounds and about ₪10 of generated
 * images to find, because the crop happens at DELIVERY and the source always looked fine.
 */
describe('showcase banner ratio', () => {
  it('the generator crops to the ratio the site delivers', () => {
    expect(BANNER_DELIVERED_RATIO).toBe(BANNER_RATIO);
  });

  it('is generated wider than it is stored, so the crop only ever trims', () => {
    // 21:9 → 3:1 throws away 22% of the height. If the generated aspect ever became NARROWER than
    // the delivered one, `c_fill` would crop the sides instead — silently, and in the one
    // dimension every banner prompt composes across.
    const [w, h] = String(BANNER_ASPECT).split(':').map(Number);
    expect(w / h).toBeLessThan(BANNER_RATIO);
    expect(w / h).toBeGreaterThan(2);
  });
});
