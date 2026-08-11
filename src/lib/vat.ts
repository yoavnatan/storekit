/**
 * VAT, and the two things about it that are easy to get wrong here.
 *
 * ── 1. Prices in this app are VAT-INCLUSIVE ──
 * Israeli consumer prices are quoted including VAT, and every price in this codebase is what the
 * buyer pays. So VAT is EXTRACTED from a gross amount, never added to it. Adding it would inflate
 * every invoice by the rate and the storefront price would stop matching the document — which is
 * also a Merchant Center price-mismatch (one of only two documented suspension classes, and we run
 * one Merchant Center for every seller).
 *
 * ── 2. The rate is a fact about a DATE, not a constant ──
 * It changes by legislation, and a document must carry the rate that applied when it was issued.
 * That is why `invoice_documents.vat_agorot` is stored rather than recomputed from this constant on
 * read: recomputing would restate last year's invoices at this year's rate, silently, on a screen
 * somebody is reconciling against their books.
 *
 * ⚠️ **The number below is NOT verified and must be confirmed by the רו״ח before a single document
 * is issued.** It is written from general knowledge that the Israeli rate moved to 18% on
 * 2025-01-01; nobody on this project has checked it against רשות המסים, and I am not recording a
 * check that did not happen. It is one of the questions in `docs/legal-brief-agent-model.md`.
 * Nothing issues a real document yet (`invoicing/console-adapter.ts`), so the value is currently
 * unused in anger — which is exactly the window in which to confirm it.
 */

/** ⚠️ Unverified — see the header. Percent, not a fraction. */
export const VAT_PERCENT = 18;

/**
 * The VAT contained in a gross, VAT-inclusive amount.
 *
 * `gross − round(gross / (1 + rate))` rather than `round(gross × rate / (1 + rate))`: the two differ
 * by an agora on some inputs, and this spelling guarantees that **net + vat === gross exactly**,
 * which is the property an invoice has to have. A document whose lines do not add up to its total
 * is rejected by a bookkeeper before it is rejected by anything automated.
 */
export function vatWithinAgorot(grossAgorot: number, vatPercent: number = VAT_PERCENT): number {
  if (!Number.isFinite(grossAgorot) || grossAgorot <= 0) return 0;
  if (!Number.isFinite(vatPercent) || vatPercent <= 0) return 0;
  return grossAgorot - Math.round(grossAgorot / (1 + vatPercent / 100));
}

/**
 * Does this seller charge VAT at all?
 *
 * An **עוסק פטור** does not, and their invoice to the buyer must show none. Getting this wrong is
 * not a rounding difference — it is a document that misstates a business's tax status, issued in
 * that business's name, by us. Absent `businessType` answers "no" for the same reason: we do not
 * know, and charging VAT on a guess is the worse of the two errors.
 */
export function chargesVat(businessType: string | undefined | null): boolean {
  return businessType === 'licensed' || businessType === 'company';
}
