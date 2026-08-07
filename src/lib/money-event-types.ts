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
 */
export const MONEY_EVENT_TYPES = [
  'payment_attempted',
  'order_created',
  'charge_voided',
  'duplicate_checkout_blocked',
  'payment_status_changed',
  'shipping_status_changed',
  'order_discount_changed',
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
};

/** Type guard for a request-supplied value (`?mtype=`). */
export function isMoneyEventType(value: string): value is MoneyEventType {
  return (MONEY_EVENT_TYPES as readonly string[]).includes(value);
}
