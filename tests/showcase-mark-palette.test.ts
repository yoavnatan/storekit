import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — a plain .mjs data module shared with the seeder; it has no types and needs none.
import { SHOWCASE_STORES } from '../scripts/lib/showcase/identity.mjs';

/**
 * The showcase mark's colours match the colours the seeder writes onto the store row.
 *
 * `StoreDemoMark` holds the palette itself, keyed by slug, because it was a PROP and the header
 * called the component without it — so שקמה's mark was its green on the store page and the default
 * terracotta in the header. One shop, two colours.
 *
 * Holding it in the component fixes the caller problem and creates a second copy of the same four
 * pairs, which is the trade. This is what makes the trade safe: `identity.mjs` is the source the
 * database is seeded from, and if the two ever disagree the store's own accent and its logo would
 * quietly stop matching — the exact symptom, arrived at from the other direction.
 */

const MARK = readFileSync(join(process.cwd(), 'src/components/StoreDemoMark.astro'), 'utf8');

/** The `PALETTE` literal, parsed out of the component. */
function componentPalette(): Record<string, { primary: string; accent: string }> {
  const block = MARK.match(/const PALETTE[^=]*=\s*\{([\s\S]*?)\n\};/);
  expect(block, 'PALETTE literal not found — did it move or get renamed?').toBeTruthy();
  const out: Record<string, { primary: string; accent: string }> = {};
  for (const m of block![1].matchAll(/'([^']+)':\s*\{\s*primary:\s*'([^']+)',\s*accent:\s*'([^']+)'/g)) {
    out[m[1]!] = { primary: m[2]!, accent: m[3]! };
  }
  return out;
}

describe('showcase logo palette', () => {
  const pal = componentPalette();

  it('covers every showcase store', () => {
    expect(Object.keys(pal).sort()).toEqual(SHOWCASE_STORES.map((s: { slug: string }) => s.slug).sort());
  });

  it.each(SHOWCASE_STORES.map((s: { slug: string; name: string }) => [s.name, s.slug]))(
    '%s uses the same two colours the seeder writes',
    (_name, slug) => {
      const store = SHOWCASE_STORES.find((s: { slug: string }) => s.slug === slug)!;
      expect(pal[slug as string]).toEqual({ primary: store.colors.primary, accent: store.colors.accent });
    },
  );

  it('the header passes no colours, so the component must supply them', () => {
    // If the header ever starts passing a palette again, this pair can drift apart silently — which
    // is what the whole file is guarding against.
    const header = readFileSync(join(process.cwd(), 'src/components/Header.astro'), 'utf8');
    const call = header.match(/<StoreDemoMark[^>]*\/>/);
    expect(call).toBeTruthy();
    expect(call![0]).not.toContain('colors=');
  });
});
