import { sumMoney } from './money.js';
import { reportClientError } from '../scripts/error-reporter.js';

export interface TrackItem {
  /** **The CATALOG id — what Google and Meta look this item up by.** Always built by
   *  `lib/ad-item-id.ts`: the product's uuid, narrowed to a variant combo where one was chosen,
   *  because that is what the Merchant/Catalog feed emits as a row id. Never a slug. */
  id: string;
  /** **The product's raw uuid — what OUR first-party funnel records.** A different identifier from
   *  `id` and it has to be, because for a variant line `id` carries a combo suffix and is therefore
   *  not a uuid at all; `analytics_products` stores product ids and `/api/analytics/event` drops
   *  anything that is not uuid-shaped. Absent means "don't record the product", not "record a
   *  blank" — the funnel stage is still counted either way. */
  productId?: string;
  name: string;
  price: number;
  category?: string;
}

/** A cart line — a `TrackItem` plus how many of it. Checkout reports lines, not products. */
export interface TrackLine extends TrackItem {
  qty: number;
}

/**
 * An item with no id is not reportable, and silence beats a placeholder.
 *
 * `id` here is the catalog id (`lib/ad-item-id.ts`) and it is read off server-rendered markup, so
 * an empty one means a surface that has not been wired — a stale cached page, a card rendered
 * before the attribute existed. Sending `content_ids: ['']` would not degrade gracefully: both
 * networks would accept it, join it to nothing, and quietly count it among the events that failed
 * to match a catalog item, which is a number the owner would then be debugging instead of reading.
 * One guard here rather than at each of the four call sites, because it is the same answer at all
 * of them and a call site can forget.
 */
const reportable = (item: TrackItem): boolean => !!item.id;

/**
 * **Nothing in this module may throw into its caller.** Every third-party call below goes through
 * here, and this is a load-bearing guard rather than defensive habit.
 *
 * `window.dataLayer.push` is NOT `Array.prototype.push` once GTM has loaded — the container
 * replaces it with its own function that synchronously evaluates every matching trigger, variable
 * and custom template. A broken tag in a container edited in the GTM UI, by someone who never
 * touches this repository, therefore throws straight back out of `push`. `window.fbq` behaves the
 * same way once `fbevents.js` swaps the queueing stub for `callMethod`. And `?.` guards only a
 * MISSING `dataLayer`, not one an extension or another script has replaced with a non-array, where
 * `.push` is `undefined` and the call is a `TypeError`.
 *
 * What that cost before this existed: all four add-to-cart handlers are written as
 * `addItem(…); trackAddToCart(…); …reveal "לתשלום"…`, so a throw here left the item genuinely in
 * the cart while the button that leads to checkout was never shown and the button that was just
 * pressed never changed. The buyer sees a click that did nothing, on the one control the whole
 * catalogue exists to serve — because of an analytics tag. Reordering the four call sites would fix
 * those four; this fixes the fifth one somebody adds next, which is the same argument `reportable`
 * above makes for living here instead of at the call sites.
 *
 * Reported ONCE per page, never per event: the failure is a property of the container, so a
 * per-event report would spend the whole per-session budget in `error-reporter.ts` (5) on repeats
 * of one fact and hide the real errors behind it. Once is enough to make a broken container visible
 * in the Alerts tab, which is the alternative to it being invisible forever.
 */
let trackingFailureReported = false;

