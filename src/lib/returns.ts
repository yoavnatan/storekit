import { businessDayISO, businessTodayISO } from './business-day.js';
import { addDaysISO } from './date-range.js';
import { STATUTORY_RETURN_DAYS } from './payout-schedule.js';
import { SHIPPING_STATUS_RULES, orderMoneyWasTaken } from './order-status-rules.js';
import type { Order } from './orders.js';

/**
 * What a return request MEANS — every rule of the mechanism, as pure functions over one case.
 *
 * The decisions this encodes are the owner's, taken 2026-08-16 through the decision game and the
 * thread that followed it. **`docs/returns-policy-decisions.md` is the source; this file is its
 * implementation and nothing here may be changed without changing that.** Where the two could
 * disagree, the doc wins — including the numbers, which are repeated in `terms.astro` and on the
 * buyer's own screen.
 *
 * ── Pure, and day-based, for the same reason `payout-hold.ts` is ──
 * Every clock here decides money. A rule that reads the wall clock cannot be asserted in a test
 * without one, and "the day this expires" has to be a value a screen can show the buyer BEFORE it
 * arrives. So each function takes the day as a parameter with a default, and the business calendar
 * is the only calendar this platform has.
 *
 * ── ⚠️ Everything here is subject to a lawyer, and one rule especially ──
 * `docs/returns-lawyer-brief.md` carries eight questions, unanswered as of 2026-08-16. The one that
 * touches this file hardest is the handover window: it may RELEASE money, and it may never delete
 * the buyer's statutory right, which is not ours to condition. `handoverExpired` is written to that
 * shape — read its note before shortening, lengthening, or acting on it.
 */

/** Why the buyer is sending it back. The closed list from decisions §1. */
export type ReturnReason = 'changed_mind' | 'damaged' | 'wrong_item' | 'not_arrived';

/**
 * What the buyer may do with this order RIGHT NOW — the one function every surface asks.
 *
 * ── Why this exists, and it is a bug's headstone ──
 * Decisions §1 gives the buyer two different rights, and the first build shipped only the second:
 * **cancel** before the parcel leaves, and **return** after it arrives. The returns endpoint refused
 * anything that was not `delivered`, which is the correct rule for a RETURN and silently deleted the
 * cancellation — a buyer whose order had not shipped had no button at all. The owner caught it.
 *
 * They are not the same act and the difference is the whole of §0: a cancellation means nothing ever
 * reached anybody, so there is nothing to send back, no postage to argue about and no seller
 * discretion. A return means the sale completed and is being undone. Deciding which one applies is
 * therefore a single question about the order's status, and it is answered HERE so that the button,
 * the API and the copy cannot each answer it differently — which is exactly how the first version
 * came to disagree with itself.
 *
 * `'none'` is the honest fourth answer and the reason the buyer's screen stays quiet: an order that
 * is already cancelled, already returned, or still unpaid offers no action, and a button that
 * appears and then fails is worse than no button (the owner: *"לשים לב שזה מופיע לקונה רק מתי שזה
 * באמת אפשרי"*).
 */
export type BuyerOrderAction = 'cancel' | 'return' | 'none';

export function buyerActionFor(
  order: Pick<Order, 'paymentStatus' | 'shippingStatus'>,
): BuyerOrderAction {
  // Nothing was charged, so there is nothing to undo. A failed or still-pending checkout is not a
  // purchase the buyer can cancel; it is one that never became one.
  //
  // Asked of the status table's `moneyWasTaken` column and never as `paymentStatus === 'paid'` —
  // `money-guards.test.ts` refuses that comparison tree-wide, and it is right to: the column is the
  // question "was a real person's money taken", which is what this branch means, while the literal
  // is a spelling that has already drifted from its meaning once in this codebase.
  if (!orderMoneyWasTaken(order)) return 'none';

  // Asked of the status TABLE, never of the words 'cancelled'/'returned' — a status that stops
  // holding stock has already been undone by somebody, and a future terminal status inherits this
  // answer by filling in its row (`order-status-rules.ts`).
  const rule = SHIPPING_STATUS_RULES[order.shippingStatus];
  if (!rule || rule.terminal) return 'none';

  // Delivered: the goods are with the buyer, so undoing it means sending them back.
  if (order.shippingStatus === 'delivered') return 'return';

  // `cancellableFrom` is the seller's own column and it says exactly what is needed here: the parcel
  // has not been handed to a courier, so nothing is in motion and the order can simply stop. Once it
  // is `shipped` neither action applies — there is a parcel travelling that nobody can recall, and
  // the buyer's next move is to receive it and then return it.
  return rule.cancellableFrom ? 'cancel' : 'none';
}

