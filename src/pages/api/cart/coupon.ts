export const prerender = false;
import type { APIRoute } from 'astro';
import { getStoreBySlugOrPrevious, canStoreSell } from '../../../lib/stores.js';
import { getCouponByCode } from '../../../lib/store-coupons.js';
import { isCouponLive, publicCoupon, normalizeCouponCode } from '../../../lib/coupons.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { clientIp } from '../../../lib/client-ip.js';
import { checkAuthRate, countAuthAttempt, couponLookupRules } from '../../../lib/rate-limit.js';

/**
 * "Is this code real?" — the buyer's side, and only that.
 *
 * It returns the code's TERMS, never a money figure, and the difference is deliberate. The
 * checkout page already holds every line at a server-resolved price (`/api/cart/prices`), and
 * `lib/coupons.ts` is pure and isomorphic exactly like `discounts.ts` — so the page applies the
 * terms itself and shows the buyer a number derived by the same function `/api/checkout` will use
 * to charge one. Asking this endpoint for the amount instead would mean re-sending the cart, and
 * re-pricing it a second way, to arrive at the number the client could already compute.
 *
 * What it must never become is an oracle. `unknown` covers "no such code", "switched off" and "out
 * of its dates" as one answer, and the lookup is throttled per store per address — a coupon code
 * is a short human-typable secret on a public endpoint, which is a guessing surface even though it
 * is not a credential (`rate-limit.ts#couponLookupRules`).
 */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const read = await readJsonBody<{ storeSlug?: unknown; code?: unknown }>(request, BODY_LIMIT.control);
  if (!read.ok) return json({ ok: false, reason: 'unknown' }, read.status);

  const storeSlug = typeof read.value.storeSlug === 'string' ? read.value.storeSlug.trim() : '';
  const code = normalizeCouponCode(read.value.code);
  if (!storeSlug || !code) return json({ ok: false, reason: 'unknown' }, 400);

  const rules = couponLookupRules(storeSlug, clientIp(request, clientAddress));
  const gate = await checkAuthRate(rules);
  // Throttled answers are the SAME shape as a wrong code, plus a flag the page uses to say "try
  // again in a moment" instead of "wrong code" — a buyer whose real code is refused because a
  // neighbour was guessing deserves to know it was not their code that failed.
  if (!gate.allowed) return json({ ok: false, reason: 'unknown', throttled: true, retryAfterSec: gate.retryAfterSec }, 429);

  const store = await getStoreBySlugOrPrevious(storeSlug);
  // A store that cannot sell has no valid codes by definition, and answering differently for a
  // paused shop would leak its state to anyone probing.
  const coupon = store && canStoreSell(store) ? await getCouponByCode(store.id, code) : null;

  if (!coupon || !isCouponLive(coupon)) {
    await countAuthAttempt(rules);
    return json({ ok: false, reason: 'unknown' }, 404);
  }

  // A correct code does not count against the limit — same protocol as a successful sign-in, and
  // it is what keeps a shopper who re-opens their cart five times from throttling themselves.
  return json({ ok: true, coupon: publicCoupon(coupon) });
};
