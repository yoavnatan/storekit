import type { InvoicingAdapter } from './adapter.js';
import { createConsoleInvoicingAdapter } from './console-adapter.js';
import { planDocument, type InvoiceDocument } from './documents.js';
import { vatWithinAgorot, chargesVat } from '../vat.js';
import { orderNetForStore } from '../admin-stats.js';
import { commissionOnAgorot } from '../pricing.js';
import type { Order } from '../orders.js';
import type { Seller } from '../seller-auth.js';

/**
 * The two documents the agent model owes, and the one entry point each.
 *
 * Under the agent model the platform collects the buyer's money on the seller's behalf. That splits
 * the paperwork in a way the previous architecture never had to think about:
 *
 *   **seller → buyer** — the tax invoice for the order, for the FULL amount the buyer paid, issued
 *   in the SELLER's name because the seller is the one selling. We produce it for them; it is not
 *   ours. `terms.astro` promises the buyer exactly this.
 *
 *   **platform → seller** — our own invoice for what we charge them: commission, the monthly
 *   subscription, and the advertising margin. Three separate revenue streams
 *   (AI_INSTRUCTIONS → Business model), so three lines, never one blended "fees" figure — a seller
 *   reconciling their books needs to see which is which, and the commission is the only one of the
 *   three that was deducted at source rather than charged to a card.
 *
 * ── Why both are only PLANNED today ──
 * Nothing here issues a document, and that is a decision rather than a gap. Issuing in another
 * business's name binds a מספר הקצאה to that business's tax file, and whether we may do it — and
 * what authorisation the seller has to give — is a רו״ח question that is open
 * (`docs/legal-brief-agent-model.md` §6.3–6.4). So both functions write a `pending` row and return.
 * `countPendingDocuments()` is the backlog, and the day a provider and an answer arrive, issuing it
 * is a loop over that backlog rather than a new subsystem.
 *
 * ── Never throws ──
 * Same contract as `sendEmail`: a document is a consequence of a sale, and failing to record one
 * must not fail the sale. Every function here resolves, including on bad input.
 */

let cached: InvoicingAdapter | null = null;

/** The adapter in use. Only the console one exists — see the header for why that is the honest
 *  state and not an unfinished integration. */
export function invoicingAdapter(): InvoicingAdapter {
  if (!cached) cached = createConsoleInvoicingAdapter();
  return cached;
}

/**
 * The buyer's invoice for one store's slice of an order, owed by the seller.
 *
 * **The amount is the slice TOTAL the buyer paid, not the seller's net.** The buyer's document has
 * to match their card statement, so it includes shipping and is before any commission — commission
 * is a matter between the platform and the seller and appears on the other document entirely. This
 * is the same distinction `refund-owed.ts` draws between what the buyer is owed back and what the
 * seller loses.
 *
 * VAT is EXTRACTED from that gross figure, and only when the seller actually charges it: an
 * עוסק פטור's invoice shows none, and we do not know the answer for a seller who has not filled in
 * their business type — so we show none rather than assert a tax status on their behalf (`vat.ts`).
 */
export async function planBuyerInvoice(
  order: Order,
  storeSlug: string,
  seller: Pick<Seller, 'id' | 'businessType'>,
): Promise<InvoiceDocument | null> {
  // GOODS ONLY — shipping is deliberately NOT here, and this used to be wrong.
  //
  // Shipping money never reaches the seller: `payouts.ts` computes his balance from what buyers paid
  // for goods, "net of seller discounts, never shipping", because the carrier contract is the
  // platform's and the seller neither prices shipping nor profits from it
  // (memory `project_shipping_model`). A document that included it would have the seller invoicing
  // the buyer for money he was never paid — the two halves of one order disagreeing about who sold
  // what. The shipping fee is the platform's own revenue and belongs on the platform's own document.
  const grossAgorot = orderNetForStore(order, storeSlug);
  if (grossAgorot <= 0) return null;

  const vatAgorot = chargesVat(seller.businessType) ? vatWithinAgorot(grossAgorot) : 0;

  return planDocument({
    direction: 'seller_to_buyer',
    sellerId: seller.id,
    orderId: order.id,
    // A single document that is both invoice and receipt, because the money was already taken when
    // it is planned — issuing an invoice and a separate receipt for one paid order is two documents
    // where Israeli practice uses one.
    kind: 'tax_invoice_receipt',
    amountAgorot: grossAgorot,
    vatAgorot,
    detail: `order ${order.id} (${storeSlug}); issued in the seller's name for the full amount the buyer paid`,
  });
}

/**
 * The platform's monthly invoice to a seller — the three things we charge them for.
 *
 * **Every figure is passed IN, and that is the design.** `commissionAgorot` is the sum over that
 * month's orders at each store's own rate, and computing it here would be a second definition of a
 * number `seller-account.ts` and `payouts.ts` already agree on. Since 2026-08-24 the subscription is
 * the same kind of figure: a seller has one standing order whose price is the sum of his live
 * shops' plans (`store-plan.ts`), so there is no tier to look up here either — what was charged is
 * what `seller_subscriptions.price_agorot` says, and re-deriving it from a plan table is exactly
 * how an invoice starts disagreeing with a card statement.
 *
 * The ad margin is passed in for the third version of the same reason: it depends on real ad spend,
 * which is still mock data until an ad account is connected (GO_LIVE §2).
 *
 * VAT here is OUR VAT — the platform is a company and charges it — so it does not depend on the
 * seller's business type at all. That asymmetry is the whole point of two separate functions.
 */
export async function planPlatformInvoice(input: {
  seller: Pick<Seller, 'id'>;
  periodKey: string;
  commissionAgorot: number;
  /** What the standing order actually charged this month — `seller_subscriptions.price_agorot`.
   *  Absent or 0 is a seller who was not being billed for the period, which is a real state: he had
   *  no shop on the site (`store-plan.ts`). */
  subscriptionAgorot?: number;
  /** The platform's margin on advertising spend for the period. 0 until ads are connected. */
  adMarginAgorot?: number;
  /** The rate the commission above was actually taken at, for the human-readable line. Blended
   *  across his shops when they are on different plans (`seller-balance.ts`), because with a plan
   *  per shop no single percent is his. */
  commissionRate?: number;
}): Promise<InvoiceDocument | null> {
  const { seller, periodKey, commissionAgorot, adMarginAgorot = 0, subscriptionAgorot = 0, commissionRate = 0 } = input;
  const grossAgorot = commissionAgorot + subscriptionAgorot + adMarginAgorot;
  if (grossAgorot <= 0) return null;

  return planDocument({
    direction: 'platform_to_seller',
    sellerId: seller.id,
    periodKey,
    kind: 'tax_invoice',
    amountAgorot: grossAgorot,
    vatAgorot: vatWithinAgorot(grossAgorot),
    // The three streams named individually. A seller reconciling their books needs to see which
    // figure is which — and the commission is the only one already deducted from their payout.
    detail: `commission ${commissionAgorot} (deducted at source) + subscription ${subscriptionAgorot} + ad margin ${adMarginAgorot}, at ${commissionRate}%`,
  });
}

/** Re-exported so callers import one module. */
export { countPendingDocuments, getDocumentsForSeller } from './documents.js';
export type { InvoiceDocument } from './documents.js';
export { commissionOnAgorot };
