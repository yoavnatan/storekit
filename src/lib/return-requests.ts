import crypto from 'node:crypto';
import { rows, firstRow } from './db.js';
import { getOrderById, updateOrder, type Order } from './orders.js';
import { settleStatusChange, type StatusChangeStore } from './order-status-change.js';
import { canTransition } from './order-status-rules.js';
import { notifyBuyerReturnStatus, notifySellerReturnOpened } from './return-notify.js';
import {
  autoApproved, canMove, refundForRequest, returnShippingPayer, withinStatutoryWindow,
  isPartialReturn, openReturnSql, RETURN_REASON_LABELS, type ReturnedLine, type ReturnReason, type ReturnStatus,
} from './returns.js';
import { recordMoneyEvent } from './money-events.js';
import { formatAgorot } from './money.js';
import { recordAdjustment } from './payouts.js';
import { getSellerById } from './seller-auth.js';
import { commissionOnAgorot, commissionPercentForTier } from './pricing.js';
import { restockProduct } from './store-products.js';

/**
 * A return request, stored — and the ONE place its status is allowed to move.
 *
 * ── Why the money is not re-implemented here, and must never be ──
 * Reaching `refunded` moves the ORDER to `returned`, through `settleStatusChange`. That function
 * already owns every consequence of an order leaving the books: the journal row, the refund
 * obligation (`refund-owed.ts`), the seller clawback when the hold had already released, the restock,
 * the buyer notification, and a pending store closure that this order was holding open. Writing any
 * of that again here would be a second definition of what a return costs — the exact shape of the
 * bug `order-status-rules.ts` exists to prevent, one level up.
 *
 * So this module's whole job on the money side is: decide WHETHER the case may move, record that it
 * did, and hand the order to the code that already knows. The status table does the rest — `returned`
 * says `countsAsRevenue: false` and `holdsStock: false`, so the restock and the refund follow with
 * nothing here mentioning either.
 *
 * ── ⚠️ The refund is an OBLIGATION, not a transfer ──
 * `refund_due` is written the moment the debt exists and `refund_settled` by nothing at all, because
 * settling needs a payment provider's refund call and none is chosen (GO_LIVE §3). Every case that
 * reaches `refunded` therefore shows on the admin's reconciliation card as money still to return by
 * hand. That is deliberate: the record must not close itself before the money has actually moved.
 */

export interface ReturnRequest {
  id: string;
  orderId: string;
  storeSlug: string;
  reason: ReturnReason;
  buyerNote: string;
  buyerPhotoUrl: string | null;
  status: ReturnStatus;
  withinStatutory: boolean;
  returnShippingPayer: 'buyer' | 'seller';
  refundAgorot: number;
  partialOfferAgorot: number | null;
  /** Which lines came back, or null for the whole order (migration 0031). */
  returnedLines: ReturnedLine[] | null;
  trackingNumber: string | null;
  sellerNote: string;
  adminNote: string;
  createdAt: string;
  approvedAt: string | null;
  /** When the BUYER said he sent it back. A claim, not proof — see `returns.ts`' note on who owns
   *  `in_transit`. Only `received` may pay. */
  sentAt: string | null;
  /** When the seller offered money instead of a return. Starts the answer clock. */
  offeredAt: string | null;
  /** What the ADMIN awarded the buyer when deciding a dispute. `null` = the whole refund. Kept apart
   *  from `partialOfferAgorot`, which is the SELLER's offer — on a disputed case, who proposed an
   *  amount is the whole question. */
  adminAwardAgorot: number | null;
  deliveredBackAt: string | null;
  /** When this request stopped being open. `settledAt` and not `closedAt` on purpose: the latter
   *  is the store-lifecycle vocabulary, and `store-lifecycle-guard.test.ts` rightly refuses any
   *  other subject borrowing it. The database column is still `closed_at`. */
  settledAt: string | null;
  updatedAt: string;
}

