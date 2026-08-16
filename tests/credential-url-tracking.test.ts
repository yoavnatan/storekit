/**
 * A page whose URL can carry a CREDENTIAL must not load a third party's tag.
 *
 * ── The finding this came from (row 4 re-audit, 2026-08-16) ──
 * The forgot-password flow was built on 2026-08-14, eight days after row 4 was audited, so no
 * review had ever read it: the reset link must arrive as `?token=<64 hex>` — a mail can only carry
 * a link — and `BaseLayout` puts GTM and the Meta Pixel on every page it renders. Neither of them
 * leaks through the `Referer` header (browsers trim that to the origin cross-site); they report the
 * page's own href, query string and all, as GA4's `page_location` and the Pixel's `dl`. So a live
 * reset token would have been copied into Google's and Meta's logs inside the sixty minutes it is
 * valid, readable by anyone with access to either account, with nothing on our side recording that
 * it happened.
 *
 * It had not fired yet only because both tag ids in `store.config.ts` are still empty. Wiring them
 * is GO_LIVE §2.5 and a launch blocker, which is exactly the shape of bug this repo keeps meeting:
 * correct today, wrong the moment an unrelated switch is thrown, and by then nobody remembers the
 * two facts are connected.
 *
 * ── Why the scan is for the SHAPE and not for that page ──
 * Naming `reset-password.astro` would pass forever and protect nothing. What the class needs is the
 * rule stated over the whole tree: if a page reads a credential-shaped parameter out of its own
 * URL, its layout call says `noTracking`. The next flow that mails somebody a link — a buyer's
 * order-status link, an invite, an unsubscribe — then fails here on the day it is written.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PAGES = join(process.cwd(), 'src/pages');

/** Query parameters that carry a secret rather than a preference. `next`/`panel`/`store` are not
 *  here on purpose — they name a destination, and a destination is not a credential. */
const CREDENTIAL_PARAMS = ['token', 'code', 'secret', 'key', 'otp'];

function astroPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...astroPages(full));
    else if (entry.endsWith('.astro')) out.push(full);
  }
  return out;
}

/** `searchParams.get('token')` and friends — how a page reads its own URL. */
function readsCredentialFromUrl(source: string): string | null {
  for (const param of CREDENTIAL_PARAMS) {
    if (new RegExp(`searchParams\\.get\\(\\s*['"\`]${param}['"\`]`).test(source)) return param;
  }
  return null;
}

describe('a credential in the URL never reaches a third-party tag', () => {
  it('every page that reads one renders with noTracking', () => {
    const offenders: string[] = [];
    for (const file of astroPages(PAGES)) {
      const source = readFileSync(file, 'utf8');
      const param = readsCredentialFromUrl(source);
      if (!param) continue;
      // Pages that never reach BaseLayout (a bare redirect, a fragment) have no tag to suppress.
      if (!source.includes('<BaseLayout')) continue;
      if (!/<BaseLayout[^>]*\bnoTracking=\{true\}/s.test(source)) {
        offenders.push(`${file.slice(PAGES.length + 1)} reads ?${param} — its <BaseLayout> needs noTracking={true}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /** The other half: the flag has to actually gate all four tag insertions. A page could carry
   *  `noTracking` correctly while the layout ignored it, and the first test would still pass. */
  it('the layout gates every third-party tag on it', () => {
    const layout = readFileSync(join(process.cwd(), 'src/layouts/BaseLayout.astro'), 'utf8');
    // Both ids are computed through the flag, so all four insertion points (two head scripts, two
    // <noscript> fallbacks) go dark together — asserted at the source of the value rather than at
    // each use, since a fifth use added later would inherit it.
    expect(layout).toMatch(/const platformGtm\s*=\s*noTracking \?/);
    expect(layout).toMatch(/const platformPixel\s*=\s*noTracking \?/);
    expect(layout, 'the dataLayer push exists to be read by GTM — it goes with them')
      .toMatch(/const dlJson\s*=\s*dataLayer && !noTracking/);
  });

  /** And the finding's own page, pinned by name as well as by shape: this one is known to carry a
   *  token that sets a password, so a future edit dropping the flag should fail twice. */
  it('the password-reset page is covered', () => {
    const page = readFileSync(join(PAGES, 'seller/reset-password.astro'), 'utf8');
    expect(page).toContain('noTracking={true}');
  });
});
