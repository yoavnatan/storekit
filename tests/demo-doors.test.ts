import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEMO_BUYER_EMAIL, DEMO_NEW_SELLER_EMAIL, DEMO_SELLER_EMAIL,
  DEMO_SHARED_EMAILS, isSharedDemoAccount,
} from '../src/lib/demo-mode.js';
import { NEW_SELLER_EMAIL, SHOWCASE_OWNER_EMAIL } from '../scripts/lib/seed-db.mjs';

/**
 * The three doors the demonstration hands out, and the two things that must stay true about them.
 *
 * **One: the spellings must agree across the language boundary.** The seeder is plain Node and
 * cannot import a `.ts` module, so every demo account's address exists twice — once in
 * `src/lib/demo-mode.ts` for the application, once in `scripts/lib/seed-db.mjs` for the seeder. The
 * failure when they drift is quiet and total: the seeder writes one account, the door looks up
 * another, and pressing "מוכר חדש" lands on a login form with "the demo account does not exist".
 *
 * **Two: a new account is a SHARED one.** Every rule about the tour's accounts — read-only writes,
 * locked credentials, kept by the visitor sweep — used to be spelled `a === x || a === y` in a
 * different module each. Adding the third door meant editing three of them, and missing one would
 * have left an account anybody can walk into that can also rewrite its own password and lock the
 * next visitor out. `DEMO_SHARED_EMAILS` is now the single list; this file is what stops a fourth
 * account being added without joining it.
 */

const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));

describe('the demo accounts', () => {
  it('are spelled the same in the application and in the seeder', () => {
    expect(DEMO_SELLER_EMAIL).toBe(SHOWCASE_OWNER_EMAIL);
    expect(DEMO_NEW_SELLER_EMAIL).toBe(NEW_SELLER_EMAIL);
  });

  it('all three count as shared, and nobody else does', () => {
    for (const email of [DEMO_SELLER_EMAIL, DEMO_NEW_SELLER_EMAIL, DEMO_BUYER_EMAIL]) {
      expect(isSharedDemoAccount(email), email).toBe(true);
      expect(DEMO_SHARED_EMAILS, email).toContain(email);
    }
    // The half that is easier to get wrong: a visitor who registered must be an ordinary seller.
    expect(isSharedDemoAccount('someone@gmail.com')).toBe(false);
    expect(isSharedDemoAccount('')).toBe(false);
    expect(isSharedDemoAccount(null)).toBe(false);
  });

  it('are read as a LIST by every rule about them, never re-spelled', () => {
    // Two modules carried their own `email === A || email === B`. Both now ask the one predicate,
    // and a third copy is how the next account gets missed.
    for (const file of ['src/lib/demo-viewer.ts', 'src/lib/seller-auth.ts']) {
      const source = readFileSync(root(file), 'utf8');
      expect(source, file).toContain('isSharedDemoAccount');
      expect(source, `${file} re-spells the account list`).not.toMatch(/DEMO_SELLER_EMAIL\s*\|\|/);
    }
  });
});

describe('the tour control', () => {
  const header = readFileSync(root('src/components/Header.astro'), 'utf8');
  const login = readFileSync(root('src/pages/seller/login.astro'), 'utf8');

  it('offers the new-seller door', () => {
    expect(header).toContain('value="new-seller"');
  });

  it('and the login page answers it', () => {
    // The pair that has broken before: a control posting a role the handler does not know just
    // falls through to the sign-in form, with no error and nothing to see (2026-08-27, the admin
    // door). Every value the header can post has to appear in the handler's map.
    const posted = [...header.matchAll(/name="demoRole" value="([^"]+)"/g)].map((m) => m[1]!);
    expect(posted.length).toBeGreaterThan(2);
    for (const role of posted) {
      expect(login, `the login page does not handle demoRole="${role}"`)
        .toMatch(new RegExp(`'${role}'`));
    }
  });
});

describe('the first-day shop the new-seller door opens', () => {
  const seeder = readFileSync(root('scripts/seed-portfolio.mjs'), 'utf8');

  it('is seeded UNPUBLISHED, or it turns up in the directory', () => {
    /* `stores.published_at` DEFAULTS to now() (migration 20260823_210421), because every store the
       application creates is meant to go up. A seeder writing a bare INSERT therefore gets a
       published shop by omission — which is exactly what happened on the first drive: an empty
       shop with one product, listed on the storefront beside the four curated ones. It has to say
       NULL out loud, on the insert AND on the conflict update, or a re-seed republishes it. */
    const insert = /INSERT INTO stores[\s\S]{0,600}?RETURNING id/.exec(seeder)?.[0] ?? '';
    expect(insert, 'the first-day shop must be inserted unpublished').toMatch(/published_at/);
    expect(insert).toMatch(/NULL/);
    expect(insert, 'a re-seed must not republish it').toMatch(/DO UPDATE[^`]*published_at = NULL/);
  });

  it('is marked demo, so the nightly visitor sweep does not take it', () => {
    // The sweep and the portfolio purge both delete "every store that is not a showcase store".
    // Without this flag the demonstration would lose its onboarding screen every night.
    expect(/INSERT INTO stores[\s\S]{0,600}?RETURNING id/.exec(seeder)?.[0] ?? '').toMatch(/demo/);
  });
});
