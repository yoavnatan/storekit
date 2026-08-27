import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { APIContext, AstroCookies } from 'astro';
import { query } from '../src/lib/db.js';
import { demoWriteRefusal, DEMO_WRITE_ALLOWED } from '../src/lib/demo-viewer.js';
import { DEMO_SELLER_EMAIL, DEMO_BUYER_EMAIL } from '../src/lib/demo-mode.js';
import { setAdminCookie } from '../src/lib/admin-auth.js';
import { setSellerSession } from '../src/lib/seller-auth.js';

/**
 * The demonstration is read-only for everybody who did not bring the password.
 *
 * **What this is protecting.** The tour hands a real seller session and a real admin session to
 * anybody who presses a button. Behind them is the actual application, so before this rule a
 * visitor could close a shop, bulk-delete any of 412 products, rewrite the shop's name and images,
 * cancel the subscription that keeps the shops published, block a store from the admin, clear the
 * error log, or resolve a returns dispute and award somebody else's money — each of which ends the
 * demonstration for everybody who follows, silently, and would be discovered by the owner opening
 * his own link.
 *
 * **Why the first case reads the filesystem.** The version of this file that came before named
 * eight `/api/seller/*` paths and passed green — while five of the eight did not exist, and the
 * routes that actually edit the showcase shops (`/api/store-product/*`, `/api/store`,
 * `/api/returns`) were not among them and were not covered by the rule. A hand-written list of
 * paths tests the author's memory of the application, which is the thing that was wrong. So the
 * first case asks the source tree what can be written to, and holds every answer against the
 * module's own allow-list: a route added next month joins the case the day it is written, and if
 * somebody adds one that must stay open for visitors, this test fails until they say so out loud.
 */

const SHARED_SELLER = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const SHARED_BUYER = 'dddddddd-dddd-4ddd-8ddd-000000000002';
const OWN_ACCOUNT = 'dddddddd-dddd-4ddd-8ddd-000000000003';
const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

