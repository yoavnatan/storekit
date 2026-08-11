/**
 * The payout POLICY — four numbers, and the single place they are allowed to exist.
 *
 * Under the agent model (AI_INSTRUCTIONS → Payment architecture) the platform collects the buyer's
 * payment on the seller's behalf, deducts the commission at source, and owes the seller the rest.
 * These constants answer the only two questions that arrangement raises: **when does the money stop
 * being at risk**, and **when do we actually send it**.
 *
 * ── Why a module rather than four literals ──
 * Each of these numbers has to appear in at least three places that must agree: the hold rule
 * (`payout-hold.ts`), the seller-facing screen, and the terms of use. A number written into a legal
 * clause and separately into a scheduler is a number that will disagree with itself, and the version
 * a seller can point at is the one in the terms. So `terms.astro` interpolates these constants
 * instead of restating them, and `tests/payout-schedule.test.ts` pins that the terms page contains
 * no bare digit for a period.
 *
 * ── ⚠️ PLACEHOLDERS, and which ones ──
 * `HOLD_DAYS_AFTER_DELIVERY` and `FALLBACK_DAYS_AFTER_PAYMENT` are NOT final. They are owner
 * decisions tied to the returns policy, which is itself still open (CURRENT_TASK §ג.11) — and the
 * two cannot be set independently: a hold shorter than the return window pays a seller for goods the
 * buyer may still send back, and the money is then gone. Same convention as the shipping prices in
 * `lib/shipping.ts`: a placeholder is named as one, in the code, so nobody later reads it as a
 * decision that was made. `PAYOUT_DAY_OF_MONTH` and `MIN_PAYOUT_AGOROT` are proposals awaiting the
 * same conversation.
 */

/**
 * The buyer's statutory cancellation window — **not ours to choose.**
 *
 * Israeli consumer law gives a distance-sale buyer **14 days from RECEIVING the goods** to cancel
 * (חוק הגנת הצרכן §14ג + תקנות ביטול עסקה תשע"א-2010; checked 2026-08-10 against kolzchut.org.il,
 * not recalled). Everything else on this page is a policy we set; this one is the floor the policy
 * has to clear, which is why it is a constant of its own rather than a number inside the comment
 * below.
 *
 * **It is also the answer the SELLER asks for.** The owner read "ועוד 21 ימים אחריה" and asked
 * *"למה 21 מרגע המסירה ולא 15 למשל?"* — a fair question that a bare number cannot answer. The
 * payments tab's `#pay-how` block interpolates this alongside `HOLD_DAYS_AFTER_DELIVERY`, so the
 * seller reads the law and the margin rather than a figure they have to take on trust.
 */
export const STATUTORY_RETURN_DAYS = 14;

/**
 * How long a delivered order's money waits before it may be paid out.
 *
 * **21, and the number is derived rather than chosen** — `STATUTORY_RETURN_DAYS` + a week.
 *
 * ── What the extra week is actually for (corrected 2026-08-11 by the owner) ──
 * It was first written as margin "for the notice to reach us", and the owner cut through that:
 * *"אם הוא מבטל זה בתנאי שהוא החזיר את המוצר!"* — a cancellation is not a loss, the goods come
 * back. So the exposure is narrower and more specific than the first version claimed, and naming it
 * correctly is what stops the number being argued from the wrong premise:
 *
 *   The buyer may declare the cancellation on day 14. The parcel is then still in transit. A payout
 *   made on day 14 therefore leaves the platform CLAWING BACK from a seller who already has the
 *   money, while the goods are somewhere on a courier's van — which is `refund-owed.ts` writing a
 *   `refund_due` we have no automatic way to collect against.
 *
 * The margin buys the return journey, not the paperwork. That is also why it may not simply be
 * "14 + one day": one day does not get a parcel across the country.
 *
 * ⚠️ Still an owner decision, and still tied to the returns policy — but it may not go BELOW the
 * statutory window whatever that policy says. `tests/payout-schedule.test.ts` pins that floor.
 */
export const HOLD_DAYS_AFTER_DELIVERY = 21;

/**
 * The backstop for an order the seller never marked delivered.
 *
 * Without one, a seller who simply does not touch the status dropdown freezes their own money
 * forever and blames the platform.
 *
 * **30, and the reason it is not 21 is a correction.** It was justified as "longer than the
 * delivery hold, so reporting is always the faster path". That does not follow: with a hold of H
 * and a fallback of F, reporting wins only while delivery happens within F − H days. At 14 and 21
 * that was a 7-day window — deliver on day 12 and staying silent paid SOONER, which is the exact
 * incentive the fallback was supposed to remove. 30 against a 21-day hold restores a 9-day margin,
 * and the real fix is not a bigger number: it is taking `delivered` from the courier's webhook
 * instead of the seller's click (GO_LIVE §5), after which the seller has nothing to withhold.
 *
 * ⚠️ PLACEHOLDER — owner decision, but it must stay above `HOLD_DAYS_AFTER_DELIVERY`.
 */
export const FALLBACK_DAYS_AFTER_PAYMENT = 30;

/**
 * ── The fulfilment clock, which is a different question from the payout clock ──
 *
 * How long the seller has to do their part before the platform steps in. Deliberately NOT derived
 * from statute: the law requires a distance seller to DISCLOSE the supply date and method
 * (§14ג(א) and the written document), and — checked 2026-08-10 — sets no general maximum for it.
 * So these are a platform POLICY, which makes publishing them mandatory rather than optional:
 * an undisclosed supply time is the actual legal exposure, not a slow one.
 *
 * The deadline is on the milestone the seller CONTROLS, never on one that depends on a courier
 * turning up — `order-status-rules.ts`'s payout-clock columns already draw exactly that line.
 */

/** Business days from payment for the seller to reach their own milestone: `shipped` for a courier
 *  order, `ready` for self-pickup. ⚠️ PLACEHOLDER — owner. */
export const SHIP_DEADLINE_BUSINESS_DAYS = 2;

/** Calendar days from payment after which an unshipped order warns the seller (and the platform).
 *  ⚠️ PLACEHOLDER — owner. */
export const SHIP_WARNING_DAYS = 7;

/**
 * Calendar days from payment after which an order the seller never acted on is cancelled and the
 * buyer refunded.
 *
 * This exists because without it the money simply stays with the platform forever: the payout gate
 * correctly refuses to pay a seller who never shipped, and nothing was giving it back. Cancelling
 * for non-supply is also the case where the law allows the business NO cancellation fee and puts
 * collection on the seller — so there is nothing to deduct here, the buyer is made whole.
 *
 * ⚠️ PLACEHOLDER — owner.
 */
export const SHIP_AUTO_CANCEL_DAYS = 14;

export const PAYOUT_DAY_OF_MONTH = 10;

/**
 * Below this, a payout is not sent and the balance rolls into the next period.
 *
 * Not a fee and not forfeiture: nothing is deducted and nothing expires, the transfer simply waits
 * until it is worth making. A bank transfer has a real per-transfer cost and a 4₪ payout costs more
 * to send than it moves.
 *
 * ⚠️ PLACEHOLDER — owner decision.
 */
export const MIN_PAYOUT_AGOROT = 10_000; // 100₪
