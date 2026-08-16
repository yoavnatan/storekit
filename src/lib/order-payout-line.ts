import { businessTodayISO } from './business-day.js';
import { orderHold, type HoldableOrder, type HoldState } from './payout-hold.js';
import { HOLD_DAYS_AFTER_DELIVERY, FALLBACK_DAYS_AFTER_PAYMENT, nextPayoutDayISO } from './payout-schedule.js';

/**
 * One order's payout status, as a screen has to say it: **when, why, and whether it is on you.**
 *
 * ── Why this exists at all (owner, סשן א׳ §4) ──
 * The payments tab used to answer this with a table of orders — id, store, amount, release date,
 * reason, action — sitting one tab away from the Orders tab, which is a table of orders. The owner
 * read it as a second order-management screen and asked for the critical half to move to where
 * orders are actually managed: *"אין סיבה ליצור עוד לשונית של ניהול הזמנות"*. So the payments tab
 * now answers "how much, and how soon" in three grouped lines, and the per-order sentence lives on
 * the order's own card.
 *
 * ── Why it is a descriptor and not a string ──
 * The order card has THREE renderers — the `.astro` one, `buildOrderCard` in
 * `scripts/dashboard/orders.ts`, and the post-save patch — and two of them run in the browser. A
 * function returning Hebrew would put copy in a module that cannot see `getT`, which is the
 * `project_client_renderer_i18n_drift` class exactly: two copies of one sentence, one of which
 * stops matching. So this returns translation KEYS and the numbers to interpolate into them, and
 * each renderer looks them up the way it already looks up every other string.
 *
 * ── Why the day counts come back as data ──
 * `HOLD_DAYS_AFTER_DELIVERY` and `FALLBACK_DAYS_AFTER_PAYMENT` are still owner decisions
 * (`payout-schedule.ts` says so, and `terms.astro` interpolates the same constants). A sentence
 * with "14" written into it is a promise that survives the day the number changes.
 *
 * Nothing here decides anything: `orderHold` is the rule, and this is a presentation projection of
 * it. That matters because the same `orderHold` decides what the payout run actually pays, so an
 * order card and a bank transfer cannot come to different conclusions about the same order.
 */

/** Keys into the `dashboard` translation table. Listed as unions so a typo is a compile error
 *  rather than an empty cell on a money screen. */
export type PayoutWhyKey = 'payWhyDelivery' | 'payWhyPayment' | 'payWhyUnshipped' | 'payWhyReturnOpen' | 'payWhyUnknown';
export type PayoutActionKey = 'payActionNone' | 'payActionMarkDelivered' | 'payActionShip';

export interface OrderPayoutLine {
  state: HoldState;
  /** Business day the money is released. Null when there is no date to show — either nothing is
   *  coming (`not_payable`) or the thing the date depends on has not happened (`unshipped`). */
  releaseDayISO: string | null;
  /**
   * Business day the money actually LEAVES — the payout run that `releaseDayISO` catches, and the
   * only one of the two dates a seller has any use for.
   *
   * ── Why the screen shows this and not the release day (owner, 2026-08-16) ──
   * It used to show the release day, worded "ישולם אחרי {date}", and he asked what "אחרי" meant.
   * Nothing good: a hold ends on a Tuesday and the transfer goes out on the following Sunday, so the
   * date on the card was a day on which, by design, nothing happened to the seller's money. The
   * vaguer word was carrying the five-day gap. Naming the run's own day closes it.
   *
   * **It is an ESTIMATE and the copy says so ("צפוי").** Two things can still move it, both of them
   * honest: a balance under `MIN_PAYOUT_AGOROT` rolls into the next run, and a חג falling on the
   * payout weekday moves the transfer to the next banking day (`nextPayoutDayISO`'s header — that
   * one is not implemented, and cannot be until there is a bank). A screen that promised the date
   * would be wrong for the small seller every time.
   *
   * Null exactly where `releaseDayISO` is null AND the money is not already released: no clock has
   * started, so no run can be named.
   */
  payoutDayISO: string | null;
  basis: 'delivery' | 'payment' | 'unshipped' | 'return_open' | null;
  whyKey: PayoutWhyKey;
  /** The `{n}` inside `whyKey`'s sentence, or null when it has no `{n}`. */
  whyDays: number | null;
  actionKey: PayoutActionKey;
  /**
   * The seller is holding up their OWN money — no clock runs until they ship.
   *
   * Read by the payments tab, where it colours the one row that can be acted on and turns its
   * action into a link. **Not read by the order CARD any more** (owner, 2026-08-11): a bare
   * "שליחת הזמנה" sat in the payment line with no heading and nothing to click, next to the
   * shipping-status control that actually does it. A label that names an action it cannot perform,
   * beside the thing that performs it, is one word too many.
   */
  blocking: boolean;
}