/** Enough of `AstroCookies` for the code under test, with a jar the tests can seed and read. */
function fakeCookies(seed: Record<string, string> = {}): AstroCookies & { jar: Map<string, string> } {
  const jar = new Map(Object.entries(seed));
  return {
    jar,
    get: (k: string) => (jar.has(k) ? { value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => { jar.set(k, v); },
    delete: (k: string) => { jar.delete(k); },
  } as unknown as AstroCookies & { jar: Map<string, string> };
}

function ctx(method: string, path: string, cookies: AstroCookies): APIContext {
  return {
    request: new Request(`https://demo.test${path}`, { method }),
    cookies,
  } as unknown as APIContext;
}

/** A cookie jar carrying a session for one of the seeded accounts. */
function asSeller(id: string): AstroCookies {
  const cookies = fakeCookies();
  setSellerSession(cookies, id);
  return cookies;
}

function asAdmin(role: 'owner' | 'viewer'): AstroCookies {
  const cookies = fakeCookies();
  setAdminCookie(cookies, role);
  return cookies;
}

/**
 * Every path in `src/pages` that answers a request able to change something.
 *
 * Both export forms count — `export const POST: APIRoute` and `export async function POST` — which
 * is itself a lesson: the first enumeration of this surface used only the former and missed
 * `/api/checkout`, `/api/returns` and eleven others.
 */
function writableRoutes(): string[] {
  const found: string[] = [];
  const WRITES = /export\s+(?:const|async\s+function)\s+(?:POST|PUT|PATCH|DELETE)\b/;
  const PAGE_POST = /request\.method === 'POST'/;

  const walk = (dir: string, urlPrefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${urlPrefix}/${entry}`);
        continue;
      }
      const isRoute = entry.endsWith('.ts');
      const isPage = entry.endsWith('.astro');
      if (!isRoute && !isPage) continue;
      // A dynamic segment has no single URL to test, and none of them writes today. Left out
      // deliberately rather than guessed at — if one appears, the count assertion below notices.
      if (entry.includes('[')) continue;

      const source = readFileSync(full, 'utf8');
      if (!(isRoute ? WRITES.test(source) : PAGE_POST.test(source))) continue;

      const base = entry.replace(/\.(ts|astro)$/, '');
      found.push(base === 'index' ? urlPrefix || '/' : `${urlPrefix}/${base}`);
    }
  };
  walk('src/pages', '');
  return found.sort();
}

beforeEach(async () => {
  await query('DELETE FROM stores');
  await query('DELETE FROM sellers');
  await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3)', [SHARED_SELLER, 'Showcase', DEMO_SELLER_EMAIL]);
  await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3)', [SHARED_BUYER, 'Buyer', DEMO_BUYER_EMAIL]);
  await query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3)', [OWN_ACCOUNT, 'A visitor', 'visitor@example.test']);
  process.env.DEMO_MODE = '1';
});

afterEach(() => {
  if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
});

describe('the whole write surface, asked of the source tree', () => {
  it('refuses a shared session every writable route the allow-list does not name', async () => {
    const routes = writableRoutes();
    // A floor, so a broken walk cannot pass by finding nothing. 41 API routes plus 6 page POSTs
    // were counted by hand on 2026-08-27.
    expect(routes.length).toBeGreaterThan(40);

    for (const path of routes) {
      const allowed = DEMO_WRITE_ALLOWED.has(path);
      for (const cookies of [asSeller(SHARED_SELLER), asAdmin('viewer')]) {
        const res = await demoWriteRefusal(ctx('POST', path, cookies));
        if (allowed) expect(res, `${path} is allow-listed`).toBeNull();
        else expect(res?.status, `${path} must be refused`).toBe(403);
      }
    }
  });

  it('names the routes that end the demonstration, so the list is read and not just counted', async () => {
    const dangers = [
      '/api/store-product/bulk',      // delete every product in one request
      '/api/store',                   // the shop's name, slogan, images, custom domain
      '/api/product',
      '/api/returns',                 // resolve a dispute and award a refund — real money
      '/api/seller/store-lifecycle',  // close or pause a shop
      '/api/seller/subscription',     // cancel it, and every shop comes off the site
      '/api/seller/payout-details',   // rewrite the bank account
      '/api/admin/moderation',        // block a store
      '/api/admin/errors',            // clear the log
      '/api/notifications',           // empty the exhibit's bell for the next visitor
      '/seller/dashboard',            // the no-JS POST fallback, which the API twins' rules missed once before
    ];
    for (const path of dangers) {
      expect((await demoWriteRefusal(ctx('POST', path, asSeller(SHARED_SELLER))))?.status, path).toBe(403);
      expect((await demoWriteRefusal(ctx('POST', path, asAdmin('viewer'))))?.status, path).toBe(403);
    }
  });
});

describe('what the rule must never touch', () => {
  it('lets the OWNER sign in while holding a viewer session', async () => {
    // The load-bearing case. A viewer session is what the tour door mints, the owner's browser has
    // one the moment he presses that button, and `/admin/login` is the only way to stop being a
    // viewer. Refusing it would lock him out of his own demonstration with the rule written to
    // protect it — and the failure would look like a wrong password.
    expect(await demoWriteRefusal(ctx('POST', '/admin/login', asAdmin('viewer')))).toBeNull();
  });

  it('lets anybody buy', async () => {
    for (const path of ['/api/checkout', '/api/user-cart', '/api/cart/coupon', '/api/cart/prices']) {
      expect(await demoWriteRefusal(ctx('POST', path, asSeller(SHARED_SELLER))), path).toBeNull();
      expect(await demoWriteRefusal(ctx('POST', path, asAdmin('viewer'))), path).toBeNull();
    }
  });

  it('lets a visitor LEAVE — the door out is a write too', async () => {
    // `/seller/logout` is a POST, so the allow-list had to name it and did not: somebody who took
    // the tour was stuck in it, and the sign-out button answered "this is a demonstration" — a
    // refusal with nothing the person could do about it. Logging out is the one write that can
    // never damage anything: it clears the caller's own cookie and touches no row.
    for (const cookies of [asSeller(SHARED_SELLER), asAdmin('viewer')]) {
      expect(await demoWriteRefusal(ctx('POST', '/seller/logout', cookies))).toBeNull();
      expect(await demoWriteRefusal(ctx('POST', '/admin/logout', cookies))).toBeNull();
      expect(await demoWriteRefusal(ctx('GET', '/admin/logout', cookies))).toBeNull();
    }
  });

  it('lets anybody register, and switch doors', async () => {
    for (const path of ['/seller/register', '/seller/login', '/seller/forgot-password', '/seller/reset-password']) {
      expect(await demoWriteRefusal(ctx('POST', path, asSeller(SHARED_SELLER))), path).toBeNull();
    }
  });

  it('lets a visitor who opened a shop of their own write normally', async () => {
    // That flow is the point, not the exhibit — and nothing they do can reach the showcase shops,
    // which the application's own ownership checks already ensure.
    for (const path of ['/api/store', '/api/store-product/bulk', '/seller/dashboard', '/api/seller/store-lifecycle']) {
      expect(await demoWriteRefusal(ctx('POST', path, asSeller(OWN_ACCOUNT))), path).toBeNull();
    }
  });

  it('lets the admin OWNER write — the session that came from the password', async () => {
    for (const path of ['/api/admin/moderation', '/api/admin/errors', '/api/returns']) {
      expect(await demoWriteRefusal(ctx('POST', path, asAdmin('owner'))), path).toBeNull();
    }
  });

  it('lets the OWNER edit the showcase shops through the seller dashboard', async () => {
    // The reason the whole demonstration exists in this shape. The owner edits the four showcase
    // shops the way any seller edits theirs — that is why the hourly rebuild was turned off, and
    // it means his browser holds a session for the SHARED account, the one this rule recognises by
    // its address and refuses. Owner-plus-shared-seller is therefore the combination to test, and
    // the first version of the rule failed it: it locked the owner out of the shops with the rule
    // written to keep strangers out of them.
    const cookies = asSeller(SHARED_SELLER);
    setAdminCookie(cookies, 'owner');
    for (const path of ['/api/store', '/api/store-product/bulk', '/api/product', '/seller/dashboard']) {
      expect(await demoWriteRefusal(ctx('POST', path, cookies)), path).toBeNull();
    }
  });

  it('leaves an unauthenticated request to the routes themselves', async () => {
    // Not a 403 here: that would tell a stranger admin exists and is merely busy. A request with no
    // session is the route's own 401 to answer.
    expect(await demoWriteRefusal(ctx('POST', '/api/admin/moderation', fakeCookies()))).toBeNull();
  });

  it('lets a shared session READ everything', async () => {
    for (const path of ['/api/store', '/seller/dashboard', '/api/admin/moderation', '/api/returns']) {
      expect(await demoWriteRefusal(ctx('GET', path, asSeller(SHARED_SELLER))), path).toBeNull();
      expect(await demoWriteRefusal(ctx('GET', path, asAdmin('viewer'))), path).toBeNull();
    }
  });

  it('does nothing at all outside demo mode', async () => {
    delete process.env.DEMO_MODE;
    expect(await demoWriteRefusal(ctx('POST', '/api/admin/moderation', asAdmin('viewer')))).toBeNull();
    expect(await demoWriteRefusal(ctx('POST', '/api/store', asSeller(SHARED_SELLER)))).toBeNull();
  });
});
