import { businessDayISO, businessTodayISO } from './business-day.js';
import { addDaysISO } from './date-range.js';
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
 * The same four reasons in the words a person reads.
 *
 * Here rather than on a panel because there are now three readers of them — the seller's card, the
 * admin's queue and the money journal's own detail line — and the third one is how this arrived: the
 * journal wrote the raw code, so an owner reading his own money log saw `סיבה: changed_mind` beside
 * a Hebrew sentence. Two of the three already had identical private copies of this map, which is the
 * shape a third reader turns from duplication into a bug.
 *
 * Hebrew literals with no `getT`: a data vocabulary on Hebrew-only surfaces, exactly like
 * `store-taxonomy.ts` (`tests/i18n-hardcoded-strings.test.ts` decides scope by whether a file calls
 * the translator, and this one deliberately does not).
 */
export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  changed_mind: 'התחרט',
  damaged: 'הגיע פגום',
  wrong_item: 'לא מה שהוזמן',
  not_arrived: 'לא הגיע כלל',
};

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
  | 'received' | 'refunded' | 'disputed' | 'expired'
  /** The seller has offered money instead of a return, and the buyer has not answered yet
   *  (decisions §4, migration 0035). The one state where nobody is late. */
  | 'offered';

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
/**
 * How much the buyer may write when opening a case.
 *
 * The case itself is STRUCTURED — a reason from a closed list, which lines, an optional photo — and
 * that is the owner's rule for this whole surface: free text belongs to messaging, between people
 * who are signed in. This one field is the exception decisions §1 already wrote down, and it earns
 * it: "הגיע פגום" with nothing beside it leaves the seller guessing what is broken, and a guess is
 * a slower case and often a wrong refusal.
 *
 * 500 characters is the shape of that exception. Long enough for the sentence or two that turns a
 * category into a fact, short enough that the field cannot become a conversation — which would be
 * the messaging channel arriving through a side door, on a surface with no reply.
 */
export const RETURN_NOTE_MAX = 500;

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
 * The buyer's statutory cancellation window — **not ours to choose.**
 *
 * Israeli consumer law gives a distance-sale buyer **14 days from RECEIVING the goods** to cancel
 * (חוק הגנת הצרכן §14ג + תקנות ביטול עסקה תשע"א-2010; checked 2026-08-10 against kolzchut.org.il,
 * not recalled). Everything else on this page is a policy we set; this one is the floor the policy
 * has to clear, which is why it is a constant of its own rather than a number inside the comment
 * below.
 *
 * It lived in `payout-schedule.ts` until 2026-08-21, because the payout hold was set against it.
 * That hold is gone and this is not: it is the buyer's right, and `returns.ts` is the module that
 * decides everything else about a return.
 */
export const STATUTORY_RETURN_DAYS = 14;

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
 * The words for the goods coming back, inflected — one table, because half of these returns are not
 * one product.
 *
 * Every seller-facing sentence about a return was written as *"המוצר"*: the card's status line, its
 * deadline line, the button that marks the parcel arrived, the explainer under it, and both parcel
 * notifications. A request may hold several lines or a whole order, so on those cards each of those
 * sentences described a different case from the one on screen. The owner read it on the
 * notification (2026-08-23: *"כדאי לרשום מוצר חזר אליך, ואולי בכלל מדובר במוצרים?"* — it may) and
 * the same singular was everywhere behind it.
 *
 * **Here rather than in either caller, and that is the point.** The approve dialog had already been
 * choosing מוצר or מוצרים for months (`scripts/dashboard/returns.ts`) while the card around it
 * said "המוצר" — one surface counting and its neighbour not is exactly the drift a second copy
 * produces. The panel and the notifications now read the same table.
 *
 * `count` is how many distinct products are coming back. **0 means "a whole order, size unknown"** —
 * a notification holds the request but not the order behind it, so it cannot count lines it never
 * read, and "ההזמנה" is the one true thing it can say. A caller that DOES know (the card does, via
 * `orderFacts`) passes the real number and gets the products named instead.
 */
