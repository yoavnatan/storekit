import { describe, expect, it } from 'vitest';
import { sourceGuard } from './helpers/source-guard.js';

/**
 * The signed-in bounce on the login page must not swallow a POST.
 *
 * **The regression this exists for, and why nothing caught it.** `/seller/login` opens with "if you
 * already have a seller session there is nothing for you here, go to the dashboard". Correct for
 * somebody NAVIGATING to a login page — and it ran before everything, including the handler that
 * the demo's two doors post to. So the moment a visitor had used the seller door once, every later
 * press of the ADMIN door was bounced straight back to the seller dashboard: two controls, one
 * destination, no error anywhere (owner, 2026-08-27: *"גם דשבורד אדמין מגיע לדשבורד של המוכרים"*).
 *
 * It survived being driven in a real browser four separate times, because every one of those runs
 * started from a clean session — the single state in which the bug cannot happen. That is the whole
 * lesson: a guard on "already signed in" is only ever exercised by a test that is already signed
 * in, and it is easy to write a suite where nothing ever is.
 *
 * A source guard rather than a request test, and the trade-off is stated: an `.astro` page exports
 * no handler to call, so reaching the real behaviour needs a running server. What can be asserted
 * cheaply is the SHAPE — that the bounce is conditioned on the method — and `sourceGuard` makes the
 * rule prove it can reject the exact line that was there before.
 */
describe('the login page', () => {
  it('hands the tour door a VIEWER session, never an owner one', () => {
    /* The single line the whole read-only rule rests on. `setAdminCookie` defaults to `owner` —
       correct for the password form on `/admin/login`, and catastrophic here: this door is pressed
       by everybody who follows the link, and an owner session can block a store, clear the error
       log and delete a conversation. Dropping the argument is a one-character edit that nothing
       else would notice, which is exactly the kind this file exists to catch. */
    expect(sourceGuard({
      file: 'src/pages/seller/login.astro',
      rule: "the demo admin door mints a 'viewer' session",
      find: (text) => [...text.matchAll(/setAdminCookie\(([^)]*)\)/g)]
        .filter((m) => !m[1]!.includes("'viewer'"))
        .map((m) => m[0]),
      mustReject: 'setAdminCookie(Astro.cookies);',
    })).toEqual([]);
  });


  it('does not bounce a POST away before its handler runs', () => {
    expect(sourceGuard({
      file: 'src/pages/seller/login.astro',
      rule: 'the already-signed-in redirect is gated on the request method, so a demo door POST reaches its handler',
      // An `Astro.redirect` fired straight off `getSellerSession` with nothing else in the
      // condition is the shape that swallows every POST to this page.
      find: (text) => [...text.matchAll(/if\s*\(\s*getSellerSession\([^)]*\)\s*\)\s*return\s+Astro\.redirect/g)].map((m) => m[0]),
      mustReject: "if (getSellerSession(Astro.cookies)) return Astro.redirect('/seller/dashboard');",
    })).toEqual([]);
  });

  it('lets a VIEWER reach the admin password form — it is the only way to stop being one', () => {
    /* The same bounce, the same page shape, and the consequence is the owner's. `/admin/login`
       opened with `if (isAdminRequest(cookies)) return redirect('/admin')`, which was right while
       every admin session came from the password. The tour door mints a viewer, so the owner's own
       browser holds one the moment he takes the tour — and the bounce then sent his password POST
       to /admin without reading the password. The sign-in appeared to work, the session stayed
       read-only, and every save afterwards answered "this is a demonstration". Found by driving it,
       not by reading it: a live login with the CORRECT password left the viewer cookie in place. */
    expect(sourceGuard({
      file: 'src/pages/admin/login.astro',
      rule: 'the signed-in bounce checks for an OWNER, so a viewer can still sign in',
      find: (text) => [...text.matchAll(/if\s*\(\s*isAdminRequest\([^)]*\)\s*\)\s*\{?\s*return\s+Astro\.redirect/g)].map((m) => m[0]),
      mustReject: "if (isAdminRequest(Astro.cookies)) {\n  return Astro.redirect('/admin');\n}",
    })).toEqual([]);
  });
});
