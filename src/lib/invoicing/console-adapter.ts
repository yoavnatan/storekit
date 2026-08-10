import type { InvoicingAdapter, InvoiceRequest, InvoiceResult } from './adapter.js';

/**
 * The no-op adapter: records what WOULD have been issued and issues nothing.
 *
 * This is the adapter in every environment today, and will stay so until the רו״ח answers whether
 * the platform may issue a document in a seller's name at all
 * (`docs/legal-brief-agent-model.md` §6.3–6.4). It is not a stub in the "unfinished" sense — it is
 * the correct behaviour for a system that knows a document is owed and does not yet know it is
 * allowed to create it.
 *
 * It reports `ok: true`, deliberately. The caller's job is to record that a document is owed and
 * move on; returning a failure here would fill the alerts surface with a condition that is not a
 * fault and that nobody can act on. The row stays `pending` in `invoice_documents` either way, and
 * `pending` is what the "documents still to issue" query counts — so nothing is lost and nothing
 * pretends to exist.
 */
export function createConsoleInvoicingAdapter(): InvoicingAdapter {
  return {
    name: 'console',
    async issue(request: InvoiceRequest): Promise<InvoiceResult> {
      // eslint-disable-next-line no-console
      console.info(
        `[invoicing:console] would issue ${request.kind} ref=${request.reference} ` +
          `from="${request.issuer.name}"${request.issuer.businessId ? ` (${request.issuer.businessId})` : ''} ` +
          `to="${request.recipient.name}" ` +
          `amount=${request.amountAgorot} vat=${request.vatAgorot} lines=${request.lines.length}`,
      );
      return { ok: true, provider: 'console' };
    },
  };
}