/** Where the case stands. Mirrors the CHECK on `return_requests.status` (migration 0030). */
export type ReturnStatus =
  | 'requested' | 'approved' | 'rejected' | 'in_transit'
  | 'received' | 'refunded' | 'disputed' | 'expired';

/**
 * How long the seller has to answer a request he is actually allowed to refuse.
 *
 * **2 business days, and it is the same 2 the seller already promised for handing a parcel to the
 * courier** (`SHIP_DEADLINE_BUSINESS_DAYS`). The owner picked 3 in the game and changed it to 2 when
 * he saw the two numbers side by side: a platform with two different "you have N days" promises
 * teaches a seller neither.
 *
 * It applies ONLY outside the statutory window — inside it there is nothing to answer.
 */
export const RESPONSE_BUSINESS_DAYS = 2;

/**
 * How long the buyer has to hand the parcel over once the request is approved.
 *
 * ⚠️ **This releases money. It does not remove a right** — see `handoverExpired`.
 */
export const HANDOVER_DAYS = 7;

/**
 * How long the seller has to open the box before the refund goes out on its own.
 *
 * **Counted from the parcel's ARRIVAL, never from the request** (owner's correction, decisions §4).
 * A clock started at the request refunds a buyer while the parcel is still in the post, or because
 * the seller was on holiday — punishing him for something he does not control, and paying out before
 * anyone has looked inside the box. From arrival it means only one thing: he has it and has not
 * answered.
 *
 * Two business days is what eBay allows for the same moment. It is deliberately much shorter than
 * `HANDOVER_DAYS`: the seller has the goods in his hands, and the buyer is by then owed money.
 */
export const RECEIPT_RESPONSE_BUSINESS_DAYS = 2;

/**
 * Was this request opened inside the statutory window — i.e. is it the buyer's RIGHT?
 *
 * 14 days from receiving the goods (`STATUTORY_RETURN_DAYS`, checked against the regulations and
 * not recalled — see that constant). Inside it the seller has no say at all; outside it a return is
 * a favour and he decides.
 *
 * **Measured from delivery, and an order with no delivery date is treated as INSIDE.** That is the
 * conservative direction and it is deliberate: `deliveredAt` is set when someone marks the order
 * delivered, and an order that reached the buyer without anyone pressing the button is a gap in our
 * records, not evidence against them. Refusing a buyer their statutory right on the strength of a
 * missing timestamp is the one error here that cannot be undone by a later correction.
 */
export function withinStatutoryWindow(
  order: Pick<Order, 'deliveredAt'>,
  todayISO: string = businessTodayISO(),
): boolean {
  if (!order.deliveredAt) return true;
  const deadline = addDaysISO(businessDayISO(new Date(order.deliveredAt)), STATUTORY_RETURN_DAYS);
  // Inclusive: on the fourteenth day itself the right still stands.
  return todayISO <= deadline;
}

/**
 * Is this request approved the moment it is made?
 *
 * **The question is WHEN THE REQUEST WAS OPENED, not when the seller answered** — the owner caught
 * the first version of this rule getting it wrong, and the error was a breach of law rather than a
 * business choice. A request opened on day 10 and left unanswered is still a request the buyer had
 * every right to make; letting the seller's silence close it would be conditioning a right that
 * "אינה ניתנת להתניה".
 *
 * So `within_statutory` is stored on the row at creation and read here forever after.
 */
export function autoApproved(withinStatutory: boolean): boolean {
  return withinStatutory;
}

/**
 * Who pays to send it back (decisions §5).
 *
 * The buyer when they simply changed their mind — the default the regulations set, and the thing
 * that stops a free-returns policy from being a free-shipping subsidy. The seller in every other
 * case, because each of them is the seller having sent the wrong thing or a broken one, and the
 * regulations put collection on the business at its own expense.
 *
 * `not_arrived` is the seller's too as far as this function is concerned, but it never reaches a
 * carrier: nothing was received, so nothing goes back. It is the platform's case (decisions §8).
 */
