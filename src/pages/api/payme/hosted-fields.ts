export const prerender = false;
import type { APIContext } from 'astro';
import { activePaymeCredentials, isSandbox } from '../../../lib/payment-payme.js';
import { getStoreBySlugOrPrevious } from '../../../lib/stores.js';
import { merchantAccountFor } from '../../../lib/seller-merchant.js';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { isDemoMode } from '../../../lib/demo-mode.js';

/**
 * What the browser needs to draw PayMe's card fields — and nothing else.
 *
 * The buyer types a card into IFRAMES served by PayMe, mounted inside our checkout page. To create
 * them, their SDK needs a merchant's PUBLIC key: `create-seller` returns one per seller
 * (`seller_public_key`) and it is meant to reach a browser, exactly like a Stripe publishable key.
 * It is not a secret and it authorises nothing — the private `payme_client_key` never leaves the
 * server, and `merchantCallbackSecret` is a separate value this route cannot see.
 *
 * **Why it takes a store slug.** A token is created UNDER one merchant, and — measured
 * (`GO_LIVE` §3.1.1 item 2) — charges successfully under any other. That crossing is what makes one
 * card entry pay several shops. So any store in the cart will do, and the caller passes the first
 * one; this route does not need to know the cart and deliberately is not told it.
 *
 * **GET, not POST, and that is a design choice rather than an accident.** It writes nothing and
 * reads nothing that belongs to the caller, so making it a POST would put a route that changes no
 * state into `api-route-guards.test.ts`'s mutating set and force a "public by design" exemption to
 * be argued for something that is simply a lookup. `no-store` because the answer depends on a
 * seller's approval state, which changes without warning when PayMe finish reviewing him.
 */
function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function GET({ url, cookies }: APIContext): Promise<Response> {
  /**
   * ── The portfolio demonstration, answered before anything else ──
   *
   * `active: false` because there is nothing to mount: PayMe's SDK is fetched from THEIR CDN and
   * initialised with a real publishable key, and the demo's merchants carry a key that is a
   * plausible-looking string and nothing more. Left to reach this route's normal path, a demo
   * seller's account has a `public_key` and is approved, so it would answer `active: true` — the
   * SDK would load, fail to initialise against a key PayMe never issued, and the buyer would be
   * told the card form is broken. Which it is not; it is absent, and those are different sentences.
   *
   * `demo: true` alongside it, because "no gateway" and "a gateway on purpose" want different
   * screens. The first is a pre-launch state nobody should see, and the checkout says so quietly.
   * The second is the demonstration working as intended, and the checkout says THAT instead — a
   * labelled panel where the iframes would be, and a pay button that still completes the order.
   */
  if (isDemoMode()) return json({ active: false, demo: true });

  const creds = activePaymeCredentials();
  // `{ active: false }` rather than a 404 or a 503. The caller's correct behaviour is identical for
  // "no gateway configured" and "this seller cannot take cards": show no card fields and let the
  // mock path run. An error status would push the page into a failure branch for a state that is
  // not a failure — dev, and the pre-gateway window GO_LIVE §7 plans.
  if (!creds) return json({ active: false });

  /**
   * ── `?own=1`: OUR merchant, for the SELLER's own card ──
   *
   * The other caller of this route is a buyer paying a shop, and the key is that shop's. This one is
   * a seller putting a card on file for his monthly fee, and the merchant being charged is ours
   * (`lib/subscription-arm.ts`) — a different account, and therefore a different public key.
   *
   * It is gated on a seller session, and that is tidiness rather than protection: `ownPublicKey` is
   * a publishable key like Stripe's, it authorises nothing, and every buyer already receives a
   * seller's. Gating it simply keeps a key that only sellers can use out of every other response.
   *
   * Absent is a real state — a deployment whose own merchant was opened without keeping what it
   * handed back (`payment-payme.ts`) — and the answer is the same `active: false` the buyer path
   * uses, which sends the seller to PayMe's own payment page instead.
   */
  if (url.searchParams.get('own') === '1') {
    if (!getSellerSession(cookies)) return json({ active: false });
    if (!creds.ownPublicKey) return json({ active: false });
    return json({ active: true, publicKey: creds.ownPublicKey, testMode: isSandbox(creds) });
  }

  const slug = (url.searchParams.get('store') ?? '').trim();
  if (!slug) return json({ active: false });

  // Through `getStoreBySlugOrPrevious` like every other read of a slug from a client: a cart line
  // can predate the seller renaming the store, and this must not be the one place that 404s on it.
  const store = await getStoreBySlugOrPrevious(slug);
  if (!store) return json({ active: false });

  const account = await merchantAccountFor(store.sellerId);
  // The card form must appear exactly when the checkout will accept the cart, so this asks
  // `merchantBlockFor`'s question rather than re-deriving it — including its sandbox rule, where
  // PayMe do not model approval and gating on it would make the whole flow untestable before
  // launch. Drawing fields the checkout would refuse means collecting a card for a purchase that
  // cannot complete; hiding them where it would accept means a buyer who cannot pay at all.
  if (!account?.publicKey) return json({ active: false });
  if (!account.approved && !isSandbox(creds)) return json({ active: false });

  return json({
    active: true,
    publicKey: account.publicKey,
    // Their SDK's own flag. Derived from the base URL we deliberately configured — the same source
    // `isSandbox` uses everywhere — so the browser can never be pointed at production while the
    // server talks to staging.
    testMode: isSandbox(creds),
  });
}
