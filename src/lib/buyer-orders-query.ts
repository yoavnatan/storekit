import type { BuyerPurchase } from './buyer-purchases.js';

// Server-side counterpart of the buyer dashboard's Orders tab (mirrors
// seller-orders-query.ts's pattern) — search + active/history split run here
// over the buyer's full list before slicing to a page.
//
// It works on PURCHASES, not on `orders` rows (2026-08-05): the tab shows one
// card per purchase, so a page has to be five of those. Filtering rows and then
// grouping would have handed the page five rows — sometimes two cards, sometimes
// five — and split one purchase across a page boundary.
export const BUYER_ORDER_PAGE_SIZE = 5;

export interface BuyerOrderQuery {
  q: string;
  history: boolean;
}

export function parseBuyerOrderQuery(sp: URLSearchParams): BuyerOrderQuery {
  return {
    q: (sp.get('oq') ?? '').trim(),
    history: sp.get('ohist') === '1',
  };
}

/** Everything in the purchase a search may match — including every slice's own
 *  order id, so an id from a per-store email still finds the card it is in. */
function purchaseSearchHaystack(p: BuyerPurchase): string {
  const ids = p.slices.map((s) => s.order.id).join(' ');
  const stores = [...new Set(p.slices.map((s) => s.storeName))].join(' ');
  const products = p.slices.flatMap((s) => s.order.items.map((i) => i.productName)).join(' ');
  return `${p.ref} ${ids} ${stores} ${products}`.toLowerCase();
}

// `purchases` is already newest-first from the caller — filtering alone
// preserves that order, no re-sort needed (no sort UI on this tab).
export function filterBuyerPurchases(purchases: BuyerPurchase[], query: BuyerOrderQuery): BuyerPurchase[] {
  const q = query.q.toLowerCase();
  return purchases.filter((p) => {
    // `awaiting` reads the status table rather than testing for 'delivered'
    // here — see the buyerAwaiting column in order-status-rules.ts.
    if (query.history === p.awaiting) return false;
    if (q && !purchaseSearchHaystack(p).includes(q)) return false;
    return true;
  });
}