export interface ReturnedGoods {
  /** המוצר / המוצרים / ההזמנה — definite, for a sentence that has already introduced them. */
  the: string;
  /** מוצר חזר אליך / מוצרים חזרו אליך / ההזמנה חזרה אליך — indefinite, for an alert that opens on it. */
  cameBackToYou: string;
  /** אותו / אותם / אותה */
  it: string;
  /** הגיע / הגיעו / הגיעה */
  arrived: string;
  /** יגיע / יגיעו / תגיע */
  willArrive: string;
  /** חזר / חזרו / חזרה */
  cameBack: string;
  /** ממתין / ממתינים / ממתינה */
  waiting: string;
  /** מחכה לך / מחכים לך */
  waitsForYou: string;
  /** תקין / תקינים / תקינה */
  ok: string;
}

export function returnedGoods(count: number): ReturnedGoods {
  if (count <= 0) {
    return {
      the: 'ההזמנה', cameBackToYou: 'ההזמנה חזרה אליך', it: 'אותה', arrived: 'הגיעה',
      willArrive: 'תגיע', cameBack: 'חזרה', waiting: 'ממתינה', waitsForYou: 'מחכה לך', ok: 'תקינה',
    };
  }
  if (count === 1) {
    return {
      the: 'המוצר', cameBackToYou: 'מוצר חזר אליך', it: 'אותו', arrived: 'הגיע',
      willArrive: 'יגיע', cameBack: 'חזר', waiting: 'ממתין', waitsForYou: 'מחכה לך', ok: 'תקין',
    };
  }
  return {
    the: 'המוצרים', cameBackToYou: 'מוצרים חזרו אליך', it: 'אותם', arrived: 'הגיעו',
    willArrive: 'יגיעו', cameBack: 'חזרו', waiting: 'ממתינים', waitsForYou: 'מחכים לך', ok: 'תקינים',
  };
}

/** How many products a request brings back, or 0 when only the order behind it could say.
 *  The companion to `returnedGoods` for a caller holding the request and nothing else. */
export function returnedGoodsCount(lines: ReturnedLine[] | null | undefined): number {
  if (!isPartialReturn(lines)) return 0;
  // `qty` is per line and a line can hold several of the same product, so units decide the number —
  // two of one product is still "מוצרים". Clamped at 1 because a stored 0 would silently turn a
  // real parcel into no products at all.
  return lines!.reduce((n, l) => n + Math.max(1, l.qty), 0);
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
  // No 'offered' here, deliberately: declining an offer returns the case to `approved`, and from
  // `requested` that would GRANT a return the seller may still have been entitled to refuse. An
  // offer is a shortcut through an approved return, never a way around the decision.
  // No 'offered' here, deliberately: declining an offer returns the case to `approved`, and from
  // `requested` that would GRANT a return the seller may still have been entitled to refuse.
  requested:  ['approved', 'rejected'],
  // `in_transit` is now the BUYER saying he sent it — see `RETURN_TRANSITIONS`' own note below.
  approved:   ['in_transit', 'expired', 'rejected', 'offered', 'received'],
  // The buyer's answer, and nothing else. Accepting pays the offered amount and keeps the goods
  // where they are; declining puts the case back exactly where it was, because a refusal must cost
  // the buyer nothing or the offer is a trap rather than a shortcut. `expired` is the sweep's answer
  // to a buyer who never replies — without it the case AND the seller's money freeze forever.
  offered:    ['refunded', 'approved', 'expired'],
  // NOT `expired`. Once the buyer has said he sent it, letting the clock hand the money to the seller
  // decides a factual dispute by default, in favour of the person who did nothing. `disputed` is a
  // person deciding it, which is the only honest answer when neither side has proof.
  in_transit: ['received', 'disputed'],
  received:   ['refunded', 'disputed'],
  disputed:   ['refunded', 'rejected'],
  // The buyer's escalation, and the reason `rejected` is no longer a dead end. A seller can refuse
  // for a good reason or a bad one, and until now a refusal ended the matter with no way to ask
  // anybody to look — including the refusals the law does not allow him to make. It goes to
  // `disputed` because that is our word for "a person decides", not because a refusal is suspect.
  rejected:   ['disputed'],
  refunded:   [],
  expired:    [],
};

