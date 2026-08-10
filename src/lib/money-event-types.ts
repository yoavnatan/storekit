/**
 * The money journal's VOCABULARY, and nothing else — no database, no SQL, no URL parsing.
 *
 * Split out of `money-events.ts` when the free-text search moved into the query: the SQL builder
 * (`moneylog-search.ts`) has to resolve a Hebrew label to a `type`, and `money-events.ts` has to
 * use that builder, so leaving the labels there made the two modules import each other. A cycle
 * that happens to evaluate is still a cycle, and the fix is the ordinary one — the thing they BOTH
 * depend on becomes its own module.
 *
 * `money-events.ts` re-exports everything here, so every existing importer is unaffected.
 */

/**
 * The vocabulary, as a value rather than a bare union — a reader validating a
 * user-supplied type (the admin journal's filter) must check it against the set of
 * types that EXIST, never against the types that happen to appear in the rows it
 * just loaded. Doing the latter silently turns "show me only the blocked double
 * charges" into "show me everything" on any journal that has none yet, which is a
 * filter that lies rather than one that comes back empty.
 *
 *   payment_attempted          — a charge was attempted at the payment provider.
 *   order_created              — an order row was created off a successful charge.
 *   duplicate_checkout_blocked — a repeat submit of an already-completed checkout was
 *                                served from the ledger instead of charged again
 *                                (checkout-idempotency.ts). Their absence proves
 *                                nothing; their PRESENCE proves a double charge was
 *                                caught, which is what's worth being able to show.
 *   payment_status_changed     — paymentStatus moved (pending → paid → failed…).
 *   shipping_status_changed    — shippingStatus moved, including the cancellation that
 *                                takes an order out of every revenue sum while leaving
 *                                paymentStatus at 'paid'.
 *   order_discount_changed     — a seller applied/changed a discount on their slice.
 *   charge_voided              — a charge SUCCEEDED and the purchase behind it then failed, so
 *                                the money was given back (payment.ts#voidCharge). The most
 *                                important row in this journal when it exists: it is the only
 *                                trace that a buyer's card was touched for an order that does
 *                                not exist. A row whose detail says the void FAILED is money
 *                                owed back to a real person, and it pages someone.
 *   refund_due                 — money was CAPTURED and the purchase was then undone (a seller
 *                                cancelled a paid order). The buyer is owed this amount and has
 *                                not been given it. Before this existed the only trace was a
 *                                `shipping_status_changed` reading 'cancelled', which is a
 *                                fulfilment fact: the order left every revenue sum and the seller
 *                                stopped owing a parcel, while the money simply stayed with us and
 *                                no screen anywhere said so. `refund-owed.ts` owns when it is
 *                                written; `reconcile.ts` reports every one still outstanding.
 *   refund_settled             — the money actually went back. Pairs off a `refund_due`.
 *                                **Nothing writes this yet, and that is the honest state**: it
 *                                needs the payment provider's refund call, and no provider is
 *                                chosen (GO_LIVE_CHECKLIST §3). Its absence is what keeps every
 *                                obligation visible instead of quietly closing itself.
 *
 * The four below arrived with the agent model (2026-08-10), where the platform holds the seller's
 * money and later sends it. That direction — money leaving US, to a seller — had no vocabulary at
 * all before, because under the sub-merchant model it never happened: the processor paid sellers
 * directly and there was nothing for this journal to witness. A journal that records every shekel
 * arriving and none leaving cannot be reconciled, which is the one thing it exists for.
 *
 *   payout_created             — a payout row was created for a seller and a period. NO money has
 *                                moved yet; this is the obligation being named, the same split
 *                                `refund_due`/`refund_settled` makes.
 *   payout_sent                — the transfer was handed to the bank, or confirmed after it.
 *   payout_failed              — the bank rejected it. The amount returns to payable (the row is
 *                                kept and excluded from `paidOut`), so this is not a dead end —
 *                                it is a seller who has not been paid and does not know why.
 *   seller_debited             — a chargeback, a post-payout refund clawback or a correction moved
 *                                against a seller's balance. The counterpart to `refund_due`: that
 *                                one says the BUYER is owed, this one says who it comes out of.
 */
export const MONEY_EVENT_TYPES = [
  'payment_attempted',
  'order_created',
  'charge_voided',
  'duplicate_checkout_blocked',
  'payment_status_changed',
  'shipping_status_changed',
  'order_discount_changed',
  'refund_due',
  'refund_settled',
  'payout_created',
  'payout_sent',
  'payout_failed',
  'seller_debited',
] as const;

export type MoneyEventType = (typeof MONEY_EVENT_TYPES)[number];

/**
 * The Hebrew name of each type, next to the vocabulary rather than in the panel that
 * renders it — because the admin's free-text search matches these labels too
 * (admin-moneylog-filter.ts). An owner who types "ביטול" is searching for the word he
 * is looking at on screen; if the label lived only in the component, the filter would
 * have had to keep a second copy of it, and the day they drifted the search would
 * quietly stop finding the rows whose chip still said the old word.
 * The panel keeps only the TONE (presentational) beside these.
 */
export const MONEY_EVENT_LABELS: Record<MoneyEventType, string> = {
  payment_attempted: 'ניסיון חיוב',
  order_created: 'הזמנה נוצרה',
  charge_voided: 'חיוב בוטל',
  duplicate_checkout_blocked: 'חיוב כפול נמנע',
  payment_status_changed: 'סטטוס תשלום השתנה',
  shipping_status_changed: 'סטטוס משלוח השתנה',
  order_discount_changed: 'סכום הזמנה שונה',
  refund_due: 'זיכוי מגיע לקונה',
  refund_settled: 'זיכוי בוצע',
  payout_created: 'תשלום למוכר נוצר',
  payout_sent: 'תשלום למוכר בוצע',
  payout_failed: 'תשלום למוכר נכשל',
  seller_debited: 'חיוב למוכר',
};

/** Type guard for a request-supplied value (`?mtype=`). */
export function isMoneyEventType(value: string): value is MoneyEventType {
  return (MONEY_EVENT_TYPES as readonly string[]).includes(value);
}
