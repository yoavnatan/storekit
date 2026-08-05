import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The header has ONE bottom line — the shared 1px `--color-border` hairline — on every page of
 * this site, store or not. This test exists to stop the store-colour bar coming back.
 *
 * It was a 2px line in the store's own colour, and it was reasoned about four times in two days
 * before it went. The first version selected on `.site-header--store`, which is the LAYOUT class:
 * thirteen pages that are not a store ask for that layout (the homepage, /stores, /search,
 * /checkout, 404, seller login/register/dashboard and every admin screen) and all of them wore the
 * bar in its no-colour grey fallback, against a site whose every other line is a 1px hairline.
 * Narrowing it to `[data-glow-host]` fixed that and exposed the real problem underneath: the
 * colour is read off the uploaded logo's pixels ON THE CLIENT, so it cannot be right at first
 * paint. The bar painted grey and became the store's colour a third of a second later, on every
 * store load — "תמיד בטעינת חנות הוא שחור בהתחלה ורק אחר כך מתחלף לצבע, זו לא התנהגות טובה"
 * (owner, 2026-08-05). A sessionStorage pre-paint seed fixed only the second visit onwards; a
 * `data-glow-pending` attribute traded the colour change for the line appearing. Each attempt
 * added a mechanism instead of removing the cause, so the owner removed the cause:
 * "אם זה מסבך את העניינים אולי שווה לוותר על הפס הצבעוני הזה."
 *
 * The store's colour still exists where it works — the halo on the store's own CARD, which is
 * decoration on a surface the shopper is looking at, not chrome that follows them from page to
 * page. If a future session wants store identity in the header, it needs a colour the SERVER
 * knows at render time; anything sampled on the client reproduces exactly this bug.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('the header bottom line', () => {
  const css = read('src/styles/components/header.css');
  const header = read('src/components/Header.astro');

  it('is the shared 1px hairline, on every page', () => {
    expect(css).toMatch(/\.site-header\s*\{[^}]*border-bottom:\s*1px solid var\(--color-border\)/);
  });

  it('draws no second line under the header — no ::after on any .site-header rule', () => {
    const selectors = [...css.matchAll(/^([^{}\n][^{}]*)\{/gm)]
      .map((m) => m[1].trim())
      .filter((s) => /\.site-header[^,]*::(after|before)/.test(s));
    expect(
      selectors,
      'A generated line under the header is the store-colour bar coming back. It cannot be ' +
        "right at first paint — read this file's header comment before re-adding it.",
    ).toEqual([]);
  });

  it('the header hosts no store colour: no --store-glow, no data-glow-host', () => {
    expect(header).not.toMatch(/--store-glow/);
    expect(header).not.toMatch(/data-glow-host=/);
  });

  it('still knows when it is standing in a real store — that drives the lockup, not a colour', () => {
    expect(header).toMatch(/const storeHeader = storeMode && !!storeName && !!storeSlug/);
  });

  it('the sampler is asked for by the store card alone, not by the layout', () => {
    // Shipping the document-wide image pass from the header would put it on every page.
    expect(header).not.toMatch(/^\s*initStoreGlow\(\);/m);
    expect(read('src/components/StoreCard.astro')).toMatch(/initStoreGlow\(\);/);
  });
});