/**
 * ── Who owns `in_transit`, and why it changed (owner's sweep, 2026-08-17) ──
 *
 * It was a SELLER move ("הקונה שלח את המוצר"), which put every protection the buyer had in the hands
 * of the person with the opposite interest. A seller who touched nothing let the request expire on
 * day 7 and kept the money and the goods — in total silence, with nothing anywhere saying so.
 *
 * It is now the BUYER's declaration. That is not proof and is not treated as any: it cannot refund
 * anything by itself. What it does is stop the expiry and put the case in front of a person, which is
 * the only honest answer when one side says "I sent it" and the other says nothing.
 *
 * PROOF stays what the owner defined: the seller marking it received (which is also what a physical
 * return in the shop is), or the carrier's webhook once a tracked label exists. Both land on
 * `received`, and only `received` can pay.
 */

export function canMove(from: ReturnStatus, to: ReturnStatus): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  if (!RETURN_TRANSITIONS[from]?.includes(to)) {
    return { ok: false, reason: `בקשת החזרה במצב "${from}" לא יכולה לעבור ל-"${to}"` };
  }
  return { ok: true };
}

/**
 * The states where somebody still owes somebody an action.
 *
 * ⚠️ Listed, not derived — and it USED to be derived, as `RETURN_TRANSITIONS[status].length > 0`.
 * That read beautifully and was wrong the moment `rejected` gained the buyer's escalation: one new
 * arrow out of a closed state would have turned every refused case in the system back into an open
 * one, freezing those sellers' payouts indefinitely and filling both queues with cases nobody is
 * waiting on. "Can still move" and "is still open" looked like the same property and are not: a
 * refusal is finished business that a buyer may nonetheless ask us to look at again.
 */
export const OPEN_RETURN_STATUSES: readonly ReturnStatus[] = [
  'requested', 'approved', 'offered', 'in_transit', 'received', 'disputed',
];

/** Is this case still waiting on somebody? What the seller's tab and the admin's queue count. */
export function isOpen(status: ReturnStatus): boolean {
  return OPEN_RETURN_STATUSES.includes(status);
}

/**
 * The same question for a `WHERE` clause — GENERATED from the list above, never typed again.
 *
 * `status NOT IN ('rejected', 'refunded', 'expired')` had been hand-spelled in six places by
 * 2026-08-20: four queries in `return-requests.ts`, the payout hold, and migration 0030's partial
 * index. Every one was correct, and that is exactly the state `order-status-rules.ts` exists to
 * prevent one level up — the list is a business rule with a documented reason for each member
 * (`OPEN_RETURN_STATUSES` argues why a REFUSAL is closed even though the buyer may still escalate it), and
 * six copies means the seventh reader adds a state to the machine and quietly fixes five of them.
 *
 * Written as `IN (open)` rather than `NOT IN (closed)` because the list above is the one that is
 * maintained: a new state added to the machine and forgotten here is then EXCLUDED, which shows up
 * as a case missing from a queue rather than as a payout released on a live dispute.
 *
 * The migration's index keeps its own literal, and must: an index predicate is frozen in the
 * database at the moment it was created, and it is not this module's to regenerate.
 */
export function openReturnSql(column = 'status'): string {
  return `${column} IN (${OPEN_RETURN_STATUSES.map((s) => `'${s}'`).join(', ')})`;
}

/**
 * Of the open cases, the ones the SELLER actually has to do something about.
 *
 * ── Why this is not `isOpen` (owner, 2026-08-20) ──
 * The returns tab said *"13 בקשות מחכות לך"* over every open case, and most of them were not
 * waiting on him at all: *"יש שם בקשות שלא מחכות לו! מחכות להכרעה... או שמחכות שהקונה ישלח את
 * המוצר"*. A count that names the reader as the person holding things up, when eleven of the
 * thirteen are waiting on somebody else, is the shape that teaches a seller to stop reading his own
 * badge — and then the two that ARE his go unanswered too.
 *
 * The three that are his, and nothing else:
 *  · `requested` — he must answer or the clock closes it as a refusal. (Inside the statutory window
 *    a request is never `requested`; it is `approved` on arrival, which is why this one is always a
 *    real decision.)
 *  · `in_transit` — the buyer says it is on its way, and only the seller can say it arrived. His
 *    silence for a fortnight is what sends the case to us, so the button is genuinely his.
 *  · `received` — it is in his hands and he has two business days before the money goes back on its
 *    own.
 *
 * `approved` and `offered` wait on the BUYER; `disputed` waits on US. A seller can act on none of
 * them, and the card says so in words either way.
 *
 * Listed rather than derived from the button table, for the same reason `OPEN_RETURN_STATUSES` is:
 * "has a button" and "owes an action" agree today and are different questions — a state the seller
 * may optionally move (the offer, from `approved`) is not one he is holding up.
 */
