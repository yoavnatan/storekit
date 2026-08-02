export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { pauseStore, resumeStore, requestStoreClosure, openOrderCount } from '../../../lib/store-lifecycle.js';
import { pingStoreChange } from '../../../lib/indexnow.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { sendStoreLifecycleEmail } from '../../../lib/email/store-lifecycle-email.js';

/** The seller's own pause / reopen / close switch. Its own route rather than another `_action`
 *  branch in /api/store: that endpoint is the settings FORM (multi-field, merged field-by-field
 *  against a revision), and these are three single-verb state transitions with a completely
 *  different failure mode. Admin blocking stays where it is (/api/admin/moderation) — a different
 *  actor, a different meaning, and deliberately not reachable from here. */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ACTIONS = ['pause', 'resume', 'close'] as const;
type LifecycleAction = typeof ACTIONS[number];

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const read = await readJsonBody<{ action?: unknown; storeId?: unknown }>(request, BODY_LIMIT.control);
  const body = read.ok ? read.value : null;
  const action = ACTIONS.find((a) => a === body?.action) as LifecycleAction | undefined;
  if (!action) return json({ ok: false, error: 'Unknown action' }, 400);

  // Ownership from the session's own store list, never from the request — the id is
  // attacker-controlled, and this is a state change on a whole storefront.
  const store = (await getStoresBySellerId(sellerId)).find((s) => s.id === String(body?.storeId ?? ''));
  if (!store) return json({ ok: false, error: 'החנות לא נמצאה.' }, 404);

  const result = action === 'pause' ? await pauseStore(store.id)
    : action === 'resume' ? await resumeStore(store.id)
    : await requestStoreClosure(store.id);

  if (!result.ok) return json({ ok: false, error: result.error }, 409);

  // The store just entered or left every discovery surface at once (sitemap, feed, llms.txt) —
  // tell Bing/IndexNow so a paused store stops being served in AI answers within minutes instead
  // of at the next crawl, and a reopened one comes back just as fast. No-op without a real
  // domain + key (indexnow.ts).
  pingStoreChange(result.store);

  const openOrders = result.state === 'closing' ? result.openOrders : await openOrderCount(result.store.slug);

  // Every seller-driven state gets a letter — including reopening, which is not the harmless
  // mirror of pausing it looks like: the storefront comes back on its own, the boost campaigns
  // deliberately do not (store-lifecycle-email.ts explains why). `blocked` is excluded because
  // an admin block has its own notice and its own appeal thread.
  //
  // Not awaited: the state is already saved, and the seller must not sit on a spinner while a
  // mail provider answers. sendStoreLifecycleEmail never throws and logs its own failures.
  if (result.state !== 'blocked') {
    const seller = await getSellerById(sellerId);
    if (seller) {
      void sendStoreLifecycleEmail({
        to: seller.email,
        sellerName: seller.name,
        store: result.store,
        state: result.state,
        openOrders,
      });
    }
  }

  return json({ ok: true, state: result.state, openOrders });
};
