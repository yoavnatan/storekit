/**
 * A shopper-facing store page is the STORE's page, in every slot that names it.
 *
 * The rule (owner, 2026-08-13): a shopper with six tabs open is looking at six shops, not six
 * pages of ours — so the tab's icon, the tab's TEXT and the card a shopper forwards all belong to
 * the store, and none of them says "Dezabin". The favicon half has been true since the store
 * favicon shipped; the title half was not, and the gap was invisible because each half was
 * internally consistent.
 *
 * Guarded by reading the source rather than by rendering, because the two halves live in two
 * components (`BaseLayout.astro` decides, `Seo.astro` renders) and the failure this protects
 * against is exactly them drifting apart — one gate for the icon and a different one for the
 * title, which no page-level test would call wrong.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8');

const seo = read('components/Seo.astro');
const baseLayout = read('layouts/BaseLayout.astro');
const seoField = read('lib/product-seo-field.ts');

describe('the store owns its own title', () => {
  it('Seo.astro drops the platform suffix when the page is the store’s', () => {
    expect(seo).toContain('storeOwned');
    // The whole rule in one expression: with `storeOwned`, the title is the page's own and nothing
    // is appended to it.
    expect(seo).toMatch(/storeOwned\s*\?\s*title\s*:\s*`\$\{title\}\s*\|\s*\$\{store\.name\}`/);
  });

  it('is decided by the SAME gate as the store’s favicon, in one place', () => {
    // A second spelling of "is this a store page" is how the icon and the title end up disagreeing
    // — which is the only way this rule can half-apply.
    expect(baseLayout).toMatch(/const storeOwnsThisPage = !!storeSlug && !sellerMode;/);
    expect(baseLayout).toMatch(/const storeIcon =\s*\n\s*storeOwnsThisPage/);
    expect(baseLayout).toContain('storeOwned={storeOwnsThisPage}');
    // `storeMode` is the LAYOUT — thirteen pages of ours ask for it — so it must never become the
    // gate for ownership.
    expect(baseLayout).not.toContain('storeOwned={storeMode}');
  });

  it('the seller’s SEO preview promises the tag the page really renders', () => {
    // The dashboard shows the seller what their title will be. It said `<product> | <store>` while
    // the page rendered `<product> — <store> | Dezabin`, so it was wrong in both directions at
    // once; it is only worth anything if it stays exactly what the page emits.
    expect(seoField).toContain('`${input.name} — ${preview.storeName}`');
    expect(seoField).not.toMatch(/\$\{input\.name\}\s*\|/);
  });
});
