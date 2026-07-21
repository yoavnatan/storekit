export interface TrackItem {
  id: string;
  name: string;
  price: number;
  category?: string;
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
