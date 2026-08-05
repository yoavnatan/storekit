import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The store-colour bar under the header must stay tied to a real store.
 *
 * `.site-header--store` is the LAYOUT class, and thirteen pages that are not a
 * store ask for that layout — the homepage, /stores, /search, /checkout, 404,
 * seller login/register/dashboard and every admin screen. While the bar was
 * selected on the class alone, every one of them wore it in its no-colour
 * fallback: a 2px rgb(140,147,161) line where the whole rest of the site draws a
 * 1px --color-border hairline. Measured on the built page, that is what "the
 * header's line doesn't match the site's lines" was (owner, 2026-08-05).
 *
 * The gate is `[data-glow-host]`, set by Header.astro only when the header
 * actually carries a store's name and slug. Both halves are asserted here: the
 * CSS must ask for the attribute, and the component must not start setting it on
 * headers that have no store — either one alone would let the bar leak back.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('the store-colour header bar', () => {
  const css = read('src/styles/components/header.css');
  const header = read('src/components/Header.astro');

  it('is selected on the store marker, not on the layout class', () => {
    const selectors = [...css.matchAll(/^([^{}\n][^{}]*)\{/gm)]
      .map((m) => m[1].trim())
      .filter((s) => /\.site-header--store[^,]*::after/.test(s));

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toContain('[data-glow-host]');
    }
  });

  it('marks a header as a colour host only when it has a store to be', () => {
    expect(header).toMatch(/const storeHeader = storeMode && !!storeName && !!storeSlug/);
    expect(header).toMatch(/data-glow-host=\{storeHeader \? '' : undefined\}/);
  });

  it('leaves every other header on the site drawing the shared 1px hairline', () => {
    expect(css).toMatch(/\.site-header\s*\{[^}]*border-bottom:\s*1px solid var\(--color-border\)/);
  });
});