const WHY_BY_BASIS: Record<string, { key: PayoutWhyKey; days: number | null }> = {
  delivery:  { key: 'payWhyDelivery',  days: HOLD_DAYS_AFTER_DELIVERY },
  payment:   { key: 'payWhyPayment',   days: FALLBACK_DAYS_AFTER_PAYMENT },
  unshipped: { key: 'payWhyUnshipped', days: null },
  // A case is open on this order, so the money stays with the platform until it closes (decisions
  // §4). No days: the date depends on something that has not happened yet.
  return_open: { key: 'payWhyReturnOpen', days: null },
};

const ACTION_BY_BASIS: Record<string, PayoutActionKey> = {
  delivery:  'payActionNone',
  payment:   'payActionMarkDelivered',
  unshipped: 'payActionShip',
  // Nothing for the seller to DO — the case is with the buyer, the carrier or the admin.
  return_open: 'payActionNone',
};

/** The basis whose action changes an OUTCOME rather than a date. */
const BLOCKING_BASIS = 'unshipped';

export function orderPayoutLine(order: HoldableOrder, todayISO: string = businessTodayISO()): OrderPayoutLine {
  const hold = orderHold(order, todayISO);
  // `basis: null` is an anomaly, not a state — `payout-hold.ts` uses it for an order it could not
  // date at all. It gets "we are looking into this order" rather than a fabricated reason, and no
  // action, because there is none the seller could take.
  const why = WHY_BY_BASIS[hold.basis ?? ''] ?? { key: 'payWhyUnknown' as PayoutWhyKey, days: null };
  // Released money catches the run that today's date reaches, not the one its own release day did:
  // that run may already have gone out (below the minimum, or no bank details on file), and the
  // seller's question is which run is next, never which one it missed.
  const payoutFrom = hold.state === 'releasable' ? todayISO : hold.releaseDayISO;
  return {
    state: hold.state,
    releaseDayISO: hold.releaseDayISO,
    payoutDayISO: payoutFrom ? nextPayoutDayISO(payoutFrom) : null,
    basis: hold.basis,
    whyKey: why.key,
    whyDays: why.days,
    actionKey: ACTION_BY_BASIS[hold.basis ?? ''] ?? 'payActionNone',
    blocking: hold.state === 'held' && hold.basis === BLOCKING_BASIS,
  };
}

/**
 * The two halves of the sentence a card prints, as translation KEYS — a bold answer to *when*, and
 * a muted answer to *why then*.
 *
 * ── Why this is a function and not a ternary in each card (2026-08-16) ──
 * It was a ternary in each card: the `.astro` one, `buildOrderCard`'s, and the admin panel's, three
 * copies of the same four-branch decision. They had already drifted — the admin's read
 * `state === 'releasable'` where the others also had a date to show — and the branch that matters
 * most is the one nobody writes twice the same way: an order `payout-hold.ts` could not date at all
 * (`basis: null`) is `held`, so a card keyed on the state alone reaches for a date that is null and
 * prints "צפוי ב" followed by nothing, on a money screen.
 *
 * ── Why the words are the FILTER's words ──
 * `payFilter_*` are the five options in the Orders toolbar's payment-status filter, and the card now
 * renders those exact strings. The seller filters by "בדרך ללקוח" and reads "בדרך ללקוח" on every
 * row that comes back. They were two vocabularies for one set of states until now (the card said
 * "טרם נמסר" where the filter said "בדרך ללקוח"), which is a drift that cannot be tested for —
 * sharing the key is what ends it.
 */
export type PayoutTextMainKey = 'payFilter_none' | 'payFilter_unshipped' | 'payWhyUnknown' | 'orderPayoutExpected';
export type PayoutTextWhyKey = 'orderPayoutUnshippedHint' | 'payFilter_undelivered' | 'payFilter_window' | 'payFilter_released';

export interface PayoutLineText {
  mainKey: PayoutTextMainKey;
  /** The business day to interpolate into `{date}`. Non-null exactly when `mainKey` carries one. */
  dateISO: string | null;
  /** The muted half, or null where the answer stands alone and a second clause would only repeat it
   *  ("לא ישולם — ההזמנה בוטלה" needs no reason beside it). */
  whyKey: PayoutTextWhyKey | null;
}

