/**
 * WHEN a buyer is asked how it was — three numbers, in a file that imports nothing.
 *
 * They live apart from the job that acts on them because a PAGE reads them too: the review screen
 * decides whether to offer "לא קיבלתי את ההזמנה" from the same window the mail was sent on, so the
 * two agree by construction rather than by two numbers that happen to match. Importing
 * `review-invite-run.ts` for a constant would drag the job, the mailer and the returns layer into a
 * page's module graph — the same reason `reviews-anchor.ts` is its own file.
 *
 * ── Three clocks, in order of how much each one KNOWS ──
 *
 * The rule is the same every time: ask from the latest moment anybody actually confirmed something,
 * and never from a moment that can move. All three columns are stamped once on a first transition
 * and never cleared (`orders.ts#updateOrderIn`).
 *
 *   1. `delivered_at` + 2 days — **the buyer has it.** Long enough to have opened the box and used
 *      the thing, short enough that the purchase is still what they were thinking about. This is
 *      the good case and the one that should fire for almost every order.
 *
 *   2. `shipped_at` + 10 days — **the parcel left and nobody has confirmed it landed.** Ten days
 *      is comfortably past an Israeli courier's transit, so at this point the honest question is
 *      not "how was it" but "did it ever come" — which is why the review page shows the
 *      not-arrived door on exactly this condition (owner's own bar, 2026-08-17: a week and a half
 *      with nothing confirmed is strange, three days is not).
 *
 *   3. `paid_at` + 14 days — **the last resort, and it should almost never fire.** Only for orders
 *      with no dispatch stamp at all: a self-pickup order, which never passes through `shipped`,
 *      and rows written before migration 0036, which was deliberately not backfilled. Longer than
 *      the dispatch clock on purpose — it is measured from an earlier moment and knows less, so it
 *      has to be more patient.
 *
 * ── What the FIRST version got wrong, twice, and it is worth keeping both ──
 * It waited five days from `updated_at`: the last time ANY field changed, so a seller fixing a
 * tracking number a week later silently pushed the invitation a week out, and a status corrected
 * `delivered → shipped → delivered` restarted it. A clock that can move is not a clock — migration
 * 0023 had already written that down for the payout hold, in the same table.
 *
 * The second version measured the fallback from PAYMENT, which quietly charged the buyer's patience
 * for the seller's packing time: five legitimate days in `processing` — their right, and policed
 * separately by `SHIP_DEADLINE_BUSINESS_DAYS` — meant the mail went out two days into transit.
 * Dispatch is a fact the database was throwing away; migration 0036 keeps it.
 *
 * ⚠️ All three are judgement, not measurement. The delivered one is the one worth revisiting
 * against the carrier's real transit times once one is connected (GO_LIVE §5). An invitation that
 * arrives too early is ignored once and the buyer is never asked again, so all three err late.
 */

export const REVIEW_INVITE_DAYS_AFTER_DELIVERY = 2;
export const REVIEW_INVITE_DAYS_AFTER_DISPATCH = 10;
export const REVIEW_INVITE_FALLBACK_DAYS_AFTER_PAYMENT = 14;
