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
}
