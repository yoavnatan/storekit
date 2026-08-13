import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Coverage for routes that DO NOT EXIST YET.
//
// Every authorization rule in this repo is enforced by a test that names the surface it was written
// for — `store-ownership` sweeps catalogue mutations, `admin-auth` proves the cookie mechanism is
// sound, `csrf` and `request-body` sweep their own concerns. What none of them asks is the flat
// question this file asks: does EVERY route under `src/pages/api` establish who is calling before it
// writes anything? A route added next month is covered by that question on the day it is created,
// which is the only kind of coverage an unwritten file can have.
//
// Measured 2026-08-09 when this was written: nothing was wrong. Every API route passed, and the
// public POSTs below were public on purpose. That is the point — a guard is worth writing while the
// tree is green, because then a red line is always news.
//
// It earned itself within the hour: merging it onto main put it in contact with `cart/coupon.ts`,
// written by a parallel session, and it went red. That one turned out to be a POST that writes
// nothing — correctly public — so it joined the list with its reason. The guard did its job either
// way: a new route could not enter the tree without someone answering the question out loud.

const API_ROOT = join('src', 'pages', 'api');

function walk(dir: string, exts = ['.ts']): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), exts)
      : exts.some((x) => e.name.endsWith(x)) ? [join(dir, e.name)] : []);
}

const posix = (p: string): string => relative('.', p).replaceAll('\\', '/');

/** Anything that proves WHO is calling — a session, an admin cookie, an ownership resolution, or a
 *  provider signature on an inbound webhook. A route may use any of them; it may not use none.
 *
 *  KNOW WHAT THIS IS: a textual scan, so it proves the question was ASKED, not that it was answered
 *  correctly. A route that imports getSellerSession and ignores the result passes here. That is
 *  deliberate rather than a shortcut — deciding whether a check is *correct* is what
 *  store-ownership.test.ts and the per-route tests do, and they can only do it for a route someone
 *  wrote a test for. This one covers the routes nobody has thought about yet, and the cheapest
 *  honest thing it can assert about them is that authorization is mentioned at all. Do not read a
 *  green run here as "every route is authorized"; read it as "no route skipped the subject". */
const ESTABLISHES_IDENTITY =
  /getSellerSession|getUserSession|getBuyerSession|requireAdmin|isAdminRequest|ownedStore|ownedProduct|verifySignature/;

const MUTATING_HANDLER = /export (?:const|async function) (?:POST|PUT|PATCH|DELETE)\b/;

// Public by design, each for a reason that has to survive being read out loud. A route joins this
// list only with its reason written here — an entry with no sentence is the shape that rots.
const PUBLIC_BY_DESIGN: Record<string, string> = {
  'src/pages/api/analytics/event.ts':
    'anonymous page-view beacon — a shopper is not signed in, and requiring identity would mean tracking one',
  'src/pages/api/cart/prices.ts':
    'guest checkout must work; it reads prices from the DB and never trusts the posted ones, so there is nothing to own',
  'src/pages/api/cart/coupon.ts':
    'a POST that writes nothing — it asks "is this code real" for a guest, and POST only because the code travels in a body. Its exposure is guessing, not writing, and that is answered by couponLookupRules throttling plus a single `unknown` answer for every kind of miss',
  'src/pages/api/lang.ts':
    'writes the language cookie of whoever asked, and that is the whole blast radius',
  'src/pages/api/log-client-error.ts':
    'a browser reporting its own crash cannot be asked to authenticate; it is rate-limited instead (error-log-client-rate)',
  'src/pages/api/report.ts':
    'a visitor reporting a fault or improper content — requiring an account means the only reports that arrive are from people who were already fine, and a guest whose checkout broke is exactly who has something to say. It is rate-limited per address (rate-limit.ts#reportRules) and it takes NOTHING from the body about who the sender is: the role, the id and the store are resolved server-side from the session and the path (user-reports.ts)',
};

// Admin routes that legitimately answer before the cookie is valid.
const ADMIN_EXEMPT: Record<string, string> = {
  'src/pages/admin/logout.ts': 'clears the cookie — demanding a valid one to log out would strand a bad session',
};

describe('every API route establishes who is calling before it writes', () => {
  it('has no mutating route without a session, an admin cookie, an ownership check or a signature', () => {
    const offenders = walk(API_ROOT).filter((f) => {
      const rel = posix(f);
      if (rel in PUBLIC_BY_DESIGN) return false;
      const src = readFileSync(f, 'utf8');
      return MUTATING_HANDLER.test(src) && !ESTABLISHES_IDENTITY.test(src);
    }).map(posix);

    expect(offenders).toEqual([]);
  });

  it('keeps every public-by-design entry pointing at a route that still exists', () => {
    // A stale allowlist is worse than none: it exempts a path that may come back as something else.
    const gone = Object.keys(PUBLIC_BY_DESIGN).filter((rel) => !walk(API_ROOT).map(posix).includes(rel));
    expect(gone).toEqual([]);
  });

  it('gives every exemption a written reason', () => {
    const unexplained = [...Object.entries(PUBLIC_BY_DESIGN), ...Object.entries(ADMIN_EXEMPT)]
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([rel]) => rel);
    expect(unexplained).toEqual([]);
  });
});

describe('every admin surface is behind the admin cookie', () => {
  // `store-ownership.test.ts` skips `api/admin/**` on the stated assumption that admin routes "are
  // authorized by the admin cookie". Nothing was checking that assumption for any individual route,
  // so the exemption was load-bearing and unverified. This is the check it was leaning on.
  const adminSurfaces = (): string[] =>
    [...walk(join(API_ROOT, 'admin')), ...walk(join('src', 'pages', 'admin'), ['.ts', '.astro'])].map(posix);

  it('calls requireAdmin or isAdminRequest in every admin route and page', () => {
    const offenders = adminSurfaces().filter((rel) => {
      if (rel in ADMIN_EXEMPT) return false;
      return !/requireAdmin|isAdminRequest/.test(readFileSync(rel, 'utf8'));
    });
    expect(offenders).toEqual([]);
  });
});
