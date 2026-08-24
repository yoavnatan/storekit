export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { ownedStore } from '../../../lib/store-ownership.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { parseTierId } from '../../../lib/seller-tier.js';
import { setStoreTier, storeTier } from '../../../lib/store-plan.js';
import { syncSubscriptionPrice } from '../../../lib/seller-subscription.js';

/**
 * A STORE's plan — read it, choose it.
 *
 * ── It moved from the account to the store on 2026-08-24 ──
 * The owner's ruling: *"כל חנות צריכה לעלות כסף בנפרד"*. Until then this endpoint wrote
 * `sellers.tier`, one plan for a whole account, and a seller with five shops paid for one. The
 * price and the commission now belong to the shop (`lib/store-plan.ts`), so this route takes a
 * store id — and the shape of the answer changed with it: a signed-in seller gets the plan of
 * EVERY shop he owns, because the pricing page has to be able to say which one it is about.
 *
 * ── Why the pricing PAGE talks to an endpoint instead of rendering the answer ──
 * `/pricing` is the page a seller reads before he has an account, so it renders identically for
 * everyone and can be cached and crawled as one document. "Which plan am I on" is therefore asked
 * afterwards. A visitor who is not signed in gets `signedIn: false` and no error — being logged out
 * is the normal state of that page, not a failure of it.
 *
 * ── Scope: an id is not a permission ──
 * The session proves an ACCOUNT. The store id in the body proves nothing at all, so it goes through
 * `ownedStore` before a single byte is written — otherwise anyone with a session could move another
 * seller's shop onto the cheapest plan, or the dearest.
 *
 * ── For a seller who is already paying, the standing order moves FIRST ──
 * `syncSubscriptionPrice` patches PayMe and only then is the tier written. A gateway refusal
 * therefore leaves the shop on the plan he is actually being charged for, which is the one state
 * that is never a lie. Written the other way round — the row first — every report would follow the
 * new plan while the card kept paying the old amount, with neither side reporting the gap. That was
 * a real bug, found on 2026-08-24, and the order here is what closes it.
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
  const stores = await getStoresBySellerId(sellerId);
  // The EFFECTIVE plan per shop, not the raw column: a shop that has never chosen is on the default
  // everywhere the platform reasons about money (`pricing.ts#DEFAULT_TIER`), so the page shows the
  // same thing rather than an empty state suggesting no plan is in force. `chosen` is what lets the
  // page tell "he picked Starter" from "nobody has picked yet".
  return json({
    signedIn: true,
    stores: stores.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      tier: storeTier(s),
      chosen: !!s.tier,
      live: !!s.publishedAt,
    })),
  });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const read = await readJsonBody<{ tier?: unknown; storeId?: unknown }>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);

  // Narrowed, never defaulted. An unrecognised tier is a tampered or stale form, and recording the
  // default for it would charge a plan nobody clicked (`seller-tier.ts#parseTierId`).
  const tier = parseTierId(read.value?.tier);
  if (!tier) return json({ error: 'Unknown tier' }, 400);

  const storeId = typeof read.value?.storeId === 'string' ? read.value.storeId : '';
  if (!storeId) return json({ error: 'Missing store' }, 400);
  const store = await ownedStore(sellerId, storeId);
  if (!store) return json({ error: 'Not found' }, 404);

  // Nothing to do, and saying so is not the same as doing it: re-patching a standing order that
  // already carries this amount is a request that cannot change anything and can still fail.
  if (storeTier(store) === tier && store.tier) return json({ ok: true, tier, fromNextCharge: false });

  /**
   * ── The write is provisional until PayMe agree ──
   * The tier has to be in the row for `billedStoresFor` to price the new arrangement, and the sum
   * has to be accepted before the row is allowed to stand. So it is written, priced, and rolled
   * back on a refusal — the shop ends up on the plan the card is actually paying for either way.
   */
  const before = store.tier;
  const saved = await setStoreTier(storeId, tier);
  if (!saved) return json({ error: 'Store not found' }, 404);

  const moved = await syncSubscriptionPrice(sellerId);
  if (moved.status === 'failed') {
    // Back to where it was, including back to "never chosen" if that is what it was: leaving the
    // default written would silently record a choice the seller did not make and did not pay for.
    if (before) await setStoreTier(storeId, storeTier({ tier: before }));
    return json({ error: 'Subscription not updated', gateway: true }, 502);
  }

  return json({
    ok: true,
    tier: saved,
    // What the page has to SAY, not a detail: a seller who is already billed has just changed what
    // he pays, and the one thing he needs to know is when.
    fromNextCharge: moved.status === 'updated',
    ...(moved.status === 'updated' ? { priceAgorot: moved.priceAgorot, storeFees: moved.storeFees } : {}),
    ...(moved.status === 'updated' && moved.nextCharge ? { nextCharge: moved.nextCharge } : {}),
  });
}
