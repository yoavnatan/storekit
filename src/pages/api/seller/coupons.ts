export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { ownedStore } from '../../../lib/store-ownership.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { parseCouponInput, type CouponInput } from '../../../lib/coupon-input.js';
import {
  getCouponsByStore, createCoupon, updateCoupon, deleteCoupon,
} from '../../../lib/store-coupons.js';
import { isCouponLive, type StoreCoupon } from '../../../lib/coupons.js';

/**
 * The seller's coupon list — create / edit / delete, as JSON.
 *
 * Its own route rather than another `_action` branch in `/api/store`: that endpoint is the
 * settings FORM, merged field-by-field against a revision, and this is a collection of rows the
 * מבצעים tab edits one at a time without ever reloading the page (memory `feedback_ajax_forms`).
 * Same split, and the same reasoning, as `/api/seller/store-lifecycle`.
 *
 * Ownership comes from the SESSION's own store list on every verb, never from the body's
 * `storeId` — `store-ownership.ts` carries what that rule cost when a fallback handler forgot it.
 * `store-coupons.ts` then scopes each statement by `store_id` as well, so a foreign id fails twice.
 */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The row shape the dashboard renders. `live` is computed here rather than in the client so the
 *  seller's "פעיל / הסתיים / נוצל" badge is decided by the same function the checkout uses — a
 *  second date comparison in the browser is how a dashboard ends up disagreeing with the till. */
function view(c: StoreCoupon) {
  return { ...c, live: isCouponLive(c) };
}

interface CouponBody extends CouponInput {
  storeId?: unknown;
  couponId?: unknown;
  /** `delete`, or absent for a save. One verb field rather than a DELETE method because the
   *  dashboard's whole coupon UI is one `fetch` helper, and a method-per-verb buys nothing here. */
  _action?: unknown;
}

export const GET: APIRoute = async ({ url, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);
  const store = await ownedStore(sellerId, url.searchParams.get('storeId') ?? '');
  if (!store) return json({ ok: false, error: 'החנות לא נמצאה.' }, 404);
  return json({ ok: true, coupons: (await getCouponsByStore(store.id)).map(view) });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const read = await readJsonBody<CouponBody>(request, BODY_LIMIT.control);
  if (!read.ok) return json({ ok: false, error: 'Invalid JSON body' }, read.status);
  const body = read.value;

  const store = await ownedStore(sellerId, String(body.storeId ?? ''));
  if (!store) return json({ ok: false, error: 'החנות לא נמצאה.' }, 404);

  const couponId = String(body.couponId ?? '').trim();

  if (String(body._action ?? '') === 'delete') {
    if (!couponId) return json({ ok: false, error: 'Missing couponId' }, 400);
    // Deleted rather than deactivated, and that is safe here BECAUSE the coupon is not the record
    // of anything: an order that used one stored the code and the money on its own row
    // (`order_stores.coupon_code`), so removing the coupon cannot rewrite a past order's total.
    const gone = await deleteCoupon(store.id, couponId);
    if (!gone) return json({ ok: false, error: 'הקוד לא נמצא.' }, 404);
    return json({ ok: true, coupons: (await getCouponsByStore(store.id)).map(view) });
  }

  const parsed = parseCouponInput(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error, field: parsed.error }, 400);

  const saved = couponId
    ? await updateCoupon(store.id, couponId, parsed.value)
    : await createCoupon(store.id, parsed.value);

  // `null` from either write means the same thing to the seller and needs two different sentences,
  // so the reason is named: a create collides with an existing code (the unique index refused it),
  // an update names a row that is not theirs or no longer exists.
  if (!saved) {
    return couponId
      ? json({ ok: false, error: 'הקוד לא נמצא.' }, 404)
      : json({ ok: false, error: 'duplicate', field: 'code' }, 409);
  }

  return json({ ok: true, coupon: view(saved), coupons: (await getCouponsByStore(store.id)).map(view) });
};