export function returnShippingPayer(reason: ReturnReason): 'buyer' | 'seller' {
  return reason === 'changed_mind' ? 'buyer' : 'seller';
}

/**
 * What the buyer gets back, in agorot.
 *
 * The goods always. The ORIGINAL delivery charge only when the fault was the seller's — which is the
 * distinction the regulations draw and the one that reads as fair from both sides. A buyer who
 * changed their mind consumed a real delivery that was really paid for; a buyer sent a broken lamp
 * did not.
 *
 * **No cancellation fee is ever deducted.** The regulations permit 5% or ₪100, whichever is lower,
 * and the owner chose to waive it in every case (decisions §4) — "החזרה בלי דמי ביטול" is a sentence
 * worth more than the fee. There is deliberately no parameter here through which one could return.
 */
export function refundAmountAgorot(
  order: Pick<Order, 'totalAgorot' | 'shippingAgorot'>,
  reason: ReturnReason,
): number {
  const goodsAndShipping = order.totalAgorot;
  if (reason === 'changed_mind') return Math.max(0, goodsAndShipping - order.shippingAgorot);
  return goodsAndShipping;
}

/** One line of a partial return: which line of the order, and how many of it. */
export interface ReturnedLine {
  /** The line's place in the order (`order_items.position`), which is what makes a receipt read the
   *  way it was bought. NOT a product id: one order can hold the same product twice at different
   *  variants, and the variants are a JSONB blob whose equality is not an identity. */
  position: number;
  qty: number;
}

/**
 * Is this a whole-order return, or a few lines out of it?
 *
 * `null`/empty means the whole thing — which is what every request written before partial returns
 * existed meant, and what the buyer's screen offers by default.
 */
export function isPartialReturn(lines: ReturnedLine[] | null | undefined): boolean {
  return Array.isArray(lines) && lines.length > 0;
}

/**
 * What comes back on a PARTIAL return (decisions §4).
 *
 * **The original delivery charge is never in it, and that is the rule rather than an oversight.**
 * On a whole-order return a faulty parcel refunds the postage too, because the buyer paid to receive
 * something they are not keeping. On a partial one the delivery really was performed for the items
 * they ARE keeping — the van came, the box arrived — so the charge stays even when the returned item
 * was the broken one.
 *
 * Quantities are clamped to what the line actually holds, and unknown positions are ignored rather
 * than trusted: this reads a list that arrived in a request body, and a line saying "position 4,
 * quantity 900" must cost the seller nothing (`AI_INSTRUCTIONS` → bounds are checked on the server
 * even when the UI already checks them).
 */
export function partialRefundAgorot(
  order: Pick<Order, 'items'>,
  lines: ReturnedLine[],
): number {
  let total = 0;
  for (const line of lines) {
    const item = order.items[line.position];
    if (!item) continue;
    const qty = Math.max(0, Math.min(Math.floor(line.qty), item.qty));
    total += item.priceAgorot * qty;
  }
  return total;
}

/**
 * The refund for a request, whichever kind it is — the one function every caller asks.
 *
 * Written as a single entry point on purpose: "how much comes back" is exactly the question two
 * surfaces would answer differently if each decided for itself whether this was a partial.
 */
export function refundForRequest(
  order: Pick<Order, 'items' | 'totalAgorot' | 'shippingAgorot'>,
  reason: ReturnReason,
  lines: ReturnedLine[] | null | undefined,
): number {
  return isPartialReturn(lines) ? partialRefundAgorot(order, lines!) : refundAmountAgorot(order, reason);
}

/**
 * The state machine, as one table.
 *
 * Same discipline as `order-status-rules.ts` and for the same reason: a case that can be moved
 * anywhere from anywhere is a case where two screens disagree about what happened. An empty list is
 * a terminal state.
 *
 * `disputed` is reachable from `received` only — the seller has to have the parcel before he can
 * say what was in it — and it leads back to `refunded` or on to `rejected`, which is the admin
 * deciding. Nothing reaches `refunded` except through the seller having it or the admin saying so.
 */
export const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  requested:  ['approved', 'rejected'],
  approved:   ['in_transit', 'expired', 'rejected'],
  in_transit: ['received', 'expired'],
  received:   ['refunded', 'disputed'],
  disputed:   ['refunded', 'rejected'],
  rejected:   [],
  refunded:   [],
  expired:    [],
};

