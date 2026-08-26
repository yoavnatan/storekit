export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { merchantAccountFor } from '../../../lib/seller-merchant.js';
import {
  activePaymeCredentials, getFutureWithdrawals, getPastWithdrawals,
  getSellerServices, setSellerServiceActive,
} from '../../../lib/payment-payme.js';
import { summarizeTransfers } from '../../../lib/seller-transfers.js';
import { invoiceOffer } from '../../../lib/seller-invoicing.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { logError } from '../../../lib/error-log.js';

/**
 * What PayMe are about to pay this seller, and what they already paid him.
 *
 * ── Why a route and not part of the panel's render ──
 * The payouts panel is already lazy — the server builds it on the click that opens it — but this is
 * a call to a THIRD PARTY on that path. PayMe being slow would then be the dashboard being slow,
 * and PayMe being down would be a panel that fails to render at all rather than a strip that says
 * it could not read. The panel paints its own skeleton and this fills it.
 *
 * ── The seller is taken from the SESSION and never from the request ──
 * `seller_payme_id` is the key to another business's money. It is resolved from the signed-in
 * seller's own merchant row, so there is no parameter to tamper with — the class
 * `project_checkout_idempotency_ownership` records (an id is not a permission).
 *
 * ── Read-only, always ──
 * Nothing here moves a shekel. `withdraw-balance` exists on their API and is deliberately not
 * wired: the payment schedule is PayMe's (GO_LIVE §3.1.0 §37), a manual withdrawal costs the seller
 * ₪14.9 below ₪5,000 a month, and a button that spends his money without him understanding the fee
 * is the opposite of what this screen is for.
 */
function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET({ cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const creds = activePaymeCredentials();
  // No gateway configured (dev, and the pre-launch window GO_LIVE §7 plans). `state` rather than an
  // error: nothing is wrong, there is simply no clearing account for anything to be pending in, and
  // the strip renders a sentence instead of a zero. A zero would be a claim.
  if (!creds) return json({ state: 'no-provider' });

  const account = await merchantAccountFor(sellerId);
  if (!account?.providerRef) return json({ state: 'no-account' });

  try {
    // Three independent reads, one round trip's worth of waiting — AI_INSTRUCTIONS → Scalability.
    // Sequential `await`s here would be three sequential round trips to a third party on a tab the
    // seller has just opened.
    //
    // **It was four until 2026-08-26.** `get-transactions` was read here to draw the per-charge fee
    // card, and that card moved to the `fees` report (owner, סשן א׳ §1), which fetches its own over
    // a window the seller chose. Left in place it would have been a call to a third party on every
    // open of this tab, serving markup that no longer exists.
    const [future, past, services] = await Promise.all([
      getFutureWithdrawals(account.providerRef, creds),
      getPastWithdrawals(account.providerRef, creds),
      getSellerServices(account.providerRef, creds),
    ]);
    return json({
      state: 'ok',
      ...summarizeTransfers(future, past),
      // `null` when PayMe have not provisioned an invoicing service on this merchant, which is
      // every merchant today. The card then does not render at all rather than offering a switch
      // that cannot be thrown (`seller-invoicing.ts`).
      invoicing: invoiceOffer(services),
    });
  } catch (err) {
    // Logged, because a seller who cannot see his money will ask and somebody has to be able to
    // answer. Reported to the strip as `unavailable` and never as a zero: "₪0 waiting for you" and
    // "we could not reach PayMe" are different sentences and only one of them is true.
    await logError({
      source: 'server',
      route: '/api/seller/transfers',
      message: `could not read PayMe account data for seller ${sellerId}: ${err instanceof Error ? err.message : String(err)}`,
      resolutionHint: 'המוכר רואה "לא הצלחנו לקרוא כרגע" במקום היתרה שלו. לבדוק שהמפתחות של PayMe תקפים ושהחשבון שלו קיים אצלם.',
    }).catch(() => { /* the answer to the seller is already decided */ });
    return json({ state: 'unavailable' }, 200);
  }
}

/**
 * Switch the seller's own invoicing service on or off.
 *
 * ── This commits him to a recurring charge, so three things are load-bearing ──
 * **The merchant comes from the SESSION**, never the body — the body carries one boolean and
 * nothing else, so there is no id to tamper with (`project_checkout_idempotency_ownership`).
 * **The service id comes from PayMe**, re-read on this request rather than accepted from the
 * client: a `vas_payme_id` in a request body would let a signed-in seller enable an arbitrary
 * paid service on his own account by guessing an id, and worse, would let a stale page enable a
 * DIFFERENT service than the one whose price it displayed.
 * **The price is never sent by the client either.** It is PayMe's, read live (`seller-invoicing.ts`
 * explains why it is not a number in this repo), and the seller sees it before he agrees.
 *
 * **No journal entry and no idempotency key, and both for the same reason `/api/seller/tier` gives:
 * this moves no money.** It changes which services PayMe bill the SELLER for, on his own account,
 * and `lib/money-events.ts`'s vocabulary is about money entering and leaving THIS platform — adding
 * a tenth type for a third party's standing order would put a row in the admin's money log that
 * reconciles against nothing. The operation is also a SET rather than an increment, so a repeated
 * request lands the account in the state it is already in and there is nothing for a key to guard.
 */
export async function POST({ cookies, request }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const creds = activePaymeCredentials();
  if (!creds) return json({ error: 'clearing provider not configured' }, 409);

  const body = await readJsonBody(request, BODY_LIMIT.control);
  if (!body.ok) return json({ error: 'bad request' }, body.status);
  const wanted = (body.value as { active?: unknown } | null)?.active;
  if (typeof wanted !== 'boolean') return json({ error: 'active must be a boolean' }, 400);

  const account = await merchantAccountFor(sellerId);
  if (!account?.providerRef) return json({ error: 'no clearing account' }, 409);

  try {
    const offer = invoiceOffer(await getSellerServices(account.providerRef, creds));
    // Not provisioned — so there is nothing to switch, and saying so is better than a 500. The card
    // that would have sent this request does not render in that state, so reaching here means
    // either a stale page or a hand-made request.
    if (!offer) return json({ error: 'service not available on this account' }, 409);
    // Already in the wanted state: answer with it rather than calling PayMe again. A no-op that
    // still charges a round trip is the kind of thing a double-click produces.
    if (offer.active === wanted) return json({ ok: true, invoicing: offer });

    await setSellerServiceActive({ sellerPaymeId: account.providerRef, serviceId: offer.serviceId, active: wanted }, creds);

    // Read back rather than assume: the answer the card renders is the account's real state, so a
    // partial success at PayMe cannot leave the screen claiming something else.
    return json({ ok: true, invoicing: invoiceOffer(await getSellerServices(account.providerRef, creds)) });
  } catch (err) {
    await logError({
      source: 'server',
      route: '/api/seller/transfers',
      message: `could not toggle PayMe invoicing for seller ${sellerId}: ${err instanceof Error ? err.message : String(err)}`,
      actorRole: 'seller',
      actorId: sellerId,
      resolutionHint: 'מוכר ניסה להדליק או לכבות את שירות החשבוניות של חברת הסליקה ונכשל. לבדוק מול PayMe שהשירות מוקצה לחשבון שלו.',
    }).catch(() => { /* nothing left to try */ });
    return json({ error: 'could not change the service' }, 502);
  }
}
