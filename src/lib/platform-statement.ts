import type { LedgerAccrual } from './platform-accrual.js';
import type { PlatformRevenue } from './platform-revenue.js';

/**
 * **The month's closing statement — what a רו״ח is handed, as opposed to what a dashboard shows.**
 *
 * Owner, 2026-08-11: *"יש את מה שאנחנו מודדים לפי טווח מסוים ויש את העובדות בשטח — החודש יוצא כך
 * וכך כסף, זו ההכנסה שלי החודש, נגזרת מ: איקס ווי זד."* That is the difference between a
 * measurement and a closing, and the Performance tab is only ever the first: it answers "how much
 * did we sell in the last 30 days" and cannot answer "in August: what came in, what went out, what
 * of the balance is not mine, and where my income came from".
 *
 * ── One basis, ACCRUAL, since 2026-08-21 — and the cash half is gone rather than empty ──
 * The document used to have two sections. **Accrual** — what the period EARNED, dated by when the
 * sale happened — and **cash**, what actually moved out of our bank account to sellers, closing on
 * an opening/closing balance of money we were holding that was not ours.
 *
 * Under the split model there is no such balance and no such movement: the processor captures each
 * seller's share into that seller's own account at the moment of the charge, and our distribution
 * fee arrives from it monthly (GO_LIVE §3.1.0). A cash section here would have printed zeros under
 * headings that describe a business we are not running, which on a document handed to an accountant
 * is worse than a shorter document.
 *
 * What survives is the half that was always the answer to "how much did I make": sales in the
 * period, our commission on them, the subscriptions accrued beside it, and the seller's own share
 * stated so the gross figure can be read. `sellerEarnedAgorot` is no longer a bridge into anything
 * — it is context for the gross, and it never passes through us.
 *
 * ── Three things this deliberately does NOT do ──
 * **No ad-margin FIGURE — but the line is on the page** (revised 2026-08-12). It is one of the
 * platform's three income streams (`platform-revenue.ts`) and every ad number here today is a
 * deterministic MOCK: no Google or Meta account is connected (GO_LIVE §2). A document going to an
 * accountant may not carry an invented figure, and that has not changed. What did change is what
 * absence communicates: the owner read the table looking for campaign income and found no trace of
 * it, which says "forgotten" rather than "pending". So `adMarginAgorot` is `null` and prints as a
 * named line with no amount. It is deliberately not `0` — a zero is an assertion that nothing was
 * earned, which is a claim this document is in no position to make.
 *
 * **No VAT, and no invoice numbers.** Both are real obligations and both are owner-blocked on the
 * רו״ח (`docs/legal-brief-agent-model.md`, `invoice_documents` in migration 0023 — nothing issues
 * one yet). A statement that guessed a rate would be a document asserting a tax position nobody
 * has taken.
 *
 * **No snapshot.** Every figure is computed live from the orders as they are NOW, so
 * cancelling an old order restates the period it belonged to. That is correct — the numbers should
 * tell the truth about the world — and it means two printings of "August" can differ. The statement
 * carries its generation timestamp for that reason, and says so on its face.
 */

export interface StatementPeriod {
  /** Inclusive business days. */
  fromISO: string;
  toISO: string;
  /** 'YYYY-MM' when the period is exactly one calendar month, else null — what the title says. */
  monthKey: string | null;
}

/** Days in a month, from the key alone — string arithmetic, for the reason `payout-run.ts` gives:
 *  a `Date` built from a day key carries a timezone the question does not have. */
