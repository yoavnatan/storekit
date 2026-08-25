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
import { merchantBlockFor, merchantKycFor } from './seller-merchant.js';
import { missingMerchantKyc } from './merchant-kyc.js';
import { createNotification } from './notifications.js';
import { sendStoreLiveEmail } from './email/store-live-email.js';
import { getSellerById } from './seller-auth.js';
import { sellerIsSubscribed, subscriptionFor } from './seller-subscription.js';
import { activePaymeCredentials, type PaymeCredentials } from './payment-payme.js';

/**
 * Why a shop is not public yet.
 *
 * **The order of this union is the order of the flow**, and it is a decision rather than a listing:
 * clearing first, paying last. A UI showing "the next thing to do" walks it top to bottom, and
 * `GoLiveSteps.astro` is that UI.
 */
export type PublishHold =
  /** We do not hold everything PayMe require, so no clearing account could be opened. His to fix —
   *  `merchant-kyc.ts#missingMerchantKyc` says exactly which fields. */
  | 'clearing-details'
  /** The account exists and PayMe have not approved the business yet. **Nobody can do anything**,
   *  which is the whole reason this is a separate value from the one above: the same screen must
   *  not tell a waiting seller to go and fill something in. */
  | 'clearing-approval'
  /**
   * He has not started paying — which since 2026-08-24 means **he has not put a card on file**,
   * not that he has not been charged.
   *
   * ── The order of this union moved twice in one day, and both moves were right ──
   * It was first: details → PAY → wait. The owner named the problem — *"אני לא רוצה ליפול בין
   * הכיסאות ושהמוכר יתחרט"* — a seller charged, then left waiting up to seven business days with a
   * shop that was not on the site. So it went LAST.
   *
   * And that opened the other side of the same week: *"אם מוכר ממתין לאישור מפיימי והוא עוד לא בחר
   * מסלול או שילם... יכול להיות שעד שהוא כבר יקבל את האישור בדרך הוא מצא כבר חלופה אחרת"*. The
   * longest wait in the flow had become the one stretch where he has decided nothing and owes
   * nothing.
   *
   * It is back in the middle, and the thing that makes both true at once is that **the decision and
   * the charge are no longer the same act**: he chooses a plan and puts a card on file here, and the
   * card is charged when the shop actually goes up (`lib/subscription-arm.ts`). He is committed
   * through the wait and pays for none of it.
   */
  | 'subscription';

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
  const [subscribed, merchantBlock, kyc] = await Promise.all([
    sellerIsSubscribed(sellerId, creds),
    merchantBlockFor(sellerId, creds),
    // Asked separately from the account, because since 2026-08-25 the absence of an account no
    // longer implies the absence of details — see below.
    merchantKycFor(sellerId),
  ]);
  // The order IS the flow the seller is walked through — see `PublishHold`. Details, then the plan
  // and the card, then the wait he cannot shorten: everything he can act on comes before the thing
  // nobody can, and none of it charges him until the shop is actually up.
  const holds: PublishHold[] = [];
  /**
   * **`no-account` is not the same as "details missing" any more.** The account is opened when the
   * seller commits a card, not when he saves the form (`subscription-arm.ts`), so a seller who has
   * given PayMe everything they ask for still has no account — and this hold used to fire for him,
   * putting "חסרים פרטים לפתיחת חשבון סליקה" on the overview of somebody with nothing missing
   * (owner, 2026-08-25). What he is actually waiting on in that state is his own card, which is the
   * `subscription` hold on the next line and was already there. Two holds for one gap is how the
   * two screens started contradicting each other.
   */
  if (merchantBlock === 'no-account' && missingMerchantKyc(kyc).length) holds.push('clearing-details');
  if (!subscribed) holds.push('subscription');
  if (merchantBlock === 'not-approved') holds.push('clearing-approval');
  return holds;
}

