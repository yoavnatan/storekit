export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { markBuyerInvoiceProvided, type BuyerInvoiceMode } from '../../../lib/invoicing/buyer-invoice.js';
import { getOrderById, orderBelongsToStore } from '../../../lib/orders.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getSellerById } from '../../../lib/seller-auth.js';
import { planBuyerInvoice } from '../../../lib/invoicing/index.js';
import { PAYMENT_STATUS_RULES } from '../../../lib/order-status-rules.js';

/**
 * The seller settling the buyer's invoice for one order — uploaded, or handed over with the goods.
 *
 * Nothing here issues a tax document and nothing here moves money. It records a claim the seller
 * makes about a document he produced in his own system, which is the whole of the platform's role
 * after the 2026-08-13 decision (`lib/invoicing/buyer-invoice.ts` carries the reasoning).
 *
 * The session is the ONLY thing that scopes the write. No store slug is read from the body and none
 * is needed: the document row is keyed by order and seller, and `markBuyerInvoiceProvided` puts the
 * session's seller id in the WHERE rather than trusting anything sent. A seller naming an order that
 * is not his gets the same 404 as an order that does not exist.
 *
 * CSRF is not checked here because it is checked once, in `middleware.ts`, for every mutating route.
 */

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Body {
  orderId?: unknown;
  mode?: unknown;
  documentUrl?: unknown;
}

const isMode = (v: unknown): v is BuyerInvoiceMode => v === 'upload' || v === 'handover';

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const read = await readJsonBody<Body>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);

  const { orderId, mode, documentUrl } = read.value ?? {};
  if (typeof orderId !== 'string' || !orderId) return json({ error: 'Missing orderId' }, 400);
  if (!isMode(mode)) return json({ error: 'Invalid mode' }, 400);

  const url = typeof documentUrl === 'string' ? documentUrl : null;
  let state = await markBuyerInvoiceProvided(sellerId, orderId, { mode, documentUrl: url });

  // ── Nothing to settle yet: plan the row, then settle it ──
  // `checkout.ts` writes the "this order owes an invoice" row at purchase, so every order placed
  // after that code shipped has one. Every order placed BEFORE it does not — which on a real
  // installation is the entire back catalogue, and was every order on the owner's machine (32 of
  // them, 0 rows). The seller pressed "צורפה לחבילה", the UPDATE matched nothing, and the button
  // did nothing at all, forever, on every order he had.
  //
  // The backfill is where the authorization has to be re-established, because the UPDATE's own
  // `seller_id` in the WHERE is what was doing that job and an INSERT has no such filter. So the
  // order is loaded and one of THIS seller's stores must really be in it — an id from the request
  // is not a permission. `planBuyerInvoice` does the writing, so the amount rule (goods only, VAT
  // by the seller's business type) stays in one place rather than being restated here.
  if (!state) {
    const [order, stores, seller] = await Promise.all([
      getOrderById(orderId),
      getStoresBySellerId(sellerId),
      getSellerById(sellerId),
    ]);
    const slug = order && seller ? stores.find((s) => orderBelongsToStore(order, s.slug))?.slug : undefined;
    // An unpaid or cancelled order is not a sale, and inventing a tax document for one would put a
    // number on the seller's books that no money stands behind.
    if (order && slug && seller && PAYMENT_STATUS_RULES[order.paymentStatus]?.moneyWasTaken) {
      await planBuyerInvoice(order, slug, seller);
      state = await markBuyerInvoiceProvided(sellerId, orderId, { mode, documentUrl: url });
    }
  }
  // `null` covers three cases that must NOT be told apart from outside: not this seller's order, no
  // such order, and an upload whose URL was not one of ours. Distinguishing them would turn this
  // route into a way to ask which order ids exist.
  if (!state) return json({ error: 'Not found' }, 404);

  return json({ ok: true, invoice: state });
}
