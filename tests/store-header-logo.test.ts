/**
 * A seller's own logo at the top of their store, and the one promise the feature is built on:
 * **no image, of any shape, can change the height of the header bar.**
 *
 * That promise is not enforced by validating the upload — it cannot be, because a logo's aspect
 * ratio is exactly what a seller is entitled to choose. It is enforced by the BOX: both dimensions
 * are fixed in CSS, neither is read from the image, and the image is `contain`ed inside them. A
 * future edit that swaps `contain` for `cover`, or drops the height, or lets the width be `auto`,
 * breaks it silently — the page still renders, and the bar is simply the wrong height on every page
 * of that store, which is the site's most-seen element (`header-stability.test.ts` exists for the
 * same reason).
 *
 * So this asserts the declarations rather than a rendered pixel: a headless layout test would need
 * a real browser, real fonts and a real image to say anything, and it would still only test the
 * ratios it happened to try.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeHeaderLogo, type Store } from '../src/lib/stores.js';
import { cdnContain } from '../src/lib/cdn.js';

const ROOT = process.cwd();
const headerCss = readFileSync(join(ROOT, 'src/styles/components/header.css'), 'utf8');
const headerAstro = readFileSync(join(ROOT, 'src/components/Header.astro'), 'utf8');

/** The `.store-header__brand` rule body — the box the logo is drawn into. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} is gone from header.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('the logo box cannot move the bar', () => {
  const box = ruleBody(headerCss, '.store-header__brand');
  const img = ruleBody(headerCss, '.store-header__brand img');

  it('fixes the height, and inside the header\'s own spare padding', () => {
    // 40px, raised from 32px on 2026-08-09 ("זה קטן מדי"), and the ceiling is arithmetic rather
    // than taste: the row is `height: 2rem` (a FIXED height — its own rule says taller children
    // overflow instead of resizing it) inside a 3.4rem header whose padding is
    // `calc((3.4rem - 1px - 2rem) / 2)` = 10.7px a side. A 40px box centred in a 32px row overflows
    // 4px a side, so it sits 6.7px clear of the header's edge and the bar does not move. 48px is
    // the first value that spends the whole margin — so this assertion is the guard, and the two
    // below are the numbers it depends on.
    expect(box).toMatch(/height:\s*40px/);
    expect(headerCss).toMatch(/\.site-header \.container \{ height: 2rem;/);
    expect(headerCss).toMatch(/padding-block: calc\(\(3\.4rem - 1px - 2rem\) \/ 2\)/);
    // A clipping header would turn the overflow above into a cropped logo rather than a visible one.
    expect(ruleBody(headerCss, '.site-header')).not.toMatch(/overflow:\s*hidden/);
  });

  it('caps the width, so a wide wordmark cannot eat the row', () => {
    // A mobile number: at 375px this row is logo + search + actions. Desktop gets 14rem, where the
    // search has its own grid column and the extra width costs nothing.
    expect(box).toMatch(/max-width:\s*min\(100%,\s*11rem\)/);
    expect(headerCss).toMatch(/\.store-header__brand \{ max-width: min\(100%, 14rem\); \}/);
    // `min-width: 0` is what stops an <img>'s intrinsic width becoming a min-content FLOOR that the
    // flex column has to honour — without it the cap above is advisory and a 2000px-wide logo
    // pushes the search out.
    expect(box).toMatch(/min-width:\s*0/);
  });

  it('CONTAINS the image — never covers it, never lets a dimension come from the file', () => {
    // `cover` would crop, which for a wordmark means losing its last letters, and for a symbol
    // means losing the symbol. The two `max-` rules plus `auto` are what make an 8:1 banner render
    // 176x22 (shorter, whole) instead of 176x32 (cropped) or 256x32 (a wider bar).
    expect(img).toMatch(/object-fit:\s*contain/);
    expect(img).not.toMatch(/object-fit:\s*cover/);
    expect(img).toMatch(/max-height:\s*100%/);
    expect(img).toMatch(/max-width:\s*100%/);
    expect(img).toMatch(/width:\s*auto/);
    expect(img).toMatch(/height:\s*auto/);
  });

  it('asks the CDN to contain it too, so the bytes match the box', () => {
    // Through `cdnContain`, not `cdnThumb`/`cdnBand`: those crop at the CDN, which would deliver an
    // already-mutilated logo that no amount of correct CSS could put back.
    expect(headerAstro).toContain('cdnContain(storeHeaderLogo,');
    expect(cdnContain('https://res.cloudinary.com/demo/image/upload/v1/a.png', 480, 64))
      .toContain('c_limit,f_auto,q_auto,w_480,h_64');
  });

  it('keeps the store NAME reachable when the text is replaced by a picture', () => {
    // The name is the link's aria-label, so a screen reader and a crawler still get the shop's
    // name. Losing it would be an accessibility regression AND an SEO one on every store page.
    expect(headerAstro).toMatch(/store-name-link--logo"\s+aria-label=\{storeName\}/);
  });
});

describe('storeHeaderLogo — an upload is not a choice, and a choice is not an upload', () => {
  const s = (extra: Partial<Store>): Pick<Store, 'headerStyle' | 'headerLogo'> => ({ ...extra } as Store);

  it('renders the logo only when the seller uploaded one AND chose it', () => {
    expect(storeHeaderLogo(s({ headerStyle: 'logo', headerLogo: 'https://x/logo.png' }))).toBe('https://x/logo.png');
  });

  it('ignores an upload the seller has not chosen', () => {
    // The two columns are separate so a seller can try a logo, go back to the name, and still have
    // the file. That only works if uploading alone changes nothing on the storefront.
    expect(storeHeaderLogo(s({ headerLogo: 'https://x/logo.png' }))).toBeUndefined();
  });

  it('never renders an empty bar when the choice outlives the file', () => {
    // Reachable in one save: remove the logo while 'logo' is still selected. The dashboard flips
    // the radio and /api/store re-narrows on write — this is the last of the three, and the one
    // every reader passes through.
    expect(storeHeaderLogo(s({ headerStyle: 'logo' }))).toBeUndefined();
  });

  it('is the default for every store that never chose', () => {
    expect(storeHeaderLogo(s({}))).toBeUndefined();
  });
});
