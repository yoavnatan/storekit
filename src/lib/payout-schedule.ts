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
 * `FALLBACK_DAYS_AFTER_PAYMENT` and `MIN_PAYOUT_AGOROT` are NOT final. They are owner decisions
 * tied to the returns policy, which is itself still open (GO_LIVE §5) — and the hold and the return
 * window cannot be set independently: a hold shorter than the return window pays a seller for goods
 * the buyer may still send back, and the money is then gone. Same convention as the shipping prices
 * in `lib/shipping.ts`: a placeholder is named as one, in the code, so nobody later reads it as a
 * decision that was made.
 *
 * ── DECIDED 2026-08-16 (owner): weekly payouts, and the hold cut to the statutory floor ──
 * The two together, because they fix two halves of the same complaint and only one of them was
 * about risk. A seller who received their goods on the 1st waited 21 days of hold and then up to
 * another 19 for the 10th of the next month — **~40 days, of which only 21 protected anything.**
 * The rest was the calendar. Weekly payouts remove that half outright at no risk cost, and the hold
 * dropping 21 → 15 removes the week that never had a defence (see `HOLD_DAYS_AFTER_DELIVERY`, which
 * also records why the answer is 15 and not the 14 that was asked for). Worst case is now ~21 days
 * and the typical case ~15, which is where Amazon and Walmart sit.
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
 * **15 — the statutory window plus exactly one day (owner asked for 14, 2026-08-16).**
 *
 * It was 21, `STATUTORY_RETURN_DAYS` + a week, and the extra week is gone because **no argument for
 * it ever survived** — the two that were made are recorded below and both were withdrawn. A number
 * that protects against nothing costs a real seller a real week of cash flow, and cash flow is the
 * reason a small business does or does not sign up. Keeping it "just in case" was choosing a cost we
 * could name over a risk nobody could.
 *
 * **Why it is not the 14 that was asked for, which is a one-day correction and not a hedge.** The
 * release comparison is INCLUSIVE (`orderHold`: `releaseDayISO <= todayISO`, and the SQL twin says
 * the same) — so a hold of N releases the money ON delivery-day + N. At 14 that is the fourteenth
 * day, which is still a day the buyer may cancel: the platform would be paying the seller out on the
 * last morning the sale can legally travel backwards, and `refund-owed.ts` would open a debt against
 * someone who already has the money. 15 is the first day that is wholly outside the window. Cutting
 * the hold to the *shortest defensible* number was the decision; 14 was the shortest number that
 * SOUNDED right, and the two differ by the inclusivity of one comparison.
 *
 * This is a FLOOR, not a preference: it may never sit at or below `STATUTORY_RETURN_DAYS`, because
 * there the platform is paying out money for goods the buyer still has a statutory right to send
 * back. `tests/payout-schedule.test.ts` pins exactly that and nothing else.
 *
 * ── ⚠️ THIS NUMBER IS STILL A PROXY FOR A MECHANISM THAT DOES NOT EXIST (owner, 2026-08-11) ──
 * Read this before defending, shortening or lengthening it, because two wrong arguments were made
 * for it in one day and the owner corrected both.
 *
 * The first was "margin for the cancellation notice to reach us". The second — mine, after he
 * pointed out that a cancellation is conditional on the goods going back — was that we are
 * therefore never exposed. **Both are wrong, and his correction is the one to keep:**
 * *"זה שלקוח ביטל ביום ה-14 לא אומר שהוא באמת החזיר את המוצר, גם לא ביום ה-8."*
 *
 * A DECLARED cancellation and a RETURNED product are two events at two different times, and neither
 * is a fixed number of days from delivery. So a day counter cannot track the thing it is standing
 * in for. What it actually does today is bound the window in which a cancellation can still cost us
 * anything: pay out on day N and a cancellation declared on day N+1 is a `refund_due`
 * (`refund-owed.ts`) against a seller who already has the money, with no automatic way to collect.
 *
 * **The right instrument is a STATE, not a clock** — money held while a cancellation is open,
 * released when it resolves (goods back, or the window closed with none declared). That is the
 * returns mechanism, which is not built (CURRENT_TASK, "מנגנון החזרות וביטולים"), and until it is
 * there is nothing for a shorter hold to fall back on. Today no buyer can declare a cancellation at
 * all — only a seller or an admin cancels, from the orders tab — so this protects against nothing
 * that yet exists, and is sized for the world where it does.
 *
 * ⚠️ Owner decision, tied to the returns policy AND to that mechanism. It may not go BELOW the
 * statutory window whatever either says. `tests/payout-schedule.test.ts` pins that floor.
 *
 * **Cutting to 15 raised the stake on that mechanism rather than lowering it.** At 21 the extra week
 * was absorbing, by accident, some of the exposure a returns state machine is supposed to handle. At
 * 15 there is no slack left: the day a buyer can declare a cancellation in-product, the money must
 * be held by the OPEN CANCELLATION and not by the calendar, or a day-16 declaration meets a seller
 * who was paid on day 15. That is not a reason to go back to 21 — 21 would not have covered a day-22
 * declaration either — it is the reason the returns mechanism is the next thing on this surface.
 */