interface Row {
  id: string; order_id: string; store_slug: string; reason: string;
  buyer_note: string; buyer_photo_url: string | null; status: string;
  within_statutory: boolean; return_shipping_payer: string;
  refund_agorot: string | number; partial_offer_agorot: string | number | null;
  admin_award_agorot: number | null;
  returned_lines: ReturnedLine[] | null;
  tracking_number: string | null; seller_note: string; admin_note: string;
  created_at: Date | string; approved_at: Date | string | null;
  sent_at: Date | string | null; offered_at: Date | string | null;
  delivered_back_at: Date | string | null; closed_at: Date | string | null;
  updated_at: Date | string;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : (typeof v === 'string' ? v : v.toISOString());

function toRequest(r: Row): ReturnRequest {
  return {
    id: r.id,
    orderId: r.order_id,
    storeSlug: r.store_slug,
    reason: r.reason as ReturnReason,
    buyerNote: r.buyer_note,
    buyerPhotoUrl: r.buyer_photo_url,
    status: r.status as ReturnStatus,
    withinStatutory: r.within_statutory,
    returnShippingPayer: r.return_shipping_payer as 'buyer' | 'seller',
    refundAgorot: Number(r.refund_agorot),
    partialOfferAgorot: r.partial_offer_agorot === null ? null : Number(r.partial_offer_agorot),
    returnedLines: r.returned_lines ?? null,
    trackingNumber: r.tracking_number,
    sellerNote: r.seller_note,
    adminNote: r.admin_note,
    createdAt: iso(r.created_at)!,
    approvedAt: iso(r.approved_at),
    sentAt: iso(r.sent_at),
    offeredAt: iso(r.offered_at),
    adminAwardAgorot: r.admin_award_agorot,
    deliveredBackAt: iso(r.delivered_back_at),
    settledAt: iso(r.closed_at),
    updatedAt: iso(r.updated_at)!,
  };
}

const SELECT = 'SELECT * FROM return_requests';

export async function getReturnRequest(id: string): Promise<ReturnRequest | null> {
  const r = await firstRow<Row>(`${SELECT} WHERE id = $1`, [id]);
  return r ? toRequest(r) : null;
}

/** Every request on one order, newest first — a buyer refused once may open another. */
export async function getReturnsForOrder(orderId: string): Promise<ReturnRequest[]> {
  return (await rows<Row>(`${SELECT} WHERE order_id = $1 ORDER BY created_at DESC`, [orderId])).map(toRequest);
}

/** The seller's tab: open cases first and oldest-first inside that, which is the order they must be
 *  worked in. Closed ones follow so a seller can see what happened without a second screen. */
export async function getReturnsForStore(storeSlug: string): Promise<ReturnRequest[]> {
  return (await rows<Row>(
    `${SELECT} WHERE store_slug = $1
      ORDER BY (status IN ('rejected','refunded','expired')) ASC, created_at ASC`,
    [storeSlug],
  )).map(toRequest);
}

/** The admin's queue: every OPEN case across the platform, longest-waiting first. */
export async function getOpenReturns(): Promise<ReturnRequest[]> {
  return (await rows<Row>(
    `${SELECT} WHERE ${openReturnSql()} ORDER BY created_at ASC`,
  )).map(toRequest);
}

/**
 * Cases that are FINISHED — the admin's history, paged and searchable over ALL of them.
 *
 * A decision he cannot look up is a decision he cannot defend, and the one somebody rings back about
 * is exactly the one a cap would have dropped (owner, 2026-08-17: "זה לא יכול פשוט להיעלם"). So this
 * counts and slices in the database rather than truncating in the caller — the same shape every other
 * admin list uses, for the same reason: the total is what tells him whether what he is looking at is
 * everything.
 *
 * `q` matches the order id's visible prefix, which is the string on every screen and the one a person
 * reads down the phone. Matched with LIKE on a lowercased prefix rather than a regex: it is a uuid,
 * so there is nothing to normalise and nothing a caller can inject through the parameter.
 */
export async function getClosedReturns(
  opts: { q?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: ReturnRequest[]; total: number; page: number; totalPages: number }> {
  const pageSize = Math.min(100, Math.max(5, Math.floor(opts.pageSize ?? 20)));
  // `%` and `_` are LIKE wildcards. Parameterised, so nothing can be injected — but an admin typing
  // `%` would match every row and read it as "these are the matches", which on a history screen is a
  // search box lying about what it found. Escaped with a backslash, declared to Postgres explicitly
  // so the behaviour does not depend on the server's default.
  const q = (opts.q ?? '').trim().toLowerCase().replace(/([%_\\])/g, '\\$1');
  const where = `status IN ('rejected','refunded','expired')${q ? " AND lower(order_id::text) LIKE $1 ESCAPE '\\\\'" : ''}`;
  const params = q ? [`${q}%`] : [];

  const counted = await firstRow<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM return_requests WHERE ${where}`, params);
  const total = counted?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), totalPages);

  const items = (await rows<Row>(
    `${SELECT} WHERE ${where}
      ORDER BY closed_at DESC NULLS LAST, created_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  )).map(toRequest);