// Not exported: `sellerOwesAction` and `sellerActionSql` are the whole of this rule's surface, and
// a third door onto the same list is a third place a new state can be forgotten.
const SELLER_ACTION_STATUSES: readonly ReturnStatus[] = ['requested', 'in_transit', 'received'];

/** Does this case need the seller to do something? What his tab badge and its header count. */
export function sellerOwesAction(status: ReturnStatus): boolean {
  return SELLER_ACTION_STATUSES.includes(status);
}

/** The same question for a `WHERE` clause — GENERATED from the list above, never typed again. */
export function sellerActionSql(column = 'status'): string {
  return `${column} IN (${SELLER_ACTION_STATUSES.map((s) => `'${s}'`).join(', ')})`;
}

/**
 * How long after a refusal the buyer may still ask us to look at it.
 *
 * Not a limit on the buyer's rights — those are not ours to time — but on this button. A case has to
 * become finished at some point: the seller's money is released on a refusal, and reopening a case
 * from six months ago means clawing back money already paid out over a dispute whose evidence
 * (the parcel, the photographs, the messages) nobody kept. Two weeks matches the statutory window
 * the buyer had in the first place, and a buyer past it can still write to us like any other person.
 */
export const ESCALATION_DAYS = 14;

/** May the buyer still escalate this refusal to us? */
export function canEscalate(
  status: ReturnStatus,
  rejectedAtISO: string | null,
  todayISO: string = businessTodayISO(),
): boolean {
  if (status !== 'rejected' || !rejectedAtISO) return false;
  return addDaysISO(businessDayISO(new Date(rejectedAtISO)), ESCALATION_DAYS) >= todayISO;
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
 * How long a declared-sent parcel may travel before a person has to look at it.
 *
 * Generous on purpose. It is not a deadline anybody is being held to — it is how long we wait before
 * admitting that nobody can prove what happened. A domestic parcel arrives in days; two weeks means a
 * seller who really received nothing has had every chance to say so, and a buyer who really sent it is
 * not left waiting on somebody else's silence.
 */
export const IN_TRANSIT_PATIENCE_DAYS = 14;

/** The day an unanswered offer stops holding the seller's money hostage. */
export const OFFER_ANSWER_DAYS = 7;

/** Why a case is sitting on the admin's desk. */
export type DisputeCause = 'seller_claim' | 'parcel_unconfirmed' | 'refusal_appeal' | 'unknown';

/**
 * Which of the three doors this dispute came through.
 *
 * There used to be one — a seller claiming the returned parcel was empty or the goods used — and the
 * admin screen said so in a standing sentence above the list. Two more exist now (a parcel the buyer
 * says he posted and nobody confirms, and a buyer appealing a refusal), so that sentence would have
 * sent the owner hunting for an empty-parcel claim on a case that never had one.
 *
 * Read from the case's own timestamps rather than stored, because each one already IS the fact:
 *
 *  · `deliveredBackAt` — the parcel reached the seller. Whatever he says about it, he had it.
 *  · `sentAt` with no `deliveredBackAt` — the buyer says he posted it and nobody ever confirmed
 *    arrival. This is the door with no evidence behind it, and the one that needs a person.
 *  · `settledAt` with neither — the case had already closed as refused, so it is here on appeal.
 *
 * Ordered by how much we KNOW, most first: a case that reached the seller is a claim about goods in
 * his hands no matter what else happened to it earlier.
 */
export function disputeCause(r: {
  deliveredBackAt: string | null;
  sentAt: string | null;
  settledAt: string | null;
}): DisputeCause {
  if (r.deliveredBackAt) return 'seller_claim';
  if (r.sentAt) return 'parcel_unconfirmed';
  if (r.settledAt) return 'refusal_appeal';
  return 'unknown';
}

/**
 * The day we will look at a declared-sent parcel ourselves. Null before the buyer has declared.
 *
 * The DATE half of `inTransitStale`, kept beside it so the screen that promises a seller something and
 * the job that does it can never be two different calculations — the mistake this file exists to make
 * impossible.
 */
export function inTransitReviewDueISO(sentAtISO: string | null): string | null {
  if (!sentAtISO) return null;
  return addDaysISO(businessDayISO(new Date(sentAtISO)), IN_TRANSIT_PATIENCE_DAYS);
}

/** The day an unanswered offer closes. Null before one was made. */
export function offerAnswerDueISO(offeredAtISO: string | null): string | null {
  if (!offeredAtISO) return null;
  return addDaysISO(businessDayISO(new Date(offeredAtISO)), OFFER_ANSWER_DAYS);
}

/** Has a declared-sent parcel been in the air long enough that a person must decide? */
export function inTransitStale(
  sentAtISO: string | null,
  todayISO: string = businessTodayISO(),
): boolean {
  if (!sentAtISO) return false;
  return addDaysISO(businessDayISO(new Date(sentAtISO)), IN_TRANSIT_PATIENCE_DAYS) <= todayISO;
}

/**
 * Has an offer gone unanswered long enough to close?
 *
 * The hole it fills: `offered` had no clock at all, so a buyer who never replied left the case open
 * and that order's payout frozen — indefinitely, with nobody late and nothing to chase. Expiring it
 * releases the seller's money, and the buyer's statutory right is untouched: they can open a new
 * request, exactly as they could before the offer was made.
 */
export function offerUnanswered(
  offeredAtISO: string | null,
  todayISO: string = businessTodayISO(),
): boolean {
  if (!offeredAtISO) return false;
  return addDaysISO(businessDayISO(new Date(offeredAtISO)), OFFER_ANSWER_DAYS) < todayISO;
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

/**
 * WHOSE move a case is waiting on — one word, from the two lists above and nothing else.
 *
 * The seller's tab now sorts and filters by this (owner, 2026-08-23: *"אין אפשרות למיין ואולי גם
 * לפלטר לפי ממתין לטיפולי או לפי תאריך"*), and the card wears it as a chip. That is three surfaces
 * asking one question, which is exactly how a fourth spelling of it gets written — so it is DERIVED
 * from `isOpen` and `sellerOwesAction` rather than listed again. A state added to the machine lands
 * in the right lane the moment those two know about it.
 *
 * `ours` is `disputed` alone, and it earns its own lane rather than being folded into "not mine":
 * a seller told to wait for the BUYER on a case sitting on our desk has been told the wrong thing
 * about who to chase.
 */
export type ReturnLane = 'mine' | 'buyer' | 'ours' | 'closed';

export function returnLane(status: ReturnStatus): ReturnLane {
  if (!isOpen(status)) return 'closed';
  if (sellerOwesAction(status)) return 'mine';
  return status === 'disputed' ? 'ours' : 'buyer';
}

/**
 * The day THIS case's clock lands on, whichever clock is running — or null when none is.
 *
 * Every open state has a deadline and each is computed by its own function above; the card needed
 * the date for its sentence, and the tab now needs it again to sort by urgency. Asking each caller
 * to re-walk the same `switch` is how two surfaces come to disagree about which clock a state is
 * on — which shows up as a list ordered by a date the card does not print.
 *
 * `requested` inside the statutory window has no clock and must not be given one: the request was
 * approved on arrival, so there is nothing for the seller to answer (`autoApproved`).
 */
export function returnClockDueISO(r: {
  status: ReturnStatus;
  withinStatutory: boolean;
  createdAt: string;
  approvedAt: string | null;
  sentAt: string | null;
  offeredAt: string | null;
  deliveredBackAt: string | null;
}): string | null {
  switch (r.status) {
    case 'requested': return r.withinStatutory ? null : responseDeadlineISO(r.createdAt);
    case 'approved': return handoverDeadlineISO(r.approvedAt);
    case 'in_transit': return inTransitReviewDueISO(r.sentAt);
    case 'offered': return offerAnswerDueISO(r.offeredAt);
    case 'received': return autoRefundDueISO(r.deliveredBackAt);
    default: return null;
  }
}
