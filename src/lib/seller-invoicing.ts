import type { PaymeService } from './payment-payme.js';

/**
 * **"Let PayMe issue the buyer's invoice in my name" — the one add-on a seller may switch on.**
 *
 * ── The decision behind it (owner, 2026-08-25) ──
 * *"אני רוצה שהמוכר יוכל לבחור אם להפעיל את זה, ושזה יהיה בתשלום שלו."* The agreement already has
 * the shape: נספח ב׳ prices digital invoices at ₪15/month + ₪0.3/document with **no "גבייה מארנק
 * פרטנר" marker, which by GO_LIVE §3.1.0's own rule means the MERCHANT is billed**, and נספח א׳
 * would let us charge more and keep the difference. He chose to pass it through **at cost**.
 *
 * ── So no price is written in this repo, and that is the point of "at cost" ──
 * The figures come from `get-vas-seller`, per seller, live. A ₪15 typed here would be a second
 * source for a number PayMe own and may change under a 30-day notice (agreement §41) — and the
 * first month it drifted, our screen would be quoting a price the seller is not being charged, on
 * a service he agreed to because of that screen.
 *
 * ── Why the offer can be ABSENT, and why that is honest rather than broken ──
 * PayMe provision a service onto a merchant; nothing we can call creates one (sandbox notes §26 —
 * `vas-enable` activates what is already there, and there is no `vas-create`). Today none of our
 * merchants has an invoicing service at all, so `invoiceOffer` returns null and the card does not
 * render. The day PayMe provision it — as they have provisioned 3DSecure, which sits on every
 * merchant switched OFF — the card appears and works with no further code. A toggle that rendered
 * anyway would be a promise nothing can keep, which is the rule `GO_LIVE §3.0.2` states for the
 * subscription refund and the same one applies here.
 */

/**
 * The service types that ARE this feature, from PayMe's published VAS-types table (`Invoice` is 5,
 * `InvoicingService` is 25). Both, because their own list carries two and their sandbox uses the
 * type name rather than the number — matching one would silently miss an account provisioned with
 * the other, and the symptom is a seller who is simply never offered the feature.
 */
const INVOICE_TYPES = new Set(['invoice', 'invoicingservice']);

export interface InvoiceOffer {
  /** PayMe's id for the service, which is what `vas-enable`/`vas-disable` take. */
  serviceId: string;
  /** Is it on right now? */
  active: boolean;
  /** Recurring price, agorot — PayMe's own number, at cost. */
  monthlyAgorot: number;
  /** Price per document, agorot — theirs too. */
  perDocumentAgorot: number;
}

/**
 * The invoicing service on this merchant, or null when PayMe have not provisioned one.
 *
 * Pure, so every rule here is testable without a network — including the one that matters most,
 * which is that an account with no such service produces an ABSENCE rather than a disabled button.
 *
 * When more than one matches (PayMe's own list carries near-duplicates for other families — three
 * rows called `חשבון סליקה` sit on our merchants), an ACTIVE one wins over an inactive one: the
 * seller is being charged for that row, so it is the one a screen must show and the one a switch-off
 * must target. Otherwise the first, which is stable because their list comes back in a fixed order.
 */
export function invoiceOffer(services: readonly PaymeService[]): InvoiceOffer | null {
  const matches = services.filter((s) => INVOICE_TYPES.has(s.type.trim().toLowerCase()));
  if (!matches.length) return null;
  const chosen = matches.find((s) => s.active) ?? matches[0]!;
  return {
    serviceId: chosen.id,
    active: chosen.active,
    monthlyAgorot: chosen.periodicAgorot,
    perDocumentAgorot: chosen.usageAgorot,
  };
}
