export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { markBuyerInvoiceProvided, type BuyerInvoiceMode } from '../../../lib/invoicing/buyer-invoice.js';

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

  const state = await markBuyerInvoiceProvided(sellerId, orderId, {
    mode,
    documentUrl: typeof documentUrl === 'string' ? documentUrl : null,
  });
  // `null` covers three cases that must NOT be told apart from outside: not this seller's order, no
  // such order, and an upload whose URL was not one of ours. Distinguishing them would turn this
  // route into a way to ask which order ids exist.
  if (!state) return json({ error: 'Not found' }, 404);

  return json({ ok: true, invoice: state });
}
