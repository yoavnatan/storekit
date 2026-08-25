import { rows } from './db.js';
import { activePaymeCredentials, getSellerServices, getSellerTransactions, type PaymeCredentials, type PaymeTransaction } from './payment-payme.js';
import { invoiceOffer } from './seller-invoicing.js';
import { markBuyerInvoiceProvided } from './invoicing/buyer-invoice.js';
import { logError } from './error-log.js';

/**
 * Fetch the invoices PayMe issued in a seller's name, and put them on his orders.
 *
 * ── The half that was missing (owner, 2026-08-25) ──
 * *"אם המוכר לוקח את השירות של פיימי של החשבוניות איפה הוא רואה את החשבונית?"* — nowhere, until
 * this. The switch that turns the service on was built the same day (`seller-invoicing.ts`), and a
 * seller who threw it would have been billed monthly for documents that appeared on no screen of
 * ours, with his order cards still asking him to upload the invoice he was now paying to have
 * issued. A feature that bills and shows nothing is worse than no feature.
 *
 * ── A PULL, not the callback, and that is deliberate ──
 * `sale_invoice_url` is on their sale callback, which has never been received end to end because it
 * needs a public URL we do not have (`docs/payme-sandbox-notes.md`). `transaction_invoice_url` is on
 * every row of `get-transactions`, a call we make with our own key — so this works today, on a
 * laptop, with no hosting. When the callback does start arriving it may settle the same row first;
 * `markBuyerInvoiceProvided` is idempotent and keeps the first `issued_at`.
 *
 * ── The join is PayMe's sale id, not our own reference ──
 * `orders.payment_ref` holds THIS store's capture id, written by `markOrdersPaid` under the split
 * model, and `get-transactions` returns the same id. Matching on it needs nothing from them beyond
 * what they already send — unlike our `transaction_id`, which they echo back and which was measured
 * EMPTY on a sale created outside the checkout. A join that depends on a field a probe can leave
 * blank is a join that silently attaches nothing.
 *
 * ── Only sellers who are PAYING for it ──
 * The service costs the seller ₪15 a month plus ₪0.3 a document, so it is off for almost everyone,
 * and asking PayMe for the transactions of a seller without it is a round trip that can only return
 * nulls. `invoiceOffer(...).active` is the gate, read per seller from their own account rather than
 * from anything we store — the same rule the card obeys.
 *
 * ── Never throws, and isolates each seller ──
 * It runs from the scheduler. One seller whose account PayMe cannot read must not stop the rest,
 * which is the rule `jobs/registry.ts` states for every per-store job.
 */

/** What one pass did, for the line the scheduler prints. */
export interface InvoiceSyncResult {
  /** Sellers whose invoicing service is on and who were therefore asked. */
  sellersChecked: number;
  /** Orders that gained a document link in this pass. */
  attached: number;
}

/** A seller with a clearing account — the only ones who can have the service at all. */
interface MerchantRow { seller_id: string; provider_ref: string }

/**
 * Attach whatever documents these transactions carry to the orders they belong to.
 *
 * Exported so the mapping is testable without PayMe: which rows are skipped, which order a charge
 * resolves to, and that a seller can only ever settle his own. The ownership is not enforced here
 * but in the two places that can enforce it properly — the query joins the order's store to THIS
 * seller, and `markBuyerInvoiceProvided` scopes its UPDATE by `seller_id` as well.
 */
export async function attachInvoices(sellerId: string, txs: readonly PaymeTransaction[]): Promise<number> {
  let attached = 0;
  for (const tx of txs) {
    // No document on this charge: either the service was off when it ran, or PayMe have not issued
    // one yet. Both are the ordinary case and neither is worth a query.
    if (!tx.invoiceUrl || !tx.saleId) continue;
    const found = await rows<{ id: string }>(
      `SELECT o.id
         FROM orders o
         JOIN stores s ON s.slug = o.store_slug
        WHERE o.payment_ref = $1 AND s.seller_id = $2
        LIMIT 1`,
      [tx.saleId, sellerId],
    ).catch(() => [] as { id: string }[]);
    const order = found[0];
    // A charge of his that we cannot place is not an error: the delivery leg is on OUR merchant
    // account and belongs to no order, and the sandbox is shared with PayMe's other partners.
    if (!order) continue;
    const state = await markBuyerInvoiceProvided(sellerId, order.id, {
      mode: 'processor',
      documentUrl: tx.invoiceUrl,
    }).catch(() => null);
    // `null` also comes back when the URL is not on a PayMe host, which is the check that keeps a
    // third party's JSON from putting an arbitrary link on a page a buyer clicks.
    if (state) attached++;
  }
  return attached;
}

/**
 * One pass: every seller whose invoicing service is on, and every recent charge of theirs.
 */
export async function runPaymeInvoiceSync(
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<InvoiceSyncResult> {
  const result: InvoiceSyncResult = { sellersChecked: 0, attached: 0 };
  if (!creds) return result;

  const merchants = await rows<MerchantRow>(
    `SELECT seller_id, provider_ref FROM seller_merchant_accounts WHERE provider_ref <> '' AND approved = true`,
  ).catch(() => [] as MerchantRow[]);

  for (const m of merchants) {
    try {
      const offer = invoiceOffer(await getSellerServices(m.provider_ref, creds));
      if (!offer?.active) continue;
      result.sellersChecked++;
      result.attached += await attachInvoices(m.seller_id, await getSellerTransactions(m.provider_ref, creds, 50));
    } catch (err) {
      // One seller's account being unreadable must not stop the others — and it is logged rather
      // than swallowed, because a seller paying monthly for documents that never appear is exactly
      // the silence this module exists to end.
      await logError({
        source: 'server',
        route: 'job:payme-invoices',
        message: `could not sync invoices for seller ${m.seller_id}: ${err instanceof Error ? err.message : String(err)}`,
        actorRole: 'seller',
        actorId: m.seller_id,
        resolutionHint: 'מוכר משלם לחברת הסליקה על הפקת חשבוניות ואנחנו לא מצליחים למשוך אותן. החשבוניות עצמן קיימות אצלם — מה שחסר הוא הקישור אליהן בכרטיס ההזמנה.',
      }).catch(() => { /* nothing left to try */ });
    }
  }
  return result;
}
