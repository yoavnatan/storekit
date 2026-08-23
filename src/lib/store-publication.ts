/**
 * What holds a store off the site, and the one thing that lifts it.
 *
 * ── The decision this implements (owner, 2026-08-23) ──
 * A seller registers, builds a whole shop — products, variants, images, design, categories,
 * settings, sales, a campaign right up to the moment of activation — and LOOKS at it, without ever
 * entering a card. He pays when he wants it to go live. The reasoning is the platform's whole
 * acquisition bet: *"מי שלא ראה מה הוא מקבל לא ישלם, ותשלום מראש עוצר בדיוק את המוכר שאני רוצה"*.
 *
 * So the rule is: **everything is visible and everything is buildable; only the moment something
 * goes OUT is blocked** — publishing the shop, activating a campaign, selling, shipping.
 *
 * ── Why one state and not two flags ──
 * Two independent things keep a shop unpublished, and they are not the seller's fault in the same
 * way:
 *   · **clearing** — PayMe examine every business before it may take a card, up to seven business
 *     days (agreement §11). Nothing he does shortens it, and he must be told that rather than left
 *     to wonder what he did wrong.
 *   · **subscription** — he has not started paying, so he is not on the platform yet. That one is
 *     his to fix in a minute.
 *
 * The CONSEQUENCE is identical — he sees his shop, the public does not — so it is one state
 * (`store-status.ts`, `unpublished`) with two sentences. Modelling it as two booleans would let
 * them contradict each other, which is exactly what the owner's instruction warned about:
 * *"מנגנון אחד, שתי סיבות — שניים ייסתרו זה את זה"*.
 *
 * ── What was broken before this ──
 * A new store went public immediately and its seller had no clearing account, so the shop was
 * indexable, listed and linkable — and the buyer found out it could not sell only after filling in
 * an address and pressing pay (`merchantBlockFor` refuses in `/api/checkout`). The refusal was
 * correct and in the worst possible place.
 *
 * ── Nobody presses "publish" ──
 * `syncStorePublication` is called from every place a hold can lift, and publication is the
 * DERIVED result of both holds being clear. A button would mean a seller who paid, closed the tab,
 * and never came back to press it — a manual step in a zero-touch platform.
 */
import { rows } from './db.js';
import { getStoresBySellerId, updateStore } from './stores.js';
import { storeLifecycle, type StoreLifecycleFlags } from './store-status.js';
import { merchantBlockFor } from './seller-merchant.js';
import { sellerIsSubscribed } from './seller-subscription.js';
import { activePaymeCredentials, type PaymeCredentials } from './payment-payme.js';

/**
 * Why a shop is not public yet. Ordered by who can act on it — the seller's own step first, so a
 * UI showing "the next thing to do" shows the one he can actually do.
 */
export type PublishHold =
  /** He has not started paying. His to fix, in a minute. */
  | 'subscription'
  /** We do not hold everything PayMe require, so no clearing account could be opened. His to fix —
   *  `merchant-kyc.ts#missingMerchantKyc` says exactly which fields. */
  | 'clearing-details'
  /** The account exists and PayMe have not approved the business yet. **Nobody can do anything**,
   *  which is the whole reason this is a separate value from the one above: the same screen must
   *  not tell a waiting seller to go and fill something in. */
  | 'clearing-approval';

/**
 * Everything standing between this seller and a public shop.
 *
 * Both halves are asked in one `Promise.all`: they are independent reads and a sequential pair is
 * two round trips on a page a seller loads constantly (`project_sequential_await_latency`).
 *
 * **Empty when PayMe are not configured**, because both underlying checks answer "nothing is
 * blocked" there and for the same reason — with no gateway wired nobody could clear or subscribe,
 * so a hold would take the entire platform dark in development. `site-mode.ts` is what guards a
 * production server whose provider cannot take money.
 */
export async function publishHoldsFor(
  sellerId: string,
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<PublishHold[]> {
  const [subscribed, merchantBlock] = await Promise.all([
    sellerIsSubscribed(sellerId, creds),
    merchantBlockFor(sellerId, creds),
  ]);
  const holds: PublishHold[] = [];
  if (!subscribed) holds.push('subscription');
  if (merchantBlock === 'no-account') holds.push('clearing-details');
  if (merchantBlock === 'not-approved') holds.push('clearing-approval');
  return holds;
}

/**
 * Re-derive publication for every store this seller owns, and publish the ones now free to go.
 *
 * Returns the slugs that went live in this run, so a caller can say something true about what just
 * happened rather than "saved".
 *
 * **Only ever publishes.** A store that is already live stays live even if a hold comes back — a
 * lapsed subscription takes a shop off the site through `store-lifecycle.ts`, with the seller
 * notified and open orders honoured, and none of that belongs on a path that runs inside a payment
 * callback. `published_at` is a fact about the past and is never cleared (see its column comment).
 *
 * Idempotent, and it has to be: it runs from a callback PayMe may deliver twice, from a sweep, and
 * from the seller's own click, all of which can land at once.
 */
export async function syncStorePublication(
  sellerId: string,
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<string[]> {
  const stores = await getStoresBySellerId(sellerId);
  const pending = stores.filter((s) => storeLifecycle(s) === 'unpublished');
  if (!pending.length) return [];

  const holds = await publishHoldsFor(sellerId, creds);
  if (holds.length) return [];

  const now = new Date().toISOString();
  // Sequential rather than a `Promise.all`: this runs on a callback or a sweep, never on a page a
  // person is waiting on, and a seller has at most `MAX_STORES_PER_SELLER` of them.
  for (const store of pending) await updateStore(store.id, { publishedAt: now });
  return pending.map((s) => s.slug);
}

/**
 * May this viewer see a shop that is not public yet?
 *
 * Its OWNER, and nobody else. Kept here rather than in `store-status.ts` because that module is
 * pure and knows nothing about sessions, and because this is the one exception to `reachable` in
 * the lifecycle table — an exception with a name is one the next reader can find.
 *
 * `sellerId` is the id from the SESSION cookie, never a query parameter: this is the only thing
 * standing between an unpublished shop and anyone who can guess its URL.
 */
export function mayPreviewStore(store: StoreLifecycleFlags & { sellerId: string }, viewerSellerId: string | null): boolean {
  if (!viewerSellerId) return false;
  if (storeLifecycle(store) !== 'unpublished') return false;
  return store.sellerId === viewerSellerId;
}

/**
 * Every seller with at least one shop waiting to go live.
 *
 * The sweep's input, and the reason there is a sweep at all: **the approval callback needs a public
 * URL, and this platform does not have one yet** (`docs/payme-sandbox-notes.md` — no callback has
 * ever been received end to end). Until it does, asking PayMe on a timer is the ONLY thing that
 * ends a seller's wait, and after it exists this is still what covers a notification they dropped.
 *
 * Soft-deleted and closed shops are excluded in SQL: a closed store is not waiting for anything,
 * and including it would make every sweep re-ask PayMe about sellers who left.
 */
export async function sellersAwaitingPublication(limit = 200): Promise<string[]> {
  const found = await rows<{ seller_id: string }>(
    `SELECT DISTINCT seller_id FROM stores
      WHERE published_at IS NULL AND closed_at IS NULL AND deleted_at IS NULL AND NOT blocked
      LIMIT $1`,
    [limit],
  );
  return found.map((r) => r.seller_id);
}
