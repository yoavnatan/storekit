export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { startSubscription, endSubscription, subscriptionFor } from '../../../lib/seller-subscription.js';
import { syncStorePublication, publishHoldsFor } from '../../../lib/store-publication.js';
import { store as platform } from '../../../config/store.config.js';

/**
 * The seller's monthly subscription — start it, or stop it.
 *
 * ── What this actually is ──
 * The one thing a seller owes us that has a collection path (GO_LIVE §3.0.1), and — since 2026-08-23
 * — one of the two things holding his shop off the site (`store-publication.ts`). So this route is
 * not a billing screen's plumbing; it is the button that publishes a shop.
 *
 * ── Scope ──
 * The session proves an ACCOUNT and a subscription belongs to one (`pricing.ts`: per registered
 * business, never per store), so the seller id comes from the cookie and nothing in the body decides
 * whose card is charged. There is no store id here and there must not be.
 *
 * ── The tier is NOT taken from the request ──
 * `startSubscription` reads `Seller.tier`, which `/api/seller/tier` owns. A plan id arriving here
 * would let a body choose what a seller is billed — the same class as a client-sent price at
 * checkout, and answered the same way: the server reads what it stored.
 *
 * ── Why the answer is usually a URL ──
 * PayMe return their own payment page unless we hand them a card token, and we cannot: Hosted Fields
 * need our merchant's `seller_public_key` and it was never stored (`seller-subscription.ts`'s
 * header). So the honest response is "go here", and the payment is picked up afterwards by the
 * callback and by the publication sweep — neither of which trusts the browser coming back.
 */

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const read = await readJsonBody<{ action?: string }>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);

  if (read.value.action === 'cancel') {
    // Deliberately does NOT take the shop down — `endSubscription`'s header says why: un-publishing
    // a live shop is a decision with a shopper mid-cart on the other side of it, and it belongs to
    // the module that owns the whole lifecycle.
    const stopped = await endSubscription(sellerId);
    return json({ ok: stopped, subscription: await subscriptionFor(sellerId) });
  }

  const started = await startSubscription(sellerId, {
    // Named per subscription rather than left to a setting in a panel nobody in this repo can see —
    // the same rule the checkout follows for its sale callback.
    callbackUrl: `${platform.url}/api/payme/callback`,
    // Where PayMe send him back after paying. The Payments tab, which is where he pressed the
    // button and where the result is about to appear.
    returnUrl: `${platform.url}/seller/dashboard?panel=payouts`,
  });

  if (started.status === 'failed') return json({ ok: false, error: started.error }, 502);
  if (started.status === 'not-configured') return json({ ok: false, error: 'not-configured' }, 503);
  if (started.status === 'no-collection-account') return json({ ok: false, error: 'no-collection-account' }, 503);

  // Only meaningful on the token route, where the first charge already went through. On the hosted
  // page it publishes nothing — correctly, because nobody has paid yet.
  const published = await syncStorePublication(sellerId);

  return json({
    ok: true,
    subscription: started.subscription,
    // `pending` carries a URL too, and it is the SAME subscription rather than a second one — the
    // seller closed PayMe's tab and pressed the button again, which must not bill him twice.
    ...((started.status === 'ok' || started.status === 'pending') && started.payUrl ? { payUrl: started.payUrl } : {}),
    holds: await publishHoldsFor(sellerId),
    published,
  });
}
