/**
 * WHEN a buyer is asked how it was — two numbers, in a file that imports nothing.
 *
 * They live apart from the job that acts on them because a PAGE needs them too: the review screen
 * decides whether to offer "לא קיבלתי את ההזמנה" from the same fallback window the mail was sent
 * on, so the two agree by construction rather than by two numbers that happen to match. Importing
 * `review-invite-run.ts` for a constant would drag the job, the mailer and the returns layer into a
 * page's module graph — the same reason `reviews-anchor.ts` is its own file.
 *
 * ── Two clocks, and NEITHER of them is `updated_at` (corrected 2026-08-17, owner asked) ──
 * The first version waited five days from `updated_at`. That is the exact mistake migration 0023
 * had already written down for the payout hold, in the same table: `updated_at` is the last time
 * ANY field changed, so a seller fixing a tracking number a week later silently pushed the
 * invitation a week out, and a status corrected `delivered → shipped → delivered` restarted it.
 * A clock that can move is not a clock. Both columns these are measured against — `delivered_at`,
 * `paid_at` — are stamped ONCE and never cleared.
 *
 * They also answer two different questions, which is why there are two of them:
 *
 *   `delivered_at` — the buyer HAS it. Two days is long enough to have opened the box and used the
 *                    thing, short enough that the purchase is still what they were thinking about.
 *                    This is the good case and the one that should fire.
 *
 *   `paid_at`      — nobody ever marked it delivered. The seller is not obliged to touch that
 *                    dropdown and many will not, so without a fallback those buyers are never
 *                    asked at all. Ten days from PAYMENT (not from dispatch — there is no
 *                    `shipped_at` column, and inventing one to hold a guess would be worse; the two
 *                    differ by the day or two between paying and posting) is comfortably past an
 *                    Israeli courier's transit, and an order still sitting unshipped is excluded by
 *                    the status filter anyway. Same shape as `FALLBACK_DAYS_AFTER_PAYMENT` in
 *                    `payout-schedule.ts`, and for the same reason: a seller's silence must not
 *                    freeze something the buyer is owed.
 *
 * ⚠️ Both are judgement, not measurement, and the delivered one is the one worth revisiting against
 * the carrier's real transit times once one is connected (GO_LIVE §5). An invitation that arrives
 * too early is ignored once and the buyer is never asked again, so both err late.
 */

export const REVIEW_INVITE_DAYS_AFTER_DELIVERY = 2;
export const REVIEW_INVITE_FALLBACK_DAYS_AFTER_PAYMENT = 10;