function tap(channel: 'dataLayer' | 'fbq' | 'funnel', send: () => void): void {
  try {
    send();
  } catch (err) {
    if (trackingFailureReported) return;
    trackingFailureReported = true;
    reportClientError(
      `tracking: ${channel} threw — ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
}

export function trackViewContent(item: TrackItem): void {
  if (!reportable(item)) return;
  tap('dataLayer', () => window.dataLayer?.push({
    event: 'view_item',
    ecommerce: {
      currency: 'ILS',
      items: [{ item_id: item.id, item_name: item.name, price: item.price, item_category: item.category ?? '' }],
    },
  }));
  tap('fbq', () => window.fbq?.('track', 'ViewContent', {
    content_ids: [item.id],
    content_type: 'product',
    value: item.price,
    currency: 'ILS',
    content_name: item.name,
  }));
}

export function trackAddToCart(item: TrackItem, qty: number): void {
  // The two halves are reported INDEPENDENTLY, and that is the fix for a defect this function
  // carried from the start: it sent `productId: item.id` to our own funnel, `item.id` was the slug
  // at all four call sites, and `/api/analytics/event` accepts only a uuid — so it silently dropped
  // every one. `analytics_products` therefore has no add_to_cart product rows at all, which is why
  // the admin Data tab's "top added" and "top abandoned" lists have always been empty. Nothing
  // reported an error: the event was still counted, only ever without a product.
  //
  // They stay independent because the failure modes are unrelated. A missing catalog id is a
  // wiring gap on one surface and must not cost the internal funnel its event; a missing uuid must
  // not cost Google and Meta theirs.
  if (reportable(item)) {
    tap('dataLayer', () => window.dataLayer?.push({
      event: 'add_to_cart',
      ecommerce: {
        currency: 'ILS',
        items: [{ item_id: item.id, item_name: item.name, price: item.price, item_category: item.category ?? '', quantity: qty }],
      },
    }));
    tap('fbq', () => window.fbq?.('track', 'AddToCart', {
      content_ids: [item.id],
      content_type: 'product',
      value: item.price * qty,
      currency: 'ILS',
      content_name: item.name,
    }));
  }
  // First-party funnel capture (separate from the third-party dataLayer/fbq above, which store
  // nothing we can query). One central call here covers every add-to-cart surface — product page,
  // store card, quick-view modal. The session id is read server-side from the httpOnly sn_vid
  // cookie, never sent from here.
  //
  // Inside `tap` like the two above, even though this half is ours and the `.catch` already covers
  // the request failing. What the `.catch` cannot cover is `fetch` throwing SYNCHRONOUSLY — which is
  // what a browser extension that has monkey-patched `window.fetch` does, and those are common on
  // exactly the machines that also run an ad blocker. The rejection path and the throw path are
  // different paths, and only one of them was handled.
  tap('funnel', () => {
    void fetch('/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The raw uuid, never `item.id` — see the field docs. Omitted rather than blanked when absent:
      // the route records the stage regardless and only the product attribution is lost.
      body: JSON.stringify({ type: 'add_to_cart', ...(item.productId ? { productId: item.productId } : {}) }),
      keepalive: true,
    }).catch(() => undefined);
  });
}

/**
 * The buyer reached checkout — GA4 `begin_checkout` / Meta `InitiateCheckout`.
 *
 * **This is the third-party half only.** Our own first-party funnel already counts this stage
 * server-side, in `middleware.ts`, off the `/checkout` page view: that one cannot be blocked and
 * cannot be inflated, and it is what the seller dashboard reads. This call adds nothing to it. What
 * it adds is the event Google and Meta need in order to optimise a campaign towards buyers who
 * actually start paying, which is the whole reason the platform runs ads at all.
 *
 * No first-party `fetch` beside it, unlike `trackAddToCart`: duplicating a stage the middleware
 * already recorded on this very page load would double-count it.
 *
 * **Only ever fire this for lines that can actually be bought.** A showcase store's items sit in
 * the cart on purpose and can never reach an order (`lib/demo-stores.ts`), so counting them here
 * would teach both networks to optimise towards a purchase that is refused by design.
 */
export function trackInitiateCheckout(input: readonly TrackLine[]): void {
  // Same rule as the single-item calls (`reportable`): a line we cannot name is dropped rather
  // than sent under a blank id. Dropping the LINE and not the event is the right trade here —
  // the checkout genuinely started, and the remaining lines still describe it.
  const lines = input.filter(reportable);
  if (!lines.length) return;
  // `sumMoney`, not an inline reduce-and-round: this is the number a campaign is optimised against
  // and the denominator of every ROAS the seller reads, so it rounds by the one definition
  // (lib/money.ts) rather than by a second one that drifts from it.
  const value = sumMoney(lines.map((l) => l.price * l.qty));
  const numItems = lines.reduce((sum, l) => sum + l.qty, 0);
  tap('dataLayer', () => window.dataLayer?.push({
    event: 'begin_checkout',
    ecommerce: {
      currency: 'ILS',
      value,
      items: lines.map((l) => ({
        item_id: l.id, item_name: l.name, price: l.price, item_category: l.category ?? '', quantity: l.qty,
      })),
    },
  }));
  tap('fbq', () => window.fbq?.('track', 'InitiateCheckout', {
    content_ids: lines.map((l) => l.id),
    // `contents` carries the quantities that `content_ids` cannot. Meta accepts either; sending
    // both is what lets its value-optimisation see a cart of five as different from a cart of one.
    contents: lines.map((l) => ({ id: l.id, quantity: l.qty, item_price: l.price })),
    content_type: 'product',
    value,
    currency: 'ILS',
    num_items: numItems,
  }));
}
