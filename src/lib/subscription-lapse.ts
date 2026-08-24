/**
 * What happens when a seller stops paying — the other end of `store-publication.ts`.
 *
 * ── The hole this closes ──
 * Publication was derived from two holds and, once lifted, was never re-examined: a seller could
 * cancel his subscription and his shops stayed on the site for ever, selling, with our commission
 * still coming off sales nobody was subscribed for. The cancel button existed and changed nothing
 * a shopper could see (owner, 2026-08-24).
 *
 * ── When, exactly ──
 * At the end of the period he already paid for, never at the press of the button
 * (`seller-subscription.ts#endSubscription` records that date as `ends_at`). Two dates, because
 * they are two events: what he asked to stop is the CHARGING, and what he bought runs until the
 * month is up.
 *
 * ── Back to `unpublished`, not to a new state ──
 * `unpublished` already means exactly this: built, the seller previews it, the public does not see
 * it, and it comes back BY ITSELF the moment the hold lifts. A lapsed subscription IS that hold —
 * `store-publication.ts` names it as one of the two — so the store returns to the state it was in
 * before it was ever paid for, and one payment re-publishes it through the sweep that already
 * exists. Inventing a `suspended` state would have been a seventh row in the lifecycle table
 * saying what the second row already says.
 *
 * **So `published_at` IS cleared here**, which its own column comment used to forbid. That comment
 * was written when the only ways off the site were pause, close and block — a hold coming back was
 * not one of the cases it had. What it was protecting against is a store going dark with no reason
 * recorded, and the reason here is a row in `seller_subscriptions` with a date on it.
 *
 * ── Orders are untouched ──
 * A shop coming off the site owes exactly what it owed a minute earlier. Orders, refunds, returns
 * and messages all keep working from the dashboard, which never goes away — the same rule
 * `store-lifecycle.ts` applies to a closure.
 */
import { rows } from './db.js';
import { getStoresBySellerId, updateStore } from './stores.js';
import { storeLifecycle } from './store-status.js';
import { createNotification } from './notifications.js';
import { archiveCampaignsForStore } from './ad-campaigns.js';

/** Sellers whose paid period has run out and who still have something on the site. Asked in SQL
 *  rather than by reading every subscription: on a platform of any size the answer is almost always
 *  the empty set, and this keeps the steady state at one statement. */
export async function sellersWithLapsedSubscription(limit = 200): Promise<string[]> {
  const found = await rows<{ seller_id: string }>(
    `SELECT s.seller_id FROM seller_subscriptions s
      WHERE s.ends_at IS NOT NULL AND s.ends_at <= now()
        AND EXISTS (SELECT 1 FROM stores st
                     WHERE st.seller_id = s.seller_id AND st.published_at IS NOT NULL
                       AND st.deleted_at IS NULL AND st.closed_at IS NULL)
      LIMIT $1`,
    [limit],
  );
  return found.map((r) => r.seller_id);
}

/**
 * Take one seller's shops off the site. Returns the slugs that went dark.
 *
 * Idempotent: a store already unpublished is not in the list, so a second pass does nothing. That
 * matters because this runs from a timer that can overlap itself.
 */
export async function lapseSellerStores(sellerId: string): Promise<string[]> {
  const stores = await getStoresBySellerId(sellerId);
  const live = stores.filter((s) => storeLifecycle(s) === 'active' || storeLifecycle(s) === 'paused');
  if (!live.length) return [];

  for (const store of live) {
    await updateStore(store.id, { publishedAt: undefined });
    // The same reason a closure archives them: a store nobody can reach has no reachable products,
    // so every campaign against it is spending on a 404. `ad-campaign-health.ts` would starve them
    // eventually; doing it here means the spend stops in the same minute the shop does.
    await archiveCampaignsForStore(store.id).catch(() => { /* the shop is down; ads are the smaller half */ });
    await createNotification({
      userId: sellerId,
      role: 'seller',
      type: 'store_unpublished',
      title: 'החנות ירדה מהאתר',
      body: `${store.name} כבר לא מופיעה במתחם, בחיפוש ובגוגל, כי המנוי הסתיים. כל המוצרים, ההגדרות וההזמנות שמורים — חידוש המנוי מחזיר אותה לאוויר.`,
      storeSlug: store.slug,
      storeName: store.name,
    }).catch(() => { /* a missing badge must not leave the shop half-down on the next run */ });
  }
  return live.map((s) => s.slug);
}

/**
 * The sweep. Never throws: one seller whose stores fail to come down must not stop the rest, and
 * the count of failures is on the row so a systematic problem is a number rather than silence.
 */
export async function runSubscriptionLapseSweep(): Promise<string> {
  const sellers = await sellersWithLapsedSubscription();
  if (!sellers.length) return 'no subscription has lapsed';

  let unpublished = 0;
  let failed = 0;
  for (const sellerId of sellers) {
    try {
      unpublished += (await lapseSellerStores(sellerId)).length;
    } catch {
      failed += 1;
    }
  }
  return `${sellers.length} lapsed seller(s) · ${unpublished} store(s) taken off the site${failed ? ` · ${failed} failed` : ''}`;
}
