import { isDayISO } from './business-day.js';
import type { PaymeWithdrawal } from './payment-payme.js';

/**
 * **"How much money is coming to me, and when"** — the one question a seller opened PayMe to answer.
 *
 * ── Why this exists (owner, CURRENT_TASK סשן א׳ §1, 2026-08-25) ──
 * *"איפה המוכר בעצם רואה כמה כסף יועבר לו, אני רוצה שהוא בכלל לא יצטרך לצאת לפיימי כדי לעשות
 * פעולות."* Under the split model the buyer's money never touches us: PayMe capture each store's
 * share into that seller's own merchant account and credit his bank on their own schedule
 * (GO_LIVE §3.1.0). Everything the dashboard could say about it was therefore a sentence explaining
 * that the answer lives somewhere else — which is exactly the trip out to PayMe the owner does not
 * want anyone to make.
 *
 * ── This is PayMe's number, NOT ours, and the distinction is the whole point ──
 * `seller-balance.ts` says what a seller EARNED through the mall. It is derived from our orders and
 * it knows nothing about PayMe's clearing fee, their ₪50 monthly minimum, a chargeback, a ₪14.9
 * withdrawal fee, or a sale the seller took on his own terminal outside the platform. Printing that
 * accrual under the words "will be transferred to you" would be a promise we neither make nor
 * control. So the pending figure comes from `get-future-withdrawals` and the history from
 * `get-withdrawals`, and both are read straight through.
 *
 * ── Dates are SLICED, never parsed ──
 * PayMe answer `"2026-08-25 13:15:00"` in their own timezone. `new Date()` on that string reads it
 * as local time and `toISOString()` then shifts the DAY — the exact family of bug
 * `lib/business-day.ts` exists for. Their string already names the day in the calendar the transfer
 * happens in, so the first ten characters are the answer and nothing has to be converted.
 *
 * Pure: the transport is `payment-payme.ts`, so every rule below is testable without a network.
 */

/** A transfer PayMe already made to the seller's bank. */
export interface PastTransfer {
  /** `YYYY-MM-DD`, PayMe's own calendar day. */
  dayISO: string;
  amountAgorot: number;
  /** Their own words for it ("משיכה לבנק"). Empty when they sent none. */
  description: string;
}

/** A transfer PayMe have dated but not yet made. */
export interface NextTransfer {
  dayISO: string;
  amountAgorot: number;
}

export interface SellerTransfers {
  /** Everything PayMe are holding for this seller and have not yet moved — dated and undated
   *  alike. The single figure the screen leads with. */
  pendingAgorot: number;
  /** The nearest transfer that already has BOTH a date and money on it, or `null`.
   *
   *  Null is the common case and it is not a failure: the measurement (2026-08-25, sandbox) found
   *  six dated windows holding zero and one OPEN window (`end_time: -1`) holding the whole balance,
   *  because money accrues into the open bucket until PayMe close it. A screen must then say
   *  "at PayMe's next payment date" without inventing one — see `payTransferNextUnknown`. */
  next: NextTransfer | null;
  /** Newest first, as PayMe returned them. */
  past: PastTransfer[];
}

/** PayMe's `end_time: -1` — the window money is accruing into right now, which by definition has no
 *  payment date yet. Named because `-1` at a call site reads as an error code. */
const OPEN_WINDOW = -1;

/** `"2026-08-25 13:15:00"` → `"2026-08-25"`. Empty for anything that is not their shape, so a
 *  malformed row drops out of the dated set instead of becoming `Invalid Date` on a screen.
 *
 *  **`isDayISO` and not a shape regex here.** The first version tested the day SHAPE with its own
 *  regex and `tests/day-iso.test.ts` caught it, correctly: day-shaped is not a day, and
 *  `2026-02-30` would have gone through to `formatDayShort` and rendered as the 2nd of March under
 *  a heading saying the transfer is on the 30th of February. (That guard scans the file's TEXT, so
 *  it also went red when the pattern was only quoted in this comment — which is a fair rule: a
 *  reader copying it out of prose is exactly how the second definition gets written.) */
export function paymeDay(at: string): string {
  const day = at.slice(0, 10);
  return isDayISO(day) ? day : '';
}

/**
 * PayMe's two answers → the three things a seller reads.
 *
 * Zero-amount rows are dropped from `next` but still counted in `pendingAgorot` (where they add
 * nothing), because a dated window holding nothing is not a transfer anyone is waiting for and
 * naming it as "your next payment: ₪0" would be worse than saying nothing.
 */
export function summarizeTransfers(
  future: readonly PaymeWithdrawal[],
  past: readonly PaymeWithdrawal[],
): SellerTransfers {
  let pendingAgorot = 0;
  let next: NextTransfer | null = null;

  for (const row of future) {
    pendingAgorot += row.totalAgorot;
    if (row.totalAgorot <= 0) continue;
    if (row.windowEnd === OPEN_WINDOW) continue;   // no date to promise
    const dayISO = paymeDay(row.at);
    if (!dayISO) continue;
    if (!next || dayISO < next.dayISO) next = { dayISO, amountAgorot: row.totalAgorot };
  }

  return {
    pendingAgorot,
    next,
    past: past
      .map((row) => ({ dayISO: paymeDay(row.at), amountAgorot: row.totalAgorot, description: row.description ?? '' }))
      .filter((row) => !!row.dayISO),
  };
}
