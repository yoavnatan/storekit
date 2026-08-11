import { rows, firstRow, isUuid } from '../db.js';

/**
 * `invoice_documents` — the record that a tax document is OWED, separate from whether it exists.
 *
 * The split is the same one `refund-owed.ts` makes and for the same reason: the obligation is
 * created by the code that causes it, at the moment it exists, and the settlement is written later
 * by whatever actually performs it. A row is `pending` from the instant an order is paid; it
 * becomes `issued` only when a provider hands back a document id.
 *
 * That ordering is what makes the current state honest rather than half-built. No provider is
 * chosen and no document is issued (`console-adapter.ts` explains why — it is a tax question, not
 * an integration one), so every row sits `pending`, the count of them is visible, and the day a
 * provider is wired the backlog is issuable rather than lost.
 *
 * Idempotency, as everywhere else on this surface, lives in the database: one buyer-facing invoice
 * per order, one platform invoice per seller per month. A duplicate tax document is worse than a
 * missing one — it cannot be deleted, only cancelled with a credit note.
 */

export type InvoiceDirection = 'seller_to_buyer' | 'platform_to_seller';
export type InvoiceKind = 'tax_invoice' | 'receipt' | 'tax_invoice_receipt' | 'credit_note';
export type InvoiceStatus = 'pending' | 'issued' | 'failed' | 'cancelled';

export interface InvoiceDocument {
  id: string;
  direction: InvoiceDirection;
  sellerId: string;
  orderId: string | null;
  periodKey: string | null;
  kind: InvoiceKind;
  amountAgorot: number;
  vatAgorot: number;
  status: InvoiceStatus;
  provider: string | null;
  providerDocId: string | null;
  documentUrl: string | null;
  allocationNumber: string | null;
  issuedAt: string | null;
  createdAt: string;
  detail: string;
}

interface DocRow {
  id: string;
  direction: InvoiceDirection;
  seller_id: string;
  order_id: string | null;
  period_key: string | null;
  kind: InvoiceKind;
  amount_agorot: string | number;
  vat_agorot: string | number;
  status: InvoiceStatus;
  provider: string | null;
  provider_doc_id: string | null;
  document_url: string | null;
  allocation_number: string | null;
  issued_at: Date | string | null;
  created_at: Date | string;
  detail: string;
}

const big = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const iso = (v: Date | string | null): string | null =>
  !v ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

function toDoc(row: DocRow): InvoiceDocument {
  return {
    id: row.id,
    direction: row.direction,
    sellerId: row.seller_id,
    orderId: row.order_id,
    periodKey: row.period_key,
    kind: row.kind,
    amountAgorot: big(row.amount_agorot),
    vatAgorot: big(row.vat_agorot),
    status: row.status,
    provider: row.provider,
    providerDocId: row.provider_doc_id,
    documentUrl: row.document_url,
    allocationNumber: row.allocation_number,
    issuedAt: iso(row.issued_at),
    createdAt: iso(row.created_at)!,
    detail: row.detail,
  };
}

/**
 * Record that a document is owed. Returns null when one already is — not an error.
 *
 * `ON CONFLICT DO NOTHING` against the two partial unique indexes, so a checkout replayed by an
 * idempotency key, or a payout run re-triggered, plans one document rather than two.
 */
export async function planDocument(input: {
  direction: InvoiceDirection;
  sellerId: string;
  orderId?: string | null;
  periodKey?: string | null;
  kind: InvoiceKind;
  amountAgorot: number;
  vatAgorot: number;
  detail?: string;
}): Promise<InvoiceDocument | null> {
  if (!isUuid(input.sellerId)) return null;
  if (!Number.isInteger(input.amountAgorot) || input.amountAgorot < 0) return null;

  // Two statements rather than one, because the two unique indexes are partial and a single
  // `ON CONFLICT` cannot name both — an order-scoped document and a period-scoped one collide on
  // different constraints. Naming the right one per direction keeps the conflict target explicit
  // instead of falling back to a bare `ON CONFLICT DO NOTHING`, which would silently swallow a
  // violation of any constraint including one added later.
  const conflict = input.orderId
    ? '(order_id, direction) WHERE order_id IS NOT NULL'
    : '(seller_id, period_key, direction) WHERE period_key IS NOT NULL';

  const created = await firstRow<DocRow>(
    `INSERT INTO invoice_documents
       (direction, seller_id, order_id, period_key, kind, amount_agorot, vat_agorot, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT ${conflict} DO NOTHING
     RETURNING *`,
    [
      input.direction, input.sellerId, input.orderId ?? null, input.periodKey ?? null,
      input.kind, input.amountAgorot, input.vatAgorot, input.detail ?? '',
    ],
  );
  return created ? toDoc(created) : null;
}

/** Mark a planned document as really issued, with whatever the provider returned. */
export async function markDocumentIssued(id: string, result: {
  provider: string;
  providerDocId?: string;
  documentUrl?: string;
  allocationNumber?: string;
}): Promise<InvoiceDocument | null> {
  if (!isUuid(id)) return null;
  const updated = await firstRow<DocRow>(
    `UPDATE invoice_documents
        SET status = 'issued', provider = $2, provider_doc_id = $3, document_url = $4,
            allocation_number = $5,
            issued_at = COALESCE(issued_at, now())
      WHERE id = $1
  RETURNING *`,
    [id, result.provider, result.providerDocId ?? null, result.documentUrl ?? null, result.allocationNumber ?? null],
  );
  return updated ? toDoc(updated) : null;
}

/** Record that issuing failed. The row STAYS pending-equivalent in meaning — a failed document is
 *  still owed — but the status distinguishes "nobody tried" from "it was tried and refused", which
 *  is the difference between a backlog and an incident. */
export async function markDocumentFailed(id: string, error: string): Promise<InvoiceDocument | null> {
  if (!isUuid(id)) return null;
  const updated = await firstRow<DocRow>(
    `UPDATE invoice_documents SET status = 'failed', detail = $2 WHERE id = $1 RETURNING *`,
    [id, error],
  );
  return updated ? toDoc(updated) : null;
}

export async function getDocumentsForSeller(sellerId: string, limit = 100): Promise<InvoiceDocument[]> {
  if (!isUuid(sellerId)) return [];
  const found = await rows<DocRow>(
    'SELECT * FROM invoice_documents WHERE seller_id = $1 ORDER BY created_at DESC LIMIT $2',
    [sellerId, limit],
  );
  return found.map(toDoc);
}

/** How many documents are owed and not issued — the number that says whether the invoicing seam is
 *  connected, and the backlog that will be issued on the day it is. */
export async function countPendingDocuments(): Promise<number> {
  const row = await firstRow<{ n: string | number }>(
    "SELECT count(*)::bigint AS n FROM invoice_documents WHERE status = 'pending'",
  );
  return big(row?.n);
}