function daysInMonth(monthKey: string): number {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The first and last business day of a 'YYYY-MM'. */
export function monthPeriod(monthKey: string): StatementPeriod {
  return { fromISO: `${monthKey}-01`, toISO: `${monthKey}-${daysInMonth(monthKey)}`, monthKey };
}

/**
 * A free range as a period — and it still gets a `monthKey` when it happens to BE a whole month.
 *
 * That is not a nicety: a month is the only period whose opening and closing balances chain (July's
 * closing is August's opening), and the statement says so in its title. A range that covers exactly
 * one month is that month however it was asked for, so `?from=2026-08-01&to=2026-08-31` and
 * `?month=2026-08` must not produce two documents that describe the same period differently.
 */
export function statementPeriod(fromISO: string, toISO: string): StatementPeriod {
  const monthKey = fromISO.slice(0, 7);
  const isWholeMonth = fromISO === `${monthKey}-01` && toISO === `${monthKey}-${daysInMonth(monthKey)}`;
  return { fromISO, toISO, monthKey: isWholeMonth ? monthKey : null };
}

/** The `n` most recent month keys, newest first, ending with the one `todayISO` falls in — the
 *  month picker's options. Bounded so a picker cannot grow without limit as the platform ages. */
export function recentMonthKeys(todayISO: string, n: number): string[] {
  const keys: string[] = [];
  let year = Number(todayISO.slice(0, 4));
  let month = Number(todayISO.slice(5, 7));
  for (let i = 0; i < n; i++) {
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return keys;
}

export interface PlatformStatement {
  period: StatementPeriod;
  /** When it was computed. On the face of the document, because it is not a snapshot. */
  generatedAtISO: string;

  /** ── Accrual: what the period earned ── */
  grossAgorot: number;
  purchases: number;
  /** Our cut of those sales. */
  commissionAccruedAgorot: number;
  /** What the sellers earned on them: gross − commission. The bridge into the cash section. */
  sellerEarnedAgorot: number;
  subscriptionsAccruedAgorot: number;
  subscribers: number;
  /** The platform's margin on seller ad spend — the third income stream, and the ONLY figure on
   *  this document that can be absent. `null` means "not connected yet, so we are not stating a
   *  number", which the statement renders as a pending line rather than as 0: a zero is a claim
   *  that nothing was earned, and that is a different sentence from "we cannot say". The row exists
   *  either way (owner, 2026-08-12 — he went looking for it and found nothing, which reads as an
   *  income stream that was forgotten rather than one that is pending). */
  adMarginAgorot: number | null;
  /** commission + subscriptions + ad margin when there is one. A `null` margin adds nothing, so the
   *  total is exactly the sum of the lines printed above it in both states. */
  incomeAccruedAgorot: number;

  /**
   * ⚠️ There is no "what will come in" figure on this document, and its absence is deliberate.
   *
   * The owner asked for one (2026-08-12): *"ב-10 לחודש הקרוב זו העמלה שאני אקבל, הייתי מצפה שבדוח
   * יהיה כתוב מה ייכנס לי החודש"*. Under the custodial model it was answerable — our own payout run
   * knew exactly what it was about to deduct. Now the processor transfers our distribution fee on
   * the 20th for the previous month's TRANSACTIONS, and this document buckets by when the SALE
   * happened; the two windows do not coincide, so a figure derived here would be close enough to be
   * believed and wrong often enough to matter. It comes back when the adapter can read the real
   * figure from the processor, and not before.
   */
}

export interface StatementInput {
  period: StatementPeriod;
  generatedAtISO: string;
  /** Sales in the period. */
  accrued: LedgerAccrual;
  /** Subscription accrual for the period, from `platform-revenue.ts` so the pro-rata rule has one
   *  home. Its commission line is ignored here: that figure comes from `accrued`, the same query the
   *  balances use, so the document cannot hold two definitions of it. */
  revenue: Pick<PlatformRevenue, 'subscriptionsAgorot' | 'subscribers'>;
  /** The ad margin, or `null` while ad reporting is a mock — the caller decides, because it is the
   *  caller that knows whether the number it could pass came from a real account
   *  (`ad-metrics.ts#AD_METRICS_ARE_MOCK`). Absent is `null`, never `0`. */
  adMarginAgorot: number | null;
}

export function buildPlatformStatement(input: StatementInput): PlatformStatement {
  const { accrued, revenue, adMarginAgorot } = input;
  return {
    period: input.period,
    generatedAtISO: input.generatedAtISO,

    grossAgorot: accrued.grossAgorot,
    purchases: accrued.purchases,
    commissionAccruedAgorot: accrued.commissionAgorot,
    sellerEarnedAgorot: accrued.netAgorot,
    subscriptionsAccruedAgorot: revenue.subscriptionsAgorot,
    subscribers: revenue.subscribers,
    adMarginAgorot,
    incomeAccruedAgorot: accrued.commissionAgorot + revenue.subscriptionsAgorot + (adMarginAgorot ?? 0),
  };
}
