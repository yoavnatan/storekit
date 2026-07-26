// Shared PURE building blocks for transactional emails — reused by the
// order-confirmation (order-emails.ts) and order-status (order-status-email.ts)
// builders so store grouping, item rows and thumbnails render identically across
// every email the platform sends. No I/O.

import type { Order } from '../orders.js';
import { store, formatPrice, cdnSrc } from '../../config/store.config.js';
import { esc, emailColors as C } from './template.js';

/** Canonical site origin (no trailing slash) — links back to the platform/stores. */
export const SITE = store.url.replace(/\/$/, '');

export function storefrontUrl(slug: string): string {
  return `${SITE}/${encodeURIComponent(slug)}`;
}

/** A single-store order's display name + slug (an order = one store post-checkout). */
export function storeMeta(order: Order): { name: string; slug: string } {
  const slug = order.items[0]?.storeSlug ?? Object.keys(order.storeSubtotals)[0] ?? '';
  const name = order.items[0]?.storeName ?? order.storeSubtotals[slug]?.storeName ?? slug;
  return { name, slug };
}

/** Store name + a "לחנות ›" link — the sovereignty marker atop each store's items. */
export function storeHeader(order: Order): string {
  const { name, slug } = storeMeta(order);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;">
<tr>
<td style="text-align:right;font-size:15px;font-weight:700;color:${C.text};">${esc(name)}</td>
<td style="text-align:left;white-space:nowrap;"><a href="${esc(storefrontUrl(slug))}" style="color:${C.accent};text-decoration:none;font-size:13px;font-weight:600;">לחנות ›</a></td>
</tr>
</table>`;
}

/** 48px thumbnail cell (Cloudinary-downsized when possible). White background
 *  per the design system — the photo may be background-removed (transparent). */
function thumbCell(image: string | undefined): string {
  const box = `width:48px;height:48px;border-radius:8px;border:1px solid ${C.border};background:${C.surface};display:block;`;
  const inner = image
    ? `<img src="${esc(cdnSrc(image, 96))}" alt="" width="48" height="48" style="${box}object-fit:cover;">`
    : `<div style="${box}"></div>`;
  return `<td valign="top" style="padding:10px 0;border-top:1px solid ${C.border};width:48px;">${inner}</td>`;
}

/** Item rows with thumbnail, name+qty (qty beside the item), variants, line total. */
function itemRows(items: Order['items']): string {
  return items.map((it) => {
    const variants = it.selectedVariants && Object.keys(it.selectedVariants).length
      ? `<br><span style="color:${C.muted};font-size:13px;">${esc(Object.entries(it.selectedVariants).map(([k, v]) => `${k}: ${v}`).join(', '))}</span>`
      : '';
    return `<tr>
${thumbCell(it.image)}
<td style="padding:10px 12px;border-top:1px solid ${C.border};text-align:right;font-size:14px;">
<strong>${esc(it.productName)}</strong> <span style="color:${C.muted};font-weight:600;">× ${it.qty}</span>${variants}
</td>
<td style="padding:10px 0;border-top:1px solid ${C.border};text-align:left;font-size:14px;white-space:nowrap;vertical-align:top;">${esc(formatPrice(it.price * it.qty))}</td>
</tr>`;
  }).join('');
}

export function itemsTable(items: Order['items']): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0;">${itemRows(items)}</table>`;
}

export function refLine(ref: string): string {
  return `<p style="margin:0 0 12px;color:${C.muted};font-size:13px;">מספר אסמכתא: <strong style="color:${C.text};">${esc(ref)}</strong></p>`;
}

/** A primary CTA button (accent-filled). */
export function ctaButton(href: string, label: string): string {
  return `<p style="margin:20px 0 0;">
<a href="${esc(href)}" style="display:inline-block;background:${C.accent};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">${esc(label)}</a>
</p>`;
}
