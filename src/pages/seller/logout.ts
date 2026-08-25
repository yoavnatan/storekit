export const prerender = false;
import type { APIContext } from 'astro';
import { clearSellerSession } from '../../lib/seller-auth.js';
import { safeRedirectPath } from '../../lib/safe-redirect.js';
import { machineUrl } from '../../lib/url-base.js';

/**
 * Signing out, and WHERE it leaves him.
 *
 * The seller dashboard posts its own path as `_next`, so signing out from it lands on the login
 * page carrying that path — and signing back in returns him to the screen he left rather than to
 * the homepage (owner, 2026-08-25: *"ההתחברות חייבת לפעול כך שהיא תמיד תחזיר את היוזר לעמוד בו הוא
 * היה"*). A `_next` that is a SELLER path is turned into a login URL rather than followed, because
 * following it would bounce a just-signed-out visitor off a page he can no longer see.
 *
 * `_next` is as attacker-controlled as `?next=` — a form on someone else's page can post here —
 * so it goes through `safe-redirect` before any of that, like every other request-supplied
 * destination on this site.
 */
export async function POST({ cookies, request, redirect }: APIContext): Promise<Response> {
  clearSellerSession(cookies);
  const form = await request.formData();
  const next = safeRedirectPath(String(form.get('_next') || ''), '/');
  if (next.startsWith('/seller/') && !next.startsWith('/seller/login')) {
    // Through `machineUrl`, like every interpolated destination on this site: a raw non-ASCII
    // character in a `Location` header THROWS a 500 (`url-base.ts`), and a store slug carries
    // Hebrew by design. `tests/external-contract.test.ts` scans for exactly this shape.
    return redirect(machineUrl(`/seller/login?next=${encodeURIComponent(next)}`));
  }
  return redirect(next);
}
