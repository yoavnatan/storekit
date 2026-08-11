/** The sale price + badge markup, in ONE place.
 *
 *  Prices render on ~8 surfaces, and half of them build their HTML as client-side template
 *  strings (store grid "load more", quick-view, store modal, header search) rather than as
 *  Astro markup. A component alone would therefore cover only half the surfaces and the other
 *  half would drift, so the markup is generated here as a string and the Astro side renders it
 *  through `set:html` — same output, one definition.
 *
 *  Pure/isomorphic. Every value is escaped or numeric; nothing here interpolates raw user text.
 */

import { formatPrice } from '../config/store.config.js';
import { escapeHtml } from './html-escape.js';
import type { PriceView } from './discounts.js';

export interface PriceHtmlOptions {
  /** The surface's own price class, so each keeps its existing typography/size. */
  className?: string;
  /** Rendered when the price is discounted but the percentage rounds below 1% (a tiny ₪-off). */
  saleLabel?: string;
}

/** The corner tag on a product image. Shares ONE box with `.badge--new` — `.img-badge` in
 *  utils.css, where the reasoning lives — and differs from it only by fill: this is the coloured
 *  mark (sale green), "new" is the quiet white chip. Both sit on the inline-START edge, and the
 *  CSS stacks this one below "new" when a product carries both; the opposite corner belongs to
 *  the wishlist heart.
 *
 *  `dir="ltr"` is on an INNER span, never the badge itself: a logical inset (`inset-inline-start`)
 *  resolves against the element's OWN direction, so putting dir on the badge silently flipped it
 *  to the heart's corner on this RTL site. The inner span still keeps "-25%" from rendering as
 *  "25%-". */
export function saleBadgeHtml(view: PriceView, saleLabel = 'מבצע', className = ''): string {
  if (!view.isDiscounted || !view.showBadge) return '';
  // Coerced rather than trusted: on the client the view is rebuilt from an API payload, so the
  // percentage is only a number by convention until it is made one here.
  const text = view.percentOff >= 1 ? `-${Math.round(Number(view.percentOff) || 0)}%` : escapeHtml(saleLabel);
  // `img-badge` FIRST and always: it carries the whole box (position, size, radius, type) and
  // `sale-badge` only the fill. Dropping it renders an unpositioned scrap of green text in the
  // middle of the card — there is nothing left in `sale-badge` that could hold it in the corner.
  const cls = `img-badge sale-badge${className ? ` ${className}` : ''}`;
  return `<span class="${escapeHtml(cls)}"><span dir="ltr">${text}</span></span>`;
}

/** Current price (green when discounted) followed by the struck-through original. */
export function priceHtml(view: PriceView, { className = '', saleLabel }: PriceHtmlOptions = {}): string {
  const cls = `${className} price-now${view.isDiscounted ? ' price-now--sale' : ''}`.trim();
  const now = `<span class="${escapeHtml(cls)}">${escapeHtml(formatPrice(view.price))}</span>`;
  if (!view.isDiscounted) return now;
  const label = saleLabel ? ` aria-label="${escapeHtml(saleLabel)}"` : '';
  return `${now}<s class="price-was"${label}>${escapeHtml(formatPrice(view.basePrice))}</s>`;
}
