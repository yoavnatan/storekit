// Order-confirmation email content — PURE builders (no I/O), so they're unit
// testable and reusable by any trigger. The checkout route resolves recipients
// + persists orders, then hands the plain Order data here.
//
// Two audiences, two builders:
//   • buyer  — one email for the whole checkout (all per-store orders under one
//     checkoutRef), so a multi-store cart isn't 3 separate inbox pings. Items
//     are GROUPED BY STORE, each group named + linked to its storefront: the
//     mall model's "each store is sovereign / one bag grouped by store" — the
//     store keeps its identity, Dezabin stays the umbrella around it.
//   • seller — one email per their own order. The store name is in the heading
//     AND subject so a seller who runs several stores instantly sees which one.
// This is the channel that finally reaches GUEST buyers (no in-app account) —
// closing CURRENT_TASK checklist item #5. Shared render helpers live in parts.ts.

import type { Order } from '../orders.js';
import { store, formatPrice } from '../../config/store.config.js';
import type { EmailMessage } from './adapter.js';
import { renderEmailShell, esc, emailColors as C } from './template.js';
import { SITE, storefrontUrl, storeMeta, storeHeader, itemsTable, refLine, ctaButton } from './parts.js';

/** Buyer view of one store: named + linked header, its items, its own shipping. */
function storeSection(order: Order): string {
  return `${storeHeader(order)}
${itemsTable(order.items)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="text-align:right;font-size:13px;color:${C.muted};">משלוח</td>
<td style="text-align:left;font-size:13px;color:${C.muted};white-space:nowrap;">${order.shippingAmount === 0 ? 'חינם' : esc(formatPrice(order.shippingAmount))}</td></tr>
</table>`;
}

/** Full price breakdown (subtotal / shipping / total) — used in the seller email. */
function totalsBlock(order: Order): string {
  const line = (label: string, value: string, strong = false) => `<tr>
<td style="padding:4px 0;text-align:right;font-size:${strong ? '16px' : '14px'};${strong ? 'font-weight:700;' : `color:${C.muted};`}">${esc(label)}</td>
<td style="padding:4px 0;text-align:left;font-size:${strong ? '16px' : '14px'};${strong ? 'font-weight:700;' : `color:${C.muted};`}white-space:nowrap;">${esc(value)}</td>
</tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${C.border};margin-top:4px;padding-top:4px;">
${line('סכום ביניים', formatPrice(order.totalAmount - order.shippingAmount))}
${line('משלוח', order.shippingAmount === 0 ? 'חינם' : formatPrice(order.shippingAmount))}
${line('סה"כ', formatPrice(order.totalAmount), true)}
</table>`;
}

/** One bold grand-total line across every store in the checkout (buyer email). */
function grandTotalLine(orders: Order[]): string {
  const grand = orders.reduce((s, o) => s + o.totalAmount, 0);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${C.border};margin-top:14px;padding-top:8px;">
<tr>
<td style="text-align:right;font-size:16px;font-weight:700;">סה"כ לתשלום</td>
<td style="text-align:left;font-size:16px;font-weight:700;white-space:nowrap;">${esc(formatPrice(grand))}</td>
</tr>
</table>`;
}

function addressBlock(order: Order): string {
  const a = order.buyerAddress;
  const parts = [a.street, a.city, a.zip].filter(Boolean).map((p) => esc(String(p))).join(', ');
  return `<p style="margin:16px 0 0;color:${C.muted};font-size:13px;line-height:1.6;">
<strong style="color:${C.text};">כתובת למשלוח</strong><br>${esc(order.buyerName)}<br>${parts}<br>${esc(order.buyerPhone)}
</p>`;
}

/** One confirmation email for the buyer covering the entire checkout. */
export function buildBuyerOrderConfirmation(orders: Order[]): EmailMessage {
  const first = orders[0]!;
  const ref = first.checkoutRef ?? first.id;
  const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(first.buyerName)},</p>
<p style="margin:0 0 12px;">קיבלנו את הזמנתך והיא בטיפול. תודה שקנית ב-${esc(store.name)}!</p>
${refLine(ref)}
${orders.map(storeSection).join('')}
${grandTotalLine(orders)}
${orders.length > 1 ? `<p style="margin:12px 0 0;color:${C.muted};font-size:13px;line-height:1.6;">ההזמנה כוללת כמה חנויות. כל חנות אורזת ושולחת את הפריטים שלה בנפרד, כך שהם עשויים להגיע בזמנים שונים ובחבילות נפרדות.</p>` : ''}
${addressBlock(first)}
<p style="margin:20px 0 0;color:${C.muted};font-size:13px;">נעדכן אותך במייל כשההזמנה יוצאת אליך.</p>
<p style="margin:8px 0 0;color:${C.muted};font-size:12px;">זהו אישור הזמנה בלבד ואינו מהווה חשבונית מס. חשבונית תישלח בנפרד.</p>
${ctaButton(SITE, `להמשך קנייה ב-${store.name}`)}`;
  return {
    to: first.buyerEmail,
    subject: `אישור הזמנה · ${store.name} (${ref})`,
    html: renderEmailShell({ previewText: `ההזמנה שלך התקבלה — אסמכתא ${ref}`, heading: 'ההזמנה שלך התקבלה', bodyHtml }),
    text: buyerText(orders, ref),
  };
}

/** One notification email per seller order — the fulfilment brief. */
export function buildSellerOrderNotification(order: Order, sellerEmail: string): EmailMessage {
  const ref = order.checkoutRef ?? order.id;
  const { name: storeName } = storeMeta(order);
  const bodyHtml = `
<p style="margin:0 0 12px;">התקבלה הזמנה חדשה בחנות <strong>${esc(storeName)}</strong> על סך <strong>${esc(formatPrice(order.totalAmount))}</strong>.</p>
${refLine(ref)}
${itemsTable(order.items)}
${totalsBlock(order)}
${addressBlock(order)}
${ctaButton(`${SITE}/seller/dashboard`, 'לצפייה בהזמנה בדשבורד')}`;
  return {
    to: sellerEmail,
    // Store name leads the subject so a multi-store seller sorts by store at a glance.
    subject: `הזמנה חדשה · ${storeName} · ${formatPrice(order.totalAmount)} (${ref})`,
    html: renderEmailShell({ previewText: `הזמנה חדשה בחנות ${storeName}`, heading: `הזמנה חדשה · ${storeName}`, bodyHtml }),
    text: sellerText(order, ref, storeName),
  };
}

// Plain-text fallbacks — deliverability + non-HTML clients.
function itemsText(items: Order['items']): string {
  return items.map((it) => `- ${it.productName} ×${it.qty} — ${formatPrice(it.price * it.qty)}`).join('\n');
}

function buyerText(orders: Order[], ref: string): string {
  const grand = orders.reduce((s, o) => s + o.totalAmount, 0);
  const blocks = orders.map((o) => {
    const { name, slug } = storeMeta(o);
    return `${name} (${storefrontUrl(slug)}):\n${itemsText(o.items)}`;
  }).join('\n\n');
  return `שלום ${orders[0]!.buyerName},\nההזמנה שלך התקבלה. אסמכתא: ${ref}\n\n${blocks}\n\nסה"כ לתשלום: ${formatPrice(grand)}\n\n${store.name} · ${SITE}`;
}

function sellerText(order: Order, ref: string, storeName: string): string {
  return `הזמנה חדשה בחנות ${storeName}. אסמכתא: ${ref}\n\n${itemsText(order.items)}\n\nסה"כ: ${formatPrice(order.totalAmount)}\n\n${store.name}`;
}
