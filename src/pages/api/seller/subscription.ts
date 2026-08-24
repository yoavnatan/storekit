export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { startSubscription, endSubscription, subscriptionFor } from '../../../lib/seller-subscription.js';
import { armSubscriptionCard } from '../../../lib/subscription-arm.js';
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

  const read = await readJsonBody<{ action?: string; storeId?: unknown; token?: unknown }>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);

  /**
   * ── A card on file, charged only when the shop goes up (2026-08-24) ──
   *
   * The seller types his card into PayMe's own iframes on our page and hands us a TOKEN, which is
   * what this stores. **It charges nothing** — `generate-subscription` would charge immediately if
   * it were handed this token now, which is exactly the seven-day review week this change exists to
   * stop charging for (`lib/subscription-arm.ts`).
   *
   * The token is length-capped rather than pattern-matched, for the reason the checkout gives about
   * the same value: the format is PayMe's to change, and what must be bounded is the SIZE, because
   * without it a caller could push a quarter-megabyte string into an outbound request to them.
   */
  if (read.value.action === 'save-card') {
    const token = typeof read.value.token === 'string' ? read.value.token.trim() : '';
    if (!token || token.length > 200) return json({ ok: false, error: 'missing-card' }, 400);
    const armed = await armSubscriptionCard(sellerId, token, {
      ...(typeof read.value.storeId === 'string' ? { including: read.value.storeId } : {}),
    });
    if (armed.status === 'armed') return json({ ok: true, priceAgorot: armed.priceAgorot });
    if (armed.status === 'already') return json({ ok: true, already: true });
    return json({ ok: false, error: armed.status }, armed.status === 'not-configured' ? 503 : 400);
  }

  if (read.value.action === 'cancel') {
    // Does NOT take the shop down, and not because nobody got round to it: cancellation takes
    // effect at the END of the period already paid for (owner, 2026-08-24), so what this records is
    // a date. `lib/subscription-lapse.ts` acts on it, on a timer, through the lifecycle module —
    // un-publishing a live shop has a shopper mid-cart on the other side of it.
    const stopped = await endSubscription(sellerId);
    const subscription = await subscriptionFor(sellerId);
    return json({
      ok: stopped,
      subscription,
      // The one thing he has to be told back, and the reason the button is not frightening: he
      // keeps everything until this moment, and nothing will be charged again.
      ...(subscription?.endsAt ? { endsAt: subscription.endsAt } : {}),
    });
  }

  /** Which shop he is putting on the site with this payment. It cannot be derived — the shop is not
   *  published yet, and being published is exactly what is being paid for (`store-plan.ts`). Not
   *  trusted as an id either: `startSubscription` prices only stores this seller owns, because
   *  `billedStoresFor` filters by `seller_id` in SQL rather than by what arrived in a body. */
  const including = typeof read.value.storeId === 'string' ? read.value.storeId : undefined;

  const started = await startSubscription(sellerId, {
    ...(including ? { including } : {}),
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
  // Nothing to charge for: he has no shop ready to go on the site, so there is no fee to sum
  // (`store-plan.ts`). A 400 and not a 500 — the request was well formed and the answer is a fact
  // about his account, which the page turns into a sentence rather than an error.
  if (started.status === 'no-store-to-bill') return json({ ok: false, error: 'no-store-to-bill' }, 400);

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