/**
 * Re-derive publication for every store this seller owns, and publish the ones now free to go.
 *
 * Returns the slugs that went live in this run, so a caller can say something true about what just
 * happened rather than "saved".
 *
 * **Only ever publishes.** A store that is already live stays live even if a hold comes back. Taking
 * one down is `lib/subscription-lapse.ts` — it happens at the end of the period already paid for
 * rather than the moment a hold returns, it notifies the seller, and it runs on a timer. None of
 * that belongs on a path that runs inside a payment callback, which is why the two directions are
 * two modules.
 *
 * Idempotent, and it has to be: it runs from a callback PayMe may deliver twice, from a sweep, and
 * from the seller's own click, all of which can land at once.
 */
export async function syncStorePublication(
  sellerId: string,
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<string[]> {
  const stores = await getStoresBySellerId(sellerId);
  const allPending = stores.filter((s) => storeLifecycle(s) === 'unpublished');
  if (!allPending.length) return [];

  const holds = await publishHoldsFor(sellerId, creds);
  if (holds.length) return [];

  /**
   * ── Only the shops the standing order actually pays for ──
   *
   * Since 2026-08-24 each store is billed separately (`store-plan.ts`), so "this seller is paying"
   * stopped being the whole answer. A seller paying ₪99 for one shop must not have a second one go
   * live for nothing simply because the account-level hold is clear — which is exactly what this
   * function did before the fee became per-store, and it would have been a silent hole rather than
   * a visible bug.
   *
   * `store_fees` is the list the standing order was last set from, so it is the same source the
   * charge came from — not a second derivation that could disagree with it. With PayMe unconfigured
   * there is no subscription at all and no fee to check, and the whole gate already answers "nothing
   * is blocked" for that window; keeping the filter off there is what stops development going dark.
   */
  const sub = creds ? await subscriptionFor(sellerId) : null;
  const paidFor = new Set((sub?.storeFees ?? []).map((f) => f.storeId));
  const pending = creds && sub ? allPending.filter((s) => paidFor.has(s.id)) : allPending;
  if (!pending.length) return [];

  const now = new Date().toISOString();
  // Sequential rather than a `Promise.all`: this runs on a callback or a sweep, never on a page a
  // person is waiting on, and a seller has at most `MAX_STORES_PER_SELLER` of them.
  for (const store of pending) {
    await updateStore(store.id, { publishedAt: now });
    /**
     * **And TELL him**, which is the half that was missing (owner, 2026-08-24: *"מתי המוכר בכלל
     * מבין שהוא עלה לאוויר?"*).
     *
     * Publication is derived and nobody presses a button — which is right, because the alternative
     * is a seller who paid, closed the tab, and never came back to press it. But it means the
     * moment of arrival can be DAYS after the last thing he did: PayMe take up to seven business
     * days, and this usually fires from a sweep with nobody looking at a screen. Without a
     * notification he finds out by wondering, checking, and finding his shop up — or by not
     * wondering, which is the abandonment the whole flow is trying to avoid.
     *
     * Caught: a shop is live either way, and a failed notification must not leave `published_at`
     * unwritten on the next run's re-read.
     */
    await createNotification({
      userId: sellerId,
      role: 'seller',
      type: 'store_live',
      title: 'החנות שלך באוויר',
      body: `${store.name} מופיעה עכשיו במתחם, בחיפוש ובגוגל, ואפשר לקנות בה.`,
      storeSlug: store.slug,
      storeName: store.name,
    }).catch(() => { /* the shop is live; a missing badge is not worth undoing that */ });

    /**
     * **And by MAIL**, which the notification alone could not do (owner, 2026-08-25).
     *
     * The last hold to lift is usually PayMe's approval, and that lands on a day nobody chose — up
     * to seven business days after the seller last touched anything. A badge on a dashboard he has
     * not opened is a message to nobody, and this is the one moment the whole build-free-pay-to-
     * publish flow exists to reach. `sendStoreLiveEmail` never throws and logs its own failure, so
     * a mail problem cannot undo a publication that already happened.
     */
    const seller = await getSellerById(sellerId);
    if (seller?.email) {
      await sendStoreLiveEmail({ to: seller.email, storeName: store.name, storeSlug: store.slug });
    }
  }
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
