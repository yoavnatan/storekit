export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { merchantAccountFor } from '../../../lib/seller-merchant.js';
import { activePaymeCredentials, getFutureWithdrawals, getPastWithdrawals } from '../../../lib/payment-payme.js';
import { summarizeTransfers } from '../../../lib/seller-transfers.js';
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
    // Independent reads, one round trip's worth of waiting — AI_INSTRUCTIONS → Scalability.
    const [future, past] = await Promise.all([
      getFutureWithdrawals(account.providerRef, creds),
      getPastWithdrawals(account.providerRef, creds),
    ]);
    return json({ state: 'ok', ...summarizeTransfers(future, past) });
  } catch (err) {
    // Logged, because a seller who cannot see his money will ask and somebody has to be able to
    // answer. Reported to the strip as `unavailable` and never as a zero: "₪0 waiting for you" and
    // "we could not reach PayMe" are different sentences and only one of them is true.
    await logError({
      source: 'server',
      route: '/api/seller/transfers',
      message: `could not read PayMe withdrawals for seller ${sellerId}: ${err instanceof Error ? err.message : String(err)}`,
      resolutionHint: 'המוכר רואה "לא הצלחנו לקרוא כרגע" במקום היתרה שלו. לבדוק שהמפתחות של PayMe תקפים ושהחשבון שלו קיים אצלם.',
    }).catch(() => { /* the answer to the seller is already decided */ });
    return json({ state: 'unavailable' }, 200);
  }
}
