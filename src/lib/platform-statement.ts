import type { LedgerAccrual, LedgerMovement } from './payouts.js';
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
 * ── The two bases, side by side, because mixing them is the classic error (owner chose this) ──
 * **Accrual** (`accrued`) — what the period EARNED, dated by when the sale happened. An order sold
 * on the 31st is August's, even though its money is still in hold and will not be transferred until
 * October. This is the section that answers "how much did I make".
 * **Cash** (`movement`) — what actually MOVED, dated by when it moved. This is the section that
 * answers "how much left the bank account", and it is the one the balance sheet closes on.
 *
 * The bridge between them is a single figure, `accrued.netAgorot`, which appears in both: it is
 * what the sellers earned in the period (accrual) and it is the `+` line in the balance movement
 * (cash). Reading the gap between the two sections IS the answer to "how much of what I hold is not
 * mine" — which is the question that started this.
 *
 * ── The identity, and why the opening balance is computed the same way as the closing one ──
 *     closing = opening + accruedToSellers − paidOut + adjustments
 * It holds by construction rather than by luck, because `opening` is that same expression evaluated
 * over everything before the period. So a statement whose closing figure disagrees with the
 * platform ledger card (`platform-ledger.ts`) on the day it is run is a real defect and not a
 * rounding artefact — `reporting-invariants.test.ts` asserts exactly that.
 *
 * ── Three things this deliberately does NOT do ──
 * **No ad margin.** It is one of the platform's three income streams (`platform-revenue.ts`) and
 * every ad number on this platform today is a deterministic MOCK — no Google or Meta account is
 * connected (GO_LIVE §2). A document going to an accountant may not carry an invented figure, so
 * the line is absent and the statement says why. It arrives the day the connection does.
 *
 * **No VAT, and no invoice numbers.** Both are real obligations and both are owner-blocked on the
 * רו״ח (`docs/legal-brief-agent-model.md`, `invoice_documents` in migration 0023 — nothing issues
 * one yet). A statement that guessed a rate would be a document asserting a tax position nobody
 * has taken.
 *
 * **No snapshot.** Every figure is computed live from the orders and payouts as they are NOW, so
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
  /** commission + subscriptions. Ads excluded — see the header. */
  incomeAccruedAgorot: number;

  /** ── Cash: what moved ── */
  openingBalanceAgorot: number;
  paidOutAgorot: number;
  payouts: number;
  adjustmentsAgorot: number;
  closingBalanceAgorot: number;
  /** Commission those transfers took at source — income COLLECTED, against income EARNED above. */
  commissionSettledAgorot: number;
}

export interface StatementInput {
  period: StatementPeriod;
  generatedAtISO: string;
  /** Sales in the period. */
  accrued: LedgerAccrual;
  /** Transfers and adjustments in the period. */
  movement: LedgerMovement;
  /** Everything before the period, both halves — what the opening balance is computed from. */
  before: { accrued: LedgerAccrual; movement: LedgerMovement };
  /** Subscription accrual for the period, from `platform-revenue.ts` so the pro-rata rule has one
   *  home. Its commission and ad lines are ignored here: the commission comes from `accrued` (the
   *  same query the balances use) and the ad margin is deliberately absent. */
  revenue: Pick<PlatformRevenue, 'subscriptionsAgorot' | 'subscribers'>;
}

export function buildPlatformStatement(input: StatementInput): PlatformStatement {
  const { accrued, movement, before, revenue } = input;
  const openingBalanceAgorot = before.accrued.netAgorot - before.movement.paidOutAgorot + before.movement.adjustmentsAgorot;
  return {
    period: input.period,
    generatedAtISO: input.generatedAtISO,

    grossAgorot: accrued.grossAgorot,
    purchases: accrued.purchases,
    commissionAccruedAgorot: accrued.commissionAgorot,
    sellerEarnedAgorot: accrued.netAgorot,
    subscriptionsAccruedAgorot: revenue.subscriptionsAgorot,
    subscribers: revenue.subscribers,
    incomeAccruedAgorot: accrued.commissionAgorot + revenue.subscriptionsAgorot,

    openingBalanceAgorot,
    paidOutAgorot: movement.paidOutAgorot,
    payouts: movement.payouts,
    adjustmentsAgorot: movement.adjustmentsAgorot,
    // Written as the sum of the four lines ABOVE it, not recomputed from a fifth query. The reader
    // must be able to add up what is printed and land on the last row; a closing balance that came
    // from somewhere else would be right and unverifiable, which on this document is worse.
    closingBalanceAgorot: openingBalanceAgorot + accrued.netAgorot - movement.paidOutAgorot + movement.adjustmentsAgorot,
    commissionSettledAgorot: movement.commissionSettledAgorot,
  };
}
