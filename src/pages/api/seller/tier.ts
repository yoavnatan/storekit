export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { parseTierId, setSellerTier } from '../../../lib/seller-tier.js';
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
 * ── This route moves no money ──
 * It records which fee a LATER charge will read (`seller-subscription.ts` → `monthlyFeeForTier`).
 * That is why there is no idempotency key and no journal entry: choosing the same plan twice is one
 * state, and nothing has been charged at the moment this is called. The rule about changing a plan
 * once the subscription is already running — PayMe hold the amount at their end — is on
 * `lib/seller-tier.ts`, next to the write.
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

  const saved = await setSellerTier(sellerId, tier);
  if (!saved) return json({ error: 'Seller not found' }, 404);
  return json({ ok: true, tier: saved });
}
