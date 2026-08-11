// Invoicing adapter contract — the single seam every invoicing provider plugs into.
//
// Same discipline as `lib/email/adapter.ts` and `lib/payment.ts`: the app depends on this
// interface, never on a provider's SDK, so choosing Green Invoice / Morning / iCount later is one
// new file and one branch in index.ts.
//
// ── The one thing that makes this harder than the email seam ──
// Two DIFFERENT documents go out, in opposite directions, and only one of them is ours to issue:
//
//   platform → seller   our tax invoice for commission + subscription + ad margin. Issued from our
//                       own books, under our own business number. Ordinary.
//   seller   → buyer    the tax invoice for the order. Under the agent model the SELLER is the one
//                       selling, so this document is theirs — we only produce it on their behalf.
//
// ⚠️ The second one is a tax question before it is an API question, and it is unanswered. A מספר
// הקצאה binds an invoice to the ISSUER's tax file — the seller's, not ours — so "issue in another
// business's name" needs both a provider that supports it and an authorisation from the seller that
// a רו״ח has to specify. `docs/legal-brief-agent-model.md` §6.3–6.4 are those questions verbatim.
//
// Until they are answered, `issue()` is never called with a real provider behind it: documents are
// PLANNED into `invoice_documents` as `pending` and the console adapter reports what it would have
// sent. That is deliberate, not unfinished — the alternative is issuing tax documents on a guess.

export interface InvoiceParty {
  name: string;
  /** ח.פ / מספר עוסק. Absent for a buyer, who is usually a private person. */
  businessId?: string;
  email?: string;
  address?: string;
}

export interface InvoiceLine {
  description: string;
  /** Integer agorot, VAT inclusive — the unit every amount in this codebase uses. */
  amountAgorot: number;
  quantity: number;
}

export interface InvoiceRequest {
  /** Who the document is FROM. Under the agent model this is the seller for a buyer-facing
   *  invoice, and the platform for our own — the field that makes the direction real rather than
   *  a label on a row. */
  issuer: InvoiceParty;
  recipient: InvoiceParty;
  kind: 'tax_invoice' | 'receipt' | 'tax_invoice_receipt' | 'credit_note';
  lines: InvoiceLine[];
  amountAgorot: number;
  vatAgorot: number;
  /** Our own id for the document, so a provider that de-duplicates sees the same key on a retry —
   *  the same role `idempotencyKey` plays at the payment seam. */
  reference: string;
  language: 'he' | 'en';
}

export interface InvoiceResult {
  ok: boolean;
  /** The provider's own document id, when issued. */
  providerDocId?: string;
  documentUrl?: string;
  /** מספר הקצאה, when the provider obtained one. */
  allocationNumber?: string;
  error?: string;
  /** Which adapter handled it — 'console' means no document actually exists. */
  provider: string;
}

export interface InvoicingAdapter {
  readonly name: string;
  /** Must never throw: a failure to issue a document must not fail the sale it documents. */
  issue(request: InvoiceRequest): Promise<InvoiceResult>;
}