export function canMove(from: ReturnStatus, to: ReturnStatus): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  if (!RETURN_TRANSITIONS[from]?.includes(to)) {
    return { ok: false, reason: `בקשת החזרה במצב "${from}" לא יכולה לעבור ל-"${to}"` };
  }
  return { ok: true };
}

/** Is this case still waiting on somebody? What the seller's tab and the admin's queue count. */
export function isOpen(status: ReturnStatus): boolean {
  return RETURN_TRANSITIONS[status].length > 0;
}

/** The day the buyer must have handed the parcel over by. Null before approval. */
export function handoverDeadlineISO(approvedAtISO: string | null): string | null {
  if (!approvedAtISO) return null;
  return addDaysISO(businessDayISO(new Date(approvedAtISO)), HANDOVER_DAYS);
}

/**
 * Has an approved request run out of time, so the money may go to the seller?
 *
 * ⚠️ **Read this before acting on it.** Expiry releases the HOLD; it does not extinguish the buyer's
 * statutory right, which is not ours to condition. A parcel that turns up after this day is still
 * refunded — out of the seller's next payout, through the clawback that already exists
 * (`refund-owed.ts#recordSellerClawback`). The window exists so a seller's money is not frozen
 * indefinitely by a request nobody acted on, and for no other purpose.
 *
 * That distinction is question 2 in `docs/returns-lawyer-brief.md` and is UNCONFIRMED. If the answer
 * is that no such window may exist at all, this function is what gets deleted — not the rest.
 */
export function handoverExpired(
  approvedAtISO: string | null,
  todayISO: string = businessTodayISO(),
): boolean {
  const deadline = handoverDeadlineISO(approvedAtISO);
  return deadline !== null && deadline < todayISO;
}

/**
 * Is a received parcel now due for its automatic refund?
 *
 * From arrival, and only from arrival. A dispute stops it — that is the seller's answer, and the
 * clock exists precisely because silence is not one.
 */
export function autoRefundDueISO(deliveredBackAtISO: string | null): string | null {
  if (!deliveredBackAtISO) return null;
  return addDaysISO(businessDayISO(new Date(deliveredBackAtISO)), RECEIPT_RESPONSE_BUSINESS_DAYS);
}

export function dueForAutoRefund(
  status: ReturnStatus,
  deliveredBackAtISO: string | null,
  todayISO: string = businessTodayISO(),
): boolean {
  if (status !== 'received') return false;
  const due = autoRefundDueISO(deliveredBackAtISO);
  // Inclusive, like every other deadline here: on the day itself it is due.
  return due !== null && due <= todayISO;
}

/**
 * The day the SELLER must answer by — only meaningful outside the statutory window, where he has
 * something to answer. Inside it the request was approved on arrival and this is never asked.
 */
export function responseDeadlineISO(createdAtISO: string): string {
  return addDaysISO(businessDayISO(new Date(createdAtISO)), RESPONSE_BUSINESS_DAYS);
}

/**
 * A seller who did not answer in time, on a request he was entitled to refuse.
 *
 * **Silence is a REFUSAL here, and that is the owner's correction.** The first version auto-approved
 * — which is right inside the statutory window and is already handled there by `autoApproved`, and
 * is incoherent outside it: if the seller owes the buyer nothing, his silence cannot be made to mean
 * consent. Outside the window a return is a favour, and an unanswered favour is not granted.
 */
export function responseOverdue(
  status: ReturnStatus,
  withinStatutory: boolean,
  createdAtISO: string,
  todayISO: string = businessTodayISO(),
): boolean {
  if (status !== 'requested' || withinStatutory) return false;
  return responseDeadlineISO(createdAtISO) < todayISO;
}

/**
 * Does an open case freeze this order's payout?
 *
 * Yes, for every state where the money might still have to go back — which is every open one. The
 * owner's answer in the game, and the cheap half of the protection: the platform is still holding
 * the money at that point, so refusing to release it costs a clawback nobody has to chase.
 *
 * `disputed` freezes too, deliberately: it is the state where we know LEAST about who the money
 * belongs to.
 */
export function freezesPayout(status: ReturnStatus): boolean {
  return isOpen(status);
}
