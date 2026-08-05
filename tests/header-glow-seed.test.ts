/**
 * The header paints a store's colour rule twice, microseconds apart: an inline seed in
 * `Header.astro` reads the memo `scripts/store-glow.ts` keeps in sessionStorage, and the module
 * itself then samples the logo and writes the same value. Two rules, one pixel — the exact shape
 * that already bit this project once on the cart badge, where a drift made the number roll from
 * the seeded value to the real one on every page load.
 *
 * Here the drift is worse than cosmetic. The seed reads sessionStorage, which anything running
 * on this origin can write, and puts the result straight into a style property. The module
 * validates that value through `validCached()`; if the seed's copy of that rule ever loosens,
 * the seed becomes the hole. So this asserts the two are the same rule, and that both still
 * reject everything that is not a plain 6-digit hex.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADER = readFileSync(join(process.cwd(), 'src', 'components', 'Header.astro'), 'utf8');
const GLOW = readFileSync(join(process.cwd(), 'src', 'scripts', 'store-glow.ts'), 'utf8');

/** Every hex-shaped literal regex in a source file. */
function hexPatterns(source: string): string[] {
  return [...source.matchAll(/\/\^#\[0-9a-f\][^/]*\//g)].map((m) => m[0]);
}

describe('header store-glow pre-paint seed', () => {
  it('the seed exists and reads the same sessionStorage key the module writes', () => {
    expect(GLOW).toContain("CACHE_KEY = 'sn_store_glow'");
    expect(HEADER).toContain("sessionStorage.getItem('sn_store_glow')");
    // The memo is keyed by the image's own URL in both places.
    expect(HEADER).toContain("img.getAttribute('src')");
  });

  it('the seed validates with byte-identical rule to store-glow.ts#validCached', () => {
    const inSeed = hexPatterns(HEADER);
    const inModule = hexPatterns(GLOW);
    expect(inSeed.length, 'expected exactly one hex rule in Header.astro').toBe(1);
    expect(inModule.length, 'expected exactly one hex rule in store-glow.ts').toBe(1);
    expect(inSeed[0]).toBe(inModule[0]);
  });

  it('that rule rejects everything that is not a plain 6-digit lowercase hex', () => {
    const rule = new RegExp(hexPatterns(GLOW)[0]!.slice(1, -1));
    for (const good of ['#0a1b2c', '#ffffff', '#000000']) expect(rule.test(good)).toBe(true);
    for (const bad of [
      '#FFF',
      '#fff',
      '#12345',
      '#1234567',
      'red',
      'var(--x)',
      'url(javascript:alert(1))',
      '#abcdef;background:url(x)',
      'expression(alert(1))',
      '#abcdef ',
    ]) {
      expect(rule.test(bad), `${bad} must be rejected`).toBe(false);
    }
  });

  it('only a store with an uploaded logo gets the seed — the rest are painted server-side', () => {
    // A store with no upload takes its generated mark's hue in the inline style on <header>,
    // so its rule never arrives late and a seed would be dead code.
    expect(HEADER).toContain('{storeHeader && storeLogo && (');
  });
});