export const HOLD_DAYS_AFTER_DELIVERY = 15;

/**
 * The backstop for an order the seller never marked delivered.
 *
 * Without one, a seller who simply does not touch the status dropdown freezes their own money
 * forever and blames the platform.
 *
 * **30, and the reason it is not 21 is a correction.** It was justified as "longer than the
 * delivery hold, so reporting is always the faster path". That does not follow: with a hold of H
 * and a fallback of F, reporting wins only while delivery happens within F − H days. At an earlier
 * 14/21 pairing that was a 7-day window — deliver on day 12 and staying silent paid SOONER, which is
 * the exact incentive the fallback was supposed to remove. Against today's 15-day hold the margin is
 * 15 days, comfortably wider than any real delivery, and the real fix is still not a bigger number:
 * it is taking `delivered` from the courier's webhook instead of the seller's click (GO_LIVE §5),
 * after which the seller has nothing to withhold.
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

/**
 * The weekday the payout run goes out on, as `Date#getUTCDay` numbers it — 0 = Sunday.
 *
 * **Weekly, and Sunday, decided 2026-08-16.** Monthly was costing up to 19 days on top of a hold
 * that was already the only thing protecting anyone; see this module's header for the arithmetic.
 * Sunday because the Israeli business week opens on it, so a transfer initiated that morning lands
 * inside the same working week rather than against a weekend.
 *
 * **What this does NOT change is the money arithmetic, and that is why the switch is safe.** A
 * period key never bounded a sum: `getPayoutTotalsBySeller` sums a seller's payouts across ALL time
 * and uses the key for one thing only — "does a payout for this run already exist" — so shortening
 * the period cannot double-pay. Cutting the cadence would have been genuinely dangerous had that
 * subtraction been period-scoped, which is worth checking again before anyone shortens it further.
 */
export const PAYOUT_WEEKDAY = 0;

/**
 * Below this, a payout is not sent and the balance rolls into the next period.
 *
 * Not a fee and not forfeiture: nothing is deducted and nothing expires, the transfer simply waits
 * until it is worth making. A bank transfer has a real per-transfer cost and a 4₪ payout costs more
 * to send than it moves.
 *
 * **Weekly runs make this constant do more work, and that is on purpose.** A quarter of a month's
 * sales clears 100₪ less often, so a small seller now rolls over more weeks than they used to —
 * which is the correct behaviour, not a regression: they are never worse off than under a monthly
 * run (the same money arrives on the same date or sooner), and a seller busy enough to care is paid
 * every week. Raising the cadence and the minimum together would have handed back the gain.
 *
 * ⚠️ PLACEHOLDER — owner decision.
 */
export const MIN_PAYOUT_AGOROT = 10_000; // 100₪

/**
 * The payout weekday as a word, in the caller's language — `'יום ראשון'` / `'Sunday'`.
 *
 * Exists so the seller-facing copy and the terms of use can NAME the day without either of them
 * hard-coding it. This module's whole premise is that a number appearing in a legal clause and
 * separately in a scheduler will eventually disagree with itself; a weekday spelled out in two
 * translation files is the same defect wearing a different hat. Derived from `PAYOUT_WEEKDAY`
 * against a reference week (1970-01-04 was a Sunday), so changing the constant changes the copy.
 *
 * Pure and I/O-free like the rest of this module, so it is safe from a client bundle. Not for use
 * inside a loop — `Intl` construction is what took the admin dashboard from 700ms to 80ms when it
 * was moved out of one.
 */
export function payoutWeekdayName(locale: string): string {
  const reference = new Date(Date.UTC(1970, 0, 4 + PAYOUT_WEEKDAY));
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(reference);
}