export function payoutLineText(line: OrderPayoutLine): PayoutLineText {
  if (line.state === 'not_payable') return { mainKey: 'payFilter_none', dateISO: null, whyKey: null };
  if (line.basis === 'unshipped') return { mainKey: 'payFilter_unshipped', dateISO: null, whyKey: 'orderPayoutUnshippedHint' };
  // Held, and undateable — the `basis: null` anomaly. It says so instead of naming a run, because
  // the only honest answer here is that a person is looking at it.
  if (!line.payoutDayISO) return { mainKey: 'payWhyUnknown', dateISO: null, whyKey: null };
  const filterValue = payoutFilterValue(line);
  return {
    mainKey: 'orderPayoutExpected',
    dateISO: line.payoutDayISO,
    whyKey: filterValue === 'released' ? 'payFilter_released'
      : filterValue === 'undelivered' ? 'payFilter_undelivered'
      : 'payFilter_window',
  };
}

/** `payWhy*` sentences carry a `{n}`; the rest do not. One helper so three renderers cannot each
 *  forget the replace on a different one. */
export function payoutWhyText(line: OrderPayoutLine, template: string): string {
  return line.whyDays === null ? template : template.replace('{n}', String(line.whyDays));
}

/**
 * One order's payout status as a FILTER value — the seller's Orders tab filters by it directly.
 *
 * It replaced a deep link that faked the same thing by naming shipping statuses
 * (`?ostatus=pending,processing`), which was the owner's objection on 2026-08-11: *"צריך פשוט עוד
 * רובריקה בסינון לפי סטטוס תשלום"*. He was right, and the reason is not only tidiness — the
 * shipping list was a RESTATEMENT of the hold rule in a second place, so a status whose payout
 * behaviour changed in `order-status-rules.ts` would have gone on being filtered the old way here.
 * Filtering on the answer instead of on its inputs cannot drift.
 *
 * Five values, and they are the five things a seller can be looking for: money waiting on them,
 * money waiting on a delivery mark, money running down a return window, money released, and money
 * that is never coming.
 */
export const PAYOUT_FILTER_VALUES = ['unshipped', 'undelivered', 'window', 'released', 'none'] as const;
export type PayoutFilterValue = (typeof PAYOUT_FILTER_VALUES)[number];

export function payoutFilterValue(line: OrderPayoutLine): PayoutFilterValue {
  if (line.state === 'not_payable') return 'none';
  if (line.state === 'releasable') return 'released';
  if (line.basis === 'unshipped') return 'unshipped';
  if (line.basis === 'payment') return 'undelivered';
  return 'window';
}

/** The hold reasons that can be grouped, in the order the seller's screen shows them: the two they
 *  cannot influence first, their own last, because that is the one the eye should stop on. */
// 'return_open' sits last on purpose: it is the rarest, and the two ordinary clocks are what a
// seller is looking for when they open this tab.
export const HELD_BASES: readonly ('delivery' | 'payment' | 'unshipped' | 'return_open')[] = ['delivery', 'payment', 'unshipped', 'return_open'];

export interface HeldGroup {
  basis: 'delivery' | 'payment' | 'unshipped' | 'return_open';
  /** How many of the seller's order slices are waiting for this reason. */
  orders: number;
  /** Their share, commission already off — the same figure `heldAgorot` is the total of. */
  agorot: number;
}

/** One slice as the grouping needs it. A projection rather than `AccountSliceView`, so this module
 *  does not have to import `seller-account.ts` and a test can build a case from two literals. */
export interface HeldSlice {
  hold: { state: string; basis: 'delivery' | 'payment' | 'unshipped' | 'return_open' | null };
  netOfCommissionAgorot: number;
  /** Which shop this slice was bought from. A payout pools every store the seller owns, but the
   *  ORDERS behind it are managed one store at a time, so the split has to be able to say which. */
  storeSlug: string;
}

export interface HeldSplit {
  /** Non-empty groups only, in `HELD_BASES` order. An always-present "0 orders not yet shipped"
   *  row teaches a seller to expect a column that is almost always zero. */
  groups: HeldGroup[];
  /** Slices `payout-hold.ts` could not attribute to any reason (`basis: null`) — an anomaly, not a
   *  state. Reported separately rather than dropped: money the seller is owed that no group
   *  explains is precisely what must not vanish for failing to fit a bucket. */
  unknownOrders: number;
  unknownAgorot: number;
}

/**
 * Split what is on hold by WHY it is on hold — the whole content of the payments tab's middle
 * section since the per-order table moved to the Orders tab.
 *
 * **Here and not in the `.astro` file**, and that is the rule rather than tidiness: these are
 * seller-visible money figures, so they need an invariant
 * (`tests/reporting-invariants.test.ts` — the groups plus the unknowns must add up to
 * `heldAgorot`, exactly), and a test cannot reach arithmetic that lives inside a component.
 *
 * Takes the slices already filtered to `state === 'held'`? No — it filters them itself, so the
 * caller cannot pass a set the total was not computed over. That is the specific way this number
 * would go wrong: a panel that filters once for the table and once for the tile.
 *
 * `onlyStoreSlug` narrows it to one shop. **The money stays account-wide and only the WORK is per
 * store** — a payout is one transfer covering every store the seller owns, so a per-store payable
 * figure would be a number no bank transfer ever matches. What IS per store is the list of orders
 * holding money up, because orders are managed one store at a time: the seller's Orders tab shows
 * a single shop, so a link out of a row that pooled three of them could only ever land on one of
 * them and silently drop the rest (owner, 2026-08-11). Splitting the rows is what makes the link
 * honest. `splitHeldByBasis(slices)` with no slug is still the whole account, and the two agree by
 * construction — which is what `reporting-invariants.test.ts` asserts.
 */
