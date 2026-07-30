/** Keeps the buyer's stored cart priced like the catalog it came from.
 *
 *  A cart sits in localStorage for as long as the shopper leaves it there, while the seller
 *  keeps running sales behind it. Every surface that shows a cart price — the drawer, the
 *  checkout summary — therefore re-prices against /api/cart/prices, which resolves each line
 *  exactly the way /api/checkout will when the money moves.
 *
 *  Re-pricing is tied to MOMENTS OF ATTENTION, never to a timer: the first load, coming back
 *  to a tab that was left open, a bfcache back-navigation, opening the drawer, and pressing
 *  pay. A tab abandoned for an hour is the case this exists for — it used to keep showing the
 *  price the sale had when the page loaded, and /api/checkout would then silently charge the
 *  current one. Polling would only spend requests on shoppers who aren't looking.
 *
 *  It reports WHICH lines moved and in which direction rather than a bare "something changed",
 *  because the buyer must never pay for this mechanism's caution: a price that dropped, or a
 *  line they aren't buying right now, has no business interrupting anything.
 */

import { getActiveStoreCarts, applyServerPrices, type CartPriceChange } from './cart.js';

export type { CartPriceChange };

/** How long a completed re-price is trusted. A sale starts or ends at most a few times a day,
 *  so a minute of trust costs the buyer nothing and keeps rapid tab-flipping from turning into
 *  one request per flip. Pass `maxAge: 0` at a moment that must be exact (pressing pay). */
const FRESH_MS = 60_000;

/** A price check must never be the reason a purchase feels slow or stops. Past this, the answer
 *  is abandoned and the caller carries on: the server re-derives every price before charging
 *  anyway, so a missed check costs correctness nothing — it only costs this display guarantee. */
const CHECK_TIMEOUT_MS = 2500;

let pending: Promise<CartPriceChange[]> | null = null;
let lastAt = 0;
let installed = false;
const listeners: Array<(changes: CartPriceChange[]) => void> = [];

/** Resolves to the lines that actually moved — empty when nothing did, so a caller re-renders
 *  (and a buyer sees movement) only when there is something to show. */
export function refreshCartPrices(opts: { maxAge?: number } = {}): Promise<CartPriceChange[]> {
  if (pending) return pending;
  if (lastAt && Date.now() - lastAt < (opts.maxAge ?? FRESH_MS)) return Promise.resolve([]);

  // Variants travel with each line: stock lives per combo, so a variant line asked about by slug
  // alone can only be answered from the shared pool — and that is the wrong ceiling for it.
  const lines = getActiveStoreCarts().flatMap((cart) =>
    cart.items.map((item) => ({
      storeSlug: cart.storeSlug,
      slug: item.slug,
      ...(item.selectedVariants && Object.keys(item.selectedVariants).length ? { selectedVariants: item.selectedVariants } : {}),
    })),
  );
  if (!lines.length) return Promise.resolve([]);

  pending = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetch('/api/cart/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: lines }),
        signal: abort.signal,
      });
      if (!res.ok) return [];
      const data = await res.json() as { ok?: boolean; items?: Parameters<typeof applyServerPrices>[0] };
      if (!data.ok || !Array.isArray(data.items)) return [];
      return applyServerPrices(data.items);
    } catch {
      // Offline, slow, or server down — the stored prices stay as they are, and checkout still
      // re-derives server-side before charging anything. Never block the cart on this.
      return [];
    } finally {
      clearTimeout(timer);
      // Stamped even on failure: an offline tab shouldn't retry on every tab switch.
      lastAt = Date.now();
      pending = null;
    }
  })();
  return pending;
}

/** True when a line the buyer is about to pay for got MORE expensive — the only case worth
 *  stopping a purchase over. A drop is charged as shown-or-better, so it goes through. */
export function hasIncrease(changes: CartPriceChange[], isBuying?: (change: CartPriceChange) => boolean): boolean {
  return changes.some((c) => c.to > c.from && (!isBuying || isBuying(c)));
}

/** The lines whose STOCK moved under the buyer — sold out, or clamped to fewer units than they
 *  asked for. Separate from a price move because the reaction is different: a price is corrected
 *  and re-read, while a quantity the buyer chose has just been reduced, and that must never happen
 *  silently at the moment they press pay. */
export function stockCorrections(changes: CartPriceChange[], isBuying?: (change: CartPriceChange) => boolean): CartPriceChange[] {
  return changes.filter((c) => (c.soldOut || c.clampedTo !== undefined) && (!isBuying || isBuying(c)));
}

/** Re-prices whenever the shopper's attention returns to this page, and calls back only when a
 *  price actually moved. Every surface on the page registers its own re-render over one set of
 *  DOM handlers and one in-flight request, so the checkout summary and the drawer can't end up
 *  showing different numbers. */
export function watchCartPrices(onChange: (changes: CartPriceChange[]) => void): void {
  listeners.push(onChange);
  if (installed) return;
  installed = true;

  // A bfcache restore can fire `pageshow` AND `visibilitychange` for one return. Both would
  // join the same in-flight request and both would announce its result — one event, two
  // toasts. Only the check that started the round reports it.
  let checking = false;
  const check = () => {
    if (checking) return;
    checking = true;
    void refreshCartPrices()
      .then((changes) => { if (changes.length) for (const fn of listeners) fn(changes); })
      .finally(() => { checking = false; });
  };

  // Returning to a tab that was left open — the case a once-per-load refresh can't cover.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  // A bfcache restore replays no scripts at all: without this, going Back to the cart shows
  // exactly the prices that were on screen when the shopper left, however long ago that was.
  window.addEventListener('pageshow', (e) => { if (e.persisted) check(); });
}
