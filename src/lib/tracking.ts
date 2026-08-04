import { sumMoney } from './money.js';

export interface TrackItem {
  id: string;
  name: string;
  price: number;
  category?: string;
}

/** A cart line — a `TrackItem` plus how many of it. Checkout reports lines, not products. */
export interface TrackLine extends TrackItem {
  qty: number;
}

export function trackViewContent(item: TrackItem): void {
  window.dataLayer?.push({
    event: 'view_item',
    ecommerce: {
      currency: 'ILS',
      items: [{ item_id: item.id, item_name: item.name, price: item.price, item_category: item.category ?? '' }],
    },
  });
  window.fbq?.('track', 'ViewContent', {
    content_ids: [item.id],
    content_type: 'product',
    value: item.price,
    currency: 'ILS',
    content_name: item.name,
  });
}

export function trackAddToCart(item: TrackItem, qty: number): void {
  window.dataLayer?.push({
    event: 'add_to_cart',
    ecommerce: {
      currency: 'ILS',
      items: [{ item_id: item.id, item_name: item.name, price: item.price, item_category: item.category ?? '', quantity: qty }],
    },
  });
  window.fbq?.('track', 'AddToCart', {
    content_ids: [item.id],
    content_type: 'product',
    value: item.price * qty,
    currency: 'ILS',
    content_name: item.name,
  });
  // First-party funnel capture (separate from the third-party dataLayer/fbq
  // above, which store nothing we can query). One central call here covers every
  // add-to-cart surface — product page, store card, quick-view modal. The session
  // id is read server-side from the httpOnly sn_vid cookie, never sent from here.
  void fetch('/api/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'add_to_cart', productId: item.id }),
    keepalive: true,
  }).catch(() => undefined);
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
export function trackInitiateCheckout(lines: readonly TrackLine[]): void {
  if (!lines.length) return;
  // `sumMoney`, not an inline reduce-and-round: this is the number a campaign is optimised against
  // and the denominator of every ROAS the seller reads, so it rounds by the one definition
  // (lib/money.ts) rather than by a second one that drifts from it.
  const value = sumMoney(lines.map((l) => l.price * l.qty));
  const numItems = lines.reduce((sum, l) => sum + l.qty, 0);
  window.dataLayer?.push({
    event: 'begin_checkout',
    ecommerce: {
      currency: 'ILS',
      value,
      items: lines.map((l) => ({
        item_id: l.id, item_name: l.name, price: l.price, item_category: l.category ?? '', quantity: l.qty,
      })),
    },
  });
  window.fbq?.('track', 'InitiateCheckout', {
    content_ids: lines.map((l) => l.id),
    // `contents` carries the quantities that `content_ids` cannot. Meta accepts either; sending
    // both is what lets its value-optimisation see a cart of five as different from a cart of one.
    contents: lines.map((l) => ({ id: l.id, quantity: l.qty, item_price: l.price })),
    content_type: 'product',
    value,
    currency: 'ILS',
    num_items: numItems,
  });
}