export function splitHeldByBasis(slices: readonly HeldSlice[], onlyStoreSlug?: string): HeldSplit {
  const held = slices.filter((s) => s.hold.state === 'held'
    && (onlyStoreSlug === undefined || s.storeSlug === onlyStoreSlug));
  const groups: HeldGroup[] = [];
  for (const basis of HELD_BASES) {
    const rows = held.filter((s) => s.hold.basis === basis);
    if (rows.length === 0) continue;
    groups.push({
      basis,
      orders: rows.length,
      agorot: rows.reduce((total, s) => total + s.netOfCommissionAgorot, 0),
    });
  }
  const unknown = held.filter((s) => !s.hold.basis || !HELD_BASES.includes(s.hold.basis));
  return {
    groups,
    unknownOrders: unknown.length,
    unknownAgorot: unknown.reduce((total, s) => total + s.netOfCommissionAgorot, 0),
  };
}

/**
 * One shop's share of what has come OUT of hold — its contribution to the next transfer.
 *
 * **Not the same thing as the transfer, and the difference is why this is its own function.** The
 * payout is `releasable − paidOut + adjustments` across the whole account, and neither of those
 * last two can be attributed to a shop: a bank transfer covers every store the seller owns, and a
 * chargeback lands on the account. So the honest per-store figure is the part that IS the store's —
 * what its own orders have released — and the screen shows the real transfer separately when the
 * seller has more than one shop (owner, 2026-08-11: *"זה לא רלוונטי מכל החנויות, רק החנות שהוא
 * עליה"*).
 *
 * For a single-store seller the two are the same number until a payout or an adjustment exists, and
 * `PayoutsPanel` shows the account figure there rather than this one — a seller with one shop has
 * no per-store question to ask.
 */
export function releasedForStore(slices: readonly HeldSlice[], storeSlug: string): number {
  let total = 0;
  for (const s of slices) {
    if (s.hold.state === 'releasable' && s.storeSlug === storeSlug) total += s.netOfCommissionAgorot;
  }
  return total;
}

/**
 * The "תשלום קרוב" figure a screen should print while the seller is standing in ONE shop.
 *
 * ── Why it is a function and not two lines in a component (2026-08-11) ──
 * Two surfaces ask it now — the Payments tab's headline tile and the seller overview's money row —
 * and they must not be able to answer differently about the same shop on the same page load. It is
 * also not a figure you can eyeball as correct: it deliberately returns two DIFFERENT quantities
 * depending on `multiStore`, which is the kind of rule that gets copied to a second call site with
 * the condition subtly rewritten.
 *
 * **A multi-store seller sees THIS shop's released money** (owner, 2026-08-11: *"זה לא רלוונטי מכל
 * החנויות, רק החנות שהוא עליה"*, and again: *"הוא נמצא על חנות א׳ אז הוא צריך לקבל מידע על חנות
 * א׳"*). **A single-store seller sees the account figure**, because for them there is no second shop
 * for a difference to hide in, and the transfer is the more useful of the two.
 *
 * ⚠️ The two are genuinely different quantities and neither is a rounding of the other: the transfer
 * is `releasable − paidOut + adjustments` across the ACCOUNT, and neither of those last two belongs
 * to a shop. So a screen showing the per-store number owes the seller the account-wide transfer
 * somewhere too, or they read ₪4,200 and are paid ₪1,800.
 */
export function payableHeadlineAgorot(
  slices: readonly HeldSlice[],
  storeSlug: string | null | undefined,
  multiStore: boolean,
  accountPayableNowAgorot: number,
): number {
  if (!multiStore || !storeSlug) return accountPayableNowAgorot;
  return releasedForStore(slices, storeSlug);
}

/** Every store with money on hold, in the order the slices arrived (newest order first, so the shop
 *  that traded most recently leads). Derived from the slices rather than taken as a store list: a
 *  shop with nothing waiting has nothing to say on this screen. */
export function storesWithHeldMoney(slices: readonly HeldSlice[]): string[] {
  const seen: string[] = [];
  for (const s of slices) {
    if (s.hold.state !== 'held') continue;
    if (!seen.includes(s.storeSlug)) seen.push(s.storeSlug);
  }
  return seen;
}
