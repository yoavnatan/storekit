import type { Order } from './orders.js';

// Server-side counterpart of the buyer dashboard's Orders tab (mirrors
// seller-orders-query.ts's pattern) — search + active/history split run here
// over the buyer's full order list before slicing to a page.
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

function orderSearchHaystack(o: Order): string {
  const stores = [...new Set(o.items.map((i) => i.storeName))].join(' ');
  const products = o.items.map((i) => i.productName).join(' ');
  return `${o.id} ${o.checkoutRef ?? ''} ${stores} ${products}`.toLowerCase();
}

// `orders` is already sorted newest-first by the caller — filtering alone
// preserves that order, no re-sort needed (no sort UI on this tab).
export function filterBuyerOrders(orders: Order[], query: BuyerOrderQuery): Order[] {
  const q = query.q.toLowerCase();
  return orders.filter((o) => {
    const isHistory = o.shippingStatus === 'delivered';
    if (query.history !== isHistory) return false;
    if (q && !orderSearchHaystack(o).includes(q)) return false;
    return true;
  });
}