  return { items, total, page, totalPages };
}

/** Does this order have a live case? What the buyer's button and the payout hold ask. */
export async function hasOpenReturn(orderId: string): Promise<boolean> {
  const r = await firstRow<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM return_requests
      WHERE order_id = $1 AND ${openReturnSql()}`,
    [orderId],
  );
  return (r?.n ?? 0) > 0;
}

/** The same question for a whole set, in ONE query — the payout run asks it per order and a query
 *  per order is a round trip per order (AI_INSTRUCTIONS → Scalability). */
export async function ordersWithOpenReturns(orderIds: string[]): Promise<Set<string>> {
  if (!orderIds.length) return new Set();
  const r = await rows<{ order_id: string }>(
    `SELECT DISTINCT order_id FROM return_requests
      WHERE order_id = ANY($1::uuid[]) AND ${openReturnSql()}`,
    [orderIds],
  );
  return new Set(r.map((x) => x.order_id));
}

export interface OpenReturnInput {
  order: Order;
  storeSlug: string;
  /** Whose shop this is. Optional only so a caller without it still creates the request — the
   *  notification is an announcement and must never be what decides whether a request exists. */
  sellerId?: string;
  storeName?: string;
  reason: ReturnReason;
  buyerNote?: string;
  buyerPhotoUrl?: string | null;
  /** Empty or absent = the whole order. */
  returnedLines?: ReturnedLine[] | null;
  todayISO?: string;
}

/**
 * Open a case.
 *
 * The two facts that must be decided HERE and then never recomputed are `within_statutory` and the
 * refund amount. Both are statements about the moment the buyer pressed the button: the window is
 * measured from delivery and the policy behind the amount can move, so a case re-deciding itself
 * later under a different rule is a case whose outcome depends on when somebody happened to look at
 * it (see the column's own note in migration 0030).
 *
 * The UNIQUE index does the refusing when a second case is opened on one order — asked of the
 * database rather than checked first, because "is there an open one" and "insert" as two statements
 * is a race two dashboard tabs can win.
 */
export async function openReturnRequest(input: OpenReturnInput): Promise<ReturnRequest | { error: string }> {
  const { order, storeSlug, reason } = input;
  const within = withinStatutoryWindow(order, input.todayISO);
  const status: ReturnStatus = autoApproved(within) ? 'approved' : 'requested';
  const id = crypto.randomUUID();

  try {
    const r = await firstRow<Row>(
      `INSERT INTO return_requests
         (id, order_id, store_slug, reason, buyer_note, buyer_photo_url, status,
          within_statutory, return_shipping_payer, refund_agorot, returned_lines, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $7 = 'approved' THEN now() ELSE NULL END)
       RETURNING *`,
      [id, order.id, storeSlug, reason, input.buyerNote ?? '', input.buyerPhotoUrl ?? null, status,
       within, returnShippingPayer(reason), refundForRequest(order, reason, input.returnedLines),
       isPartialReturn(input.returnedLines) ? JSON.stringify(input.returnedLines) : null],
    );
    const created = toRequest(r!);
    // The seller hears about it the moment it exists. Announced here rather than at the route so
    // every future opener — an admin acting for a buyer, a support tool — cannot forget to.
    if (input.sellerId) await notifySellerReturnOpened(input.sellerId, created, input.storeName);
    return created;
  } catch (err) {
    // 23505 = unique_violation, i.e. the partial index above. The honest answer to the buyer is that
    // they already have one open, not that something went wrong.
    if ((err as { code?: string }).code === '23505') {
      return { error: 'כבר קיימת בקשת החזרה פתוחה על ההזמנה הזאת' };
    }
    throw err;
  }
}

export interface MoveInput {
  id: string;
  to: ReturnStatus;
  /** Who moved it — a seller id, `'admin'`, or `'system'` for the scheduled sweeps. */
  actor: string;
  store: StatusChangeStore;
  trackingNumber?: string;
  sellerNote?: string;
  /**
   * Something the buyer adds later — how he sent it, or why he thinks the refusal is wrong.
   *
   * APPENDED, never assigned. `buyer_note` holds the complaint he opened the case with, and that
   * sentence is the evidence an admin reads first; replacing it with a later one would quietly delete
   * the reason the case exists.
   */
  buyerNote?: string;
  adminNote?: string;
  partialOfferAgorot?: number;
  /**
   * What the admin awards the buyer when closing a dispute — less than the full refund, when that is
   * the honest answer.
   *
   * A product that came back USED is neither "as sold" nor "never returned", and it is precisely the
   * case that reaches a person. Two buttons could only ever serve one side of it. Undefined, or the
   * full amount, keeps the ordinary whole-order path.
   */
  adminAwardAgorot?: number;
}

/**
 * Move a case, and settle whatever that move costs.
 *
 * Refuses through `canMove` rather than by trusting the caller: every route into this is a request
 * somebody made, and a state machine enforced at the UI is not enforced.
 *
 * **Only `refunded` touches the order**, and it does so through `settleStatusChange` — see this
 * file's header for why none of that logic may be repeated here.
 */
export async function moveReturnRequest(input: MoveInput): Promise<{ request: ReturnRequest } | { error: string }> {
  const current = await getReturnRequest(input.id);
  if (!current) return { error: 'בקשת ההחזרה לא נמצאה' };

  const allowed = canMove(current.status, input.to);
  if (!allowed.ok) return { error: allowed.reason };
  if (current.status === input.to) return { request: current };

  // Timestamps are set by the transition that earns them, so a clock can never be started by a
  // screen that merely displayed the case.
  const r = await firstRow<Row>(
    `UPDATE return_requests SET
       status = $2,
       tracking_number = COALESCE($3, tracking_number),
       seller_note = COALESCE($4, seller_note),
       admin_note = COALESCE($5, admin_note),
       partial_offer_agorot = COALESCE($6, partial_offer_agorot),
       admin_award_agorot = COALESCE($8, admin_award_agorot),
       -- Appended, so the sentence the buyer opened with survives. See MoveInput.buyerNote above.
       -- (No backticks in here: this is inside a template literal, and one ends the string.)
       -- Cast, and not for tidiness: every mention of $7 here is either an IS NULL or a concat, so
       -- Postgres has nothing to infer a type from and refuses to prepare the statement at all.
       buyer_note = CASE WHEN $7::text IS NULL THEN buyer_note
                         WHEN buyer_note = '' THEN $7::text
                         ELSE buyer_note || E'\n\n' || $7::text END,
       approved_at        = CASE WHEN $2 = 'approved'   AND approved_at        IS NULL THEN now() ELSE approved_at        END,
       -- Set by the transition that earns it, and never overwritten: a clock a later edit could
       -- restart is a clock that decides where money goes by accident.
       sent_at            = CASE WHEN $2 = 'in_transit' AND sent_at            IS NULL THEN now() ELSE sent_at            END,
       offered_at         = CASE WHEN $2 = 'offered'    AND offered_at         IS NULL THEN now() ELSE offered_at         END,
       delivered_back_at  = CASE WHEN $2 = 'received'   AND delivered_back_at  IS NULL THEN now() ELSE delivered_back_at  END,
       closed_at          = CASE WHEN $2 IN ('rejected','refunded','expired') THEN now() ELSE closed_at END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [input.id, input.to, input.trackingNumber ?? null, input.sellerNote ?? null,
     input.adminNote ?? null, input.partialOfferAgorot ?? null, input.buyerNote ?? null,
     input.adminAwardAgorot ?? null],
  );
  const moved = toRequest(r!);

  // ── An accepted OFFER: money moves, goods do not ──
  //
  // The buyer keeps the item, so there is no restock and no return postage — the only thing that
  // happens is a smaller refund. Settled through the same adjustment path a partial return uses,
  // for the same reason: the order was delivered and stays delivered, and a status describing the
  // whole order must not be used to record a discount on part of it.
  const acceptedOffer = input.to === 'refunded' && current.status === 'offered';

  // ── An admin awarding PART of a disputed case ──
  //
  // Same shape as an accepted offer and for the same reason: money moves, the goods do not move
  // again, and the order was delivered and stays delivered — so this must not run through
  // `settleStatusChange`, which would take the whole order out of every revenue figure to record a
  // correction to part of it. A full award is NOT this branch: it is an ordinary refund and takes the
  // ordinary path, because there the order really did come back whole.
  const partialAward = input.to === 'refunded'
    && current.status === 'disputed'
    && typeof input.adminAwardAgorot === 'number'
    && input.adminAwardAgorot < moved.refundAgorot;

  if (acceptedOffer || partialAward) {
    const order = await getOrderById(moved.orderId);
    const amount = partialAward ? input.adminAwardAgorot! : (moved.partialOfferAgorot ?? 0);
    if (order && amount > 0) {
      await recordMoneyEvent({
        type: 'refund_due',
        orderId: order.id,
        checkoutRef: order.checkoutRef,
        storeSlug: input.store.slug,
        amountAgorot: amount,
        actor: input.actor,
        detail: partialAward
          ? 'החזר חלקי בהכרעת הפלטפורמה. הסכום מגיע לקונה ועדיין לא הוחזר.'
          : 'החזר חלקי בהסכמה — הקונה שומר את המוצר. הסכום מגיע לו ועדיין לא הוחזר.',
      });
      const seller = await getSellerById(input.store.sellerId);
      const commission = commissionOnAgorot(amount, commissionPercentForTier(seller?.tier));
      const sellerShare = amount - commission;
      if (sellerShare > 0) {
        await recordAdjustment({
          sellerId: input.store.sellerId,
          orderId: order.id,
          kind: 'refund_clawback',
          amountAgorot: -sellerShare,
          detail: `${partialAward ? 'החזר חלקי בהכרעת הפלטפורמה' : 'החזר חלקי בהסכמה'} בהזמנה ${order.id.slice(0, 8)}`,
          returnRequestId: moved.id,
        });
      }
    }
  } else if (input.to === 'refunded' && isPartialReturn(moved.returnedLines)) {
    // ── A partial return settles WITHOUT touching the order (decisions §4) ──
    //
    // The order was delivered and most of it stayed delivered, so its status is still the truth. Using
    // `returned` to describe a fraction of it would be the same conflation §0 exists to prevent, one
    // level down — and it would take the whole order out of every revenue sum to give back a third of
    // it, rewriting financial history to record a correction.
    //
    // So the money moves in its own row, which is what `seller_ledger_adjustments` is for and what
    // already settles a chargeback: the buyer's debt is journalled, the seller's share of exactly
    // those lines is deducted from his next payout, and the order keeps saying what happened.
    const order = await getOrderById(moved.orderId);
    if (order) {
      await recordMoneyEvent({
        type: 'refund_due',
        orderId: order.id,
        checkoutRef: order.checkoutRef,
        storeSlug: input.store.slug,
        amountAgorot: moved.refundAgorot,
        actor: input.actor,
        detail: `החזרה חלקית — ${moved.returnedLines!.length} שורות מתוך ${order.items.length}. הסכום מגיע בחזרה לקונה ועדיין לא הוחזר.`,
      });

      // The seller's share of the returned lines only — his commission on them was never earned, so
      // it is not clawed back separately (the same reasoning `recordSellerClawback` records).
      const seller = await getSellerById(input.store.sellerId);
      const commission = commissionOnAgorot(moved.refundAgorot, commissionPercentForTier(seller?.tier));
      const sellerShare = moved.refundAgorot - commission;
      if (sellerShare > 0) {
        await recordAdjustment({
          sellerId: input.store.sellerId,
          orderId: order.id,
          kind: 'refund_clawback',
          amountAgorot: -sellerShare,
          detail: `החזרה חלקית בהזמנה ${order.id.slice(0, 8)}`,
          // Keyed on the REQUEST: one order may be partially returned more than once, and a second
          // debit keyed on the order would be dropped as a duplicate (migration 0032).
          returnRequestId: moved.id,
        });
      }

      // Only the lines that came back. `restockProduct` is the same call a whole-order return makes,
      // so a returned variant lands in the bucket it was sold from.
      for (const line of moved.returnedLines!) {
        const item = order.items[line.position];
        if (!item) continue;
        const qty = Math.max(0, Math.min(Math.floor(line.qty), item.qty));
        if (qty > 0) await restockProduct(item.productId, qty, item.selectedVariants);
      }
    }
  } else if (input.to === 'refunded') {
    const before = await getOrderById(moved.orderId);
    // Asked of the ORDER's own table before touching it, not merely of this request's state machine.
    // Two machines guard two different things — this one says a case may be refunded, that one says
    // an order may become `returned` — and only the second knows anything about the order.
    //
    // **What this does NOT prevent, stated because the first version of this comment claimed it
    // did:** a double restock. `settleStatusChange` already tests `orderHoldsStock(before)` as well
    // as the after status, so an order that has already released its units cannot release them
    // twice, and `createsRefundObligation` likewise needs the BEFORE state to have counted as
    // revenue, so no second debt is written either. Both were checked against the code rather than
    // assumed, and the test below passes with this guard removed — it is a regression pin, not a
    // bug fix.
    //
    // What it does prevent is a terminal order being moved at all: a journal row saying a cancelled
    // order became returned, an order status rewritten out from under whatever made it terminal, and
    // the buyer notified twice. `canTransition` refuses exactly that and says why in its own header
    // ("a 200 on a repeat cancel is an invitation to whatever runs downstream of one"). Reaching it
    // needs the order to change status behind an open request's back, which nothing today does.
    if (before && canTransition(before.shippingStatus, 'returned').ok) {
      const after = await updateOrder(moved.orderId, { shippingStatus: 'returned' });
      if (after) {
        await settleStatusChange({
          before, after, store: input.store, actor: input.actor,
          // Both halves of this line are what a PERSON reads, in the admin's money journal, and both
          // were machine values: the raw enum ('changed_mind') and the raw agorot ('12500 אגורות')
          // — a five-figure number beside Hebrew prose, in the one screen whose whole job is to be
          // believed (owner, 2026-08-20: "המספרים שמוצגים לי לפעמים מוצגים שם באגורות"). Amounts on
          // any surface go through `money.ts#formatAgorot`, never through the integer itself.
          detail: `החזרה ${moved.id.slice(0, 8)} · סיבה: ${RETURN_REASON_LABELS[moved.reason]} · זיכוי ${formatAgorot(moved.refundAgorot)}`,
        });
      }
    }
  }

  // The buyer hears about approval, refusal and the credit — and about nothing else (decisions §7).
  // `notifyBuyerReturnStatus` decides which of those this is; calling it unconditionally is what
  // keeps that list in ONE place instead of at every call site that moves a request.
  const order = await getOrderById(moved.orderId);
  if (order) await notifyBuyerReturnStatus(moved, order, input.store.name);

  return { request: moved };
}

