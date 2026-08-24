export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { parseTierId, setSellerTier } from '../../../lib/seller-tier.js';
import { propagateTierToSubscription } from '../../../lib/seller-subscription.js';
import { DEFAULT_TIER } from '../../../lib/pricing.js';

/**
 * The seller's plan — read it, choose it.
 *
 * ── Why the pricing PAGE talks to an endpoint instead of rendering the answer ──
 * `/pricing` is static, and deliberately: it is the page a seller reads before he has an account,
 * so it has to be in the sitemap and to render with no server work. That makes "which plan am I on"
 * a question the page can only ask afterwards, which is what this GET is for. A visitor who is not
 * signed in gets `signedIn: false` and no error — being logged out is the normal state of that
 * page, not a failure of it.
 *
 * ── Scope ──
 * The session proves an ACCOUNT and the tier belongs to the account, not to a store (`pricing.ts`:
 * per-seller, never per-store). So the id written is `getSellerSession`'s and no id is read from
 * the body — the "an id is not a permission" rule that `lib/store-ownership.ts` exists for does not
 * even get a chance to apply here, because there is nothing to pass.
 *
 * ── For a seller who is not paying yet, this route moves no money ──
 * It records which fee a LATER charge will read (`seller-subscription.ts` → `monthlyFeeForTier`).
 * No idempotency key and no journal entry: choosing the same plan twice is one state, and nothing
 * has been charged at the moment it is called.
 *
 * ── For a seller who IS paying, it moves the standing order, and the order matters ──
 * Until 2026-08-24 it did not, and that was a money bug: the row changed, every report and
 * commission line followed the new tier, and PayMe went on charging the old amount with neither
 * side reporting the gap. `seller-tier.ts` had documented the danger and exported
 * `sellerMayChangeTier`; nothing called it.
 * The fix is not a refusal (owner: *"למה לבטל את המנוי? זה רק להחליף את ההוראת קבע שלו"*) — the
 * subscription's price is patched at PayMe FIRST, and the tier is written only if they accepted.
 * A gateway refusal therefore leaves the seller on the plan he is actually being charged for,
 * which is the one state that is never a lie.
 */

function json(data: Record<string, unknown>, status = 200): Response {
  // No-store on both verbs: the answer is per-seller, and a cached "you are on Growth" served to
  // the next visitor of a page that is otherwise fully static is exactly the kind of leak a
  // static-plus-fetch shape invites.
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function GET({ cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ signedIn: false });
  const seller = await getSellerById(sellerId);
  if (!seller) return json({ signedIn: false });
  // The EFFECTIVE tier, not the raw column. An account that has never chosen is on Starter
  // everywhere the platform reasons about money (`pricing.ts#DEFAULT_TIER`), so the page must show
  // the same thing rather than an empty state that suggests no plan is in force.
  return json({ signedIn: true, tier: seller.tier ?? DEFAULT_TIER, chosen: !!seller.tier });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const read = await readJsonBody<{ tier?: unknown }>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);

  // Narrowed, never defaulted. An unrecognised tier is a tampered or stale form, and recording
  // Starter for it would charge a plan nobody clicked (`seller-tier.ts#parseTierId`).
  const tier = parseTierId(read.value?.tier);
  if (!tier) return json({ error: 'Unknown tier' }, 400);

  // PayMe first — see the header. A `failed` here means nothing was written and nothing diverged.
  const moved = await propagateTierToSubscription(sellerId, tier);
  if (moved.status === 'failed') {
    // 502 and not 400: the request was fine, the gateway refused. The seller is told his plan was
    // not changed, which is true of both sides at once.
    return json({ error: 'Subscription not updated', gateway: true }, 502);
  }

  const saved = await setSellerTier(sellerId, tier);
  if (!saved) return json({ error: 'Seller not found' }, 404);
  // `fromNextCharge` is what the page has to SAY, not a detail: a seller who is already billed has
  // just changed what he pays, and the one thing he needs to know is when.
  return json({
    ok: true,
    tier: saved,
    fromNextCharge: moved.status === 'updated',
    ...(moved.status === 'updated' && moved.nextCharge ? { nextCharge: moved.nextCharge } : {}),
  });
}