/** Counts for the seller's tab badge and the admin's. Open cases only — a closed one is not a task. */
export async function countOpenReturns(storeSlug?: string): Promise<number> {
  const r = await firstRow<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM return_requests
      WHERE ${openReturnSql()}${storeSlug ? ' AND store_slug = $1' : ''}`,
    storeSlug ? [storeSlug] : [],
  );
  return r?.n ?? 0;
}

/**
 * The dates on the ORDER behind a return — for a whole list of them, in one query.
 *
 * **Why the returns card needs them (owner, 2026-08-20): *"לא ברור מהכרטיסיות בעצם מה קרה, מתי
 * ההזמנה בוצעה, איזו הזמנה? מתי שולם?"*.** The card carried one date and labelled it with the order
 * number beside it, so `הזמנה 4cb3f442 · 04.08.26` read as the day the order was placed. It is the
 * day the REQUEST was opened, which is a different fact and the least useful of the three: the
 * question a seller is actually answering is how long the buyer has had the goods.
 *
 * Three columns and nothing else, deliberately. Hydrating the whole `Order` would pull every line
 * item and every per-store subtotal for a list that shows none of them; a return card that wanted
 * the money already has `refund_agorot` on the request itself, computed when the case opened and
 * therefore right even if the order has been edited since.
 */
export interface ReturnOrderFacts {
  placedAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  /** The lines of this order that belong to the store the case is against, in receipt order.
   *  `position` is what `returned_lines` names on a partial (migration 0031), so it is carried
   *  rather than dropped — it is the only thing that says WHICH item is coming back. */
  items: { position: number; name: string; qty: number }[];
}

export async function getOrderFactsForReturns(
  orderIds: string[],
  /** The store whose lines to carry. A multi-store order holds other shops' items too, and a seller
   *  reading his own return card must not be shown them (the `scopeOrder` rule, one screen over). */
  storeSlug: string,
): Promise<Map<string, ReturnOrderFacts>> {
  if (!orderIds.length) return new Map();
  const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
  // Two reads, one round trip: the dates are one row per order and the lines are several, so a
  // single join would repeat every date per item for a caller that wants them once.
  const [orderRows, itemRows] = await Promise.all([
    rows<{ id: string; created_at: Date | string; paid_at: Date | string | null; delivered_at: Date | string | null }>(
      'SELECT id, created_at, paid_at, delivered_at FROM orders WHERE id = ANY($1::uuid[])',
      [orderIds],
    ),
    rows<{ order_id: string; position: number; product_name: string; qty: number }>(
      `SELECT order_id, position, product_name, qty FROM order_items
        WHERE order_id = ANY($1::uuid[]) AND store_slug = $2
        ORDER BY order_id, position`,
      [orderIds, storeSlug],
    ),
  ]);
  const itemsByOrder = new Map<string, ReturnOrderFacts['items']>();
  for (const it of itemRows) {
    const list = itemsByOrder.get(it.order_id) ?? [];
    list.push({ position: Number(it.position), name: it.product_name, qty: Number(it.qty) });
    itemsByOrder.set(it.order_id, list);
  }
  return new Map(orderRows.map((row) => [row.id, {
    placedAt: iso(row.created_at)!,
    paidAt: iso(row.paid_at),
    deliveredAt: iso(row.delivered_at),
    items: itemsByOrder.get(row.id) ?? [],
  }]));
}

/**
 * The latest request per order, for a list of orders — ONE query.
 *
 * The buyer's dashboard renders a page of orders and needs to know, for each, whether a return is
 * already under way. Asking per order is a round trip per order on a page that already has its ids
 * in hand (AI_INSTRUCTIONS → Scalability), and `DISTINCT ON` lets Postgres pick the newest per order
 * in the same pass rather than making the caller sort.
 *
 * The NEWEST, not the open one: a buyer refused once may open another, and the row that answers
 * "what is happening with my return" is always the most recent — including when it is closed, which
 * is exactly when the screen has to say why.
 */
export async function getLatestReturnsByOrder(
  orderIds: string[],
  /**
   * Narrow to ONE store's cases.
   *
   * An order can span several stores (`order_stores`, one row each), and a return belongs to exactly
   * one of those slices — which is what `store_slug` on this table is for. Unscoped, a seller whose
   * cart-mate had a return would see "בתהליך החזרה" on his own slice of that order: not a leak of
   * anybody's data, but a claim about his goods that is simply untrue, and one he cannot act on. The
   * SELLER's dashboard passes its slug; the buyer's and the admin's do not, because both are asking
   * about the whole purchase.
   */
  storeSlug?: string,
): Promise<Map<string, ReturnRequest>> {
  if (!orderIds.length) return new Map();
  const r = await rows<Row>(
    `SELECT DISTINCT ON (order_id) * FROM return_requests
      WHERE order_id = ANY($1::uuid[])${storeSlug ? ' AND store_slug = $2' : ''}
      ORDER BY order_id, created_at DESC`,
    storeSlug ? [orderIds, storeSlug] : [orderIds],
  );
  return new Map(r.map((row) => [row.order_id, toRequest(row)]));
}

