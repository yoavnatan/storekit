import { rows, firstRow } from './db.js';
import type { Order } from './orders.js';
import { countsAsRevenue } from './orders.js';
import { REVENUE_PAYMENT_STATUSES, REVENUE_SHIPPING_STATUSES } from './order-status-rules.js';
import { getPlatformOrderTotals, getStoreRevenueBySlug } from './order-reporting.js';
import { orderNetForStore, orderNetTotal, getStoreRevenueMap, getOrderTotals } from './admin-stats.js';

/**
 * Computes the same figures TWICE, by deliberately different routes, and reports
 * where the two answers disagree.
 *
 * This is the one technique on this list that does not need anybody to have
 * imagined the bug first. An invariant still asks a person to name a property; a
 * reconciliation only asks "does the other way of counting agree?", and it keeps
 * asking on live data forever. It is what accountants have always done, and it is
 * why they find errors nobody predicted.
 *
 * The rule that makes it work: the two paths must NOT share the step being checked.
 * Summing an order's stored total twice proves nothing. Summing line items on one
 * side and stored subtotals on the other proves they agree — and if they ever stop
 * agreeing, something wrote one without the other.
 *
 * Every check here is deliberately cheap and read-only, so it can run on demand from
 * the admin panel over the real data rather than only in a test over fixtures. Tests
 * prove the code was right when it was written; this proves the DATA is right now.
 */

export type DiscrepancySeverity = 'error' | 'warning';

export interface Discrepancy {
  severity: DiscrepancySeverity;
  /** What was being compared, in the owner's words. */
  check: string;
  /** Which order/store it concerns, when it is localised to one. */
  subject?: string;
  /** All three are integer agorot, like everything else in the money pipeline (orders.ts).
   *  The panel that renders a discrepancy formats them with `money.ts#formatAgorot`. */
  expected: number;
  actual: number;
  /** expected − actual. The size of the problem. */
  drift: number;
  /** What it means and what to do — this is read by someone who did not write it. */
  explanation: string;
}

export interface ReconciliationReport {
  checkedOrders: number;
  discrepancies: Discrepancy[];
  /** Nothing disagreed. The number an owner actually wants to see. */
  clean: boolean;
  /** Set when the per-row checks hit their cap, so "12 problems" is never read as "and that is
   *  all of them". A systemic bug makes every order disagree, and a banner that quietly showed
   *  the first fifty would understate the one situation it exists to shout about. */
  truncated?: boolean;
}

/** How many per-row discrepancies one run will list. A reader cannot act on more than a screenful,
 *  and the count above it says how bad it really is. */
const MAX_ROW_DISCREPANCIES = 50;

/**
 * How long an order may sit at `payment_status = 'pending'` before it is a problem rather than a
 * checkout in flight.
 *
 * The whole handler — authorize, write the rows, capture — completes in well under a second, so
 * anything still pending after this did not finish. Fifteen minutes rather than one so that a
 * genuinely slow gateway, a retry, or a clock a little out of step cannot manufacture a false alarm
 * on the admin's dashboard; the state it reports is permanent, so nothing is lost by waiting.
 */
export const STUCK_PENDING_MINUTES = 15;

function drift(expected: number, actual: number): number {
  return expected - actual;
}

/**
 * Every finding this module can produce, as one builder each.
 *
 * They exist as functions because the checks run by two routes now — over an order array, and as
 * queries (`reconcilePlatform`) — and a discrepancy the owner reads must not depend on which one
 * found it. The wording, the severity and the sign of the drift are stated once.
 */
const shortId = (id: string): string => id.slice(0, 8);

function itemsVsSubtotalDiscrepancy(orderId: string, slug: string, fromItems: number, subtotal: number): Discrepancy {
  // These are written by different code at different times: the items at checkout, the subtotal
  // again on every seller edit of the order. A mismatch means one was updated without the other,
  // and the seller's product breakdown will never add up to their revenue.
  return {
    severity: 'error',
    check: 'שורות ההזמנה מול הסכום השמור',
    subject: `הזמנה ${shortId(orderId)} · ${slug}`,
    expected: fromItems,
    actual: subtotal,
    drift: drift(fromItems, subtotal),
    explanation: 'סכום שורות המוצרים לא שווה לסכום החנות השמור על ההזמנה. אחד מהם עודכן בלי השני — הפירוט למוכר לא יסתדר מול ההכנסה.',
  };
}

function totalVsPartsDiscrepancy(orderId: string, fromParts: number, total: number): Discrepancy {
  // The stored total is what the buyer was charged and what the confirmation email shows. If it
  // drifts from the parts, the buyer and the seller are reading two different numbers.
  return {
    severity: 'error',
    check: 'סכום ההזמנה מול מרכיביו',
    subject: `הזמנה ${shortId(orderId)}`,
    expected: fromParts,
    actual: total,
    drift: drift(fromParts, total),
    explanation: 'הסכום הכולל של ההזמנה לא שווה ל(סכום נטו + משלוח). הקונה חויב בסכום אחד והדוחות מציגים אחר.',
  };
}

function gmvVsRows(rowSum: number, gmv: number): Discrepancy {
  // Two routes, one concept. This is the check that would have caught the old Overview card
  // summing the stored total while the Stores tab summed net subtotals.
  return {
    severity: 'error',
    check: 'מחזור הפלטפורמה מול סכום החנויות',
    expected: rowSum,
    actual: gmv,
    drift: drift(rowSum, gmv),
    explanation: 'הכותרת בלשונית "סקירה" לא שווה לסכום שורות החנויות. שני המספרים מתארים את אותו דבר ומחושבים בשני מקומות — אחד מהם השתנה.',
  };
}

function byStoreVsByOrder(byOrder: number, byStore: number, orphans: string[]): Discrepancy {
  // Catches an order whose storeSubtotals hold a slug outside the known set — the shape a store
  // rename leaves behind if the repointing missed a row, which would make that money vanish from
  // every per-store view while still counting in GMV.
  //
  // **Under the agent model this stopped being a reporting problem and became a payment one**
  // (2026-08-10). The payout run reaches a seller by joining `order_stores.store_slug` to
  // `stores.slug`, exactly as the per-store views do — so a slug no store answers to is money the
  // platform is holding for a seller that no run will ever pay out, silently and indefinitely.
  // The check was already here and already `error`; what changed is what it is warning about, and
  // the explanation below now says so rather than describing a missing dashboard row.
  return {
    severity: 'error',
    check: 'הכנסות לפי חנות מול הכנסות לפי הזמנה',
    expected: byOrder,
    actual: byStore,
    drift: drift(byOrder, byStore),
    explanation: orphans.length
      ? `יש הזמנות ששייכות לחנויות שלא קיימות ברשימה: ${orphans.join(', ')}. הכסף הזה נספר במחזור הכללי, לא מופיע באף חנות — ו**לא ישולם לאף מוכר**, כי התשלום המרוכז מאתר את המוכר לפי אותה כתובת חנות. כנראה שינוי כתובת חנות שלא עודכן בכל ההזמנות.`
      : 'סכום ההכנסות לפי חנות לא שווה לסכום לפי הזמנה, בלי חנות יתומה מזוהה. צריך בדיקה ידנית.',
  };
}

function negativeTotal(orderId: string, total: number): Discrepancy {
  return {
    severity: 'error',
    check: 'סכום שלילי',
    subject: `הזמנה ${shortId(orderId)}`,
    expected: 0,
    actual: total,
    drift: drift(0, total),
    explanation: 'הזמנה עם סכום שלילי. הנחה שגדולה מהסכום, או עריכה שהורידה פריטים בלי לעדכן את ההנחה.',
  };
}

/**
 * ── The second family of checks: the ORDERS against the MONEY JOURNAL ──
 *
 * Everything above compares two views of the same order rows. That catches arithmetic that drifted;
 * it cannot catch money that moved with nothing to show for it, because both of its routes read the
 * same table. The journal (`money-events.ts`) is the independent record — written by the code that
 * touched the gateway, at the moment it touched it — so comparing the two is the only check here
 * that can answer the question this area was audited for: **where can the money and what a seller or
 * buyer SEES disagree?**
 *
 * Each of the three below is one answer to it, and each was reachable before it existed.
 */

/**
 * The three checks above that only the QUERY route can run, by their `check` label.
 *
 * They read `money_events`, and `reconcileOrders` is handed orders and nothing else — so this is not
 * a gap between the two routes, it is the boundary of what a pure function over orders can know.
 * Exported because `tests/reporting-invariants.test.ts` runs the two side by side and requires the
 * same verdict: without naming the difference, that test would either fail forever or would have to
 * be loosened into proving nothing.
 */
export const JOURNAL_ONLY_CHECKS: readonly string[] = [
  'זיכוי שמגיע לקונה ולא בוצע',
  'הזמנה תקועה בהמתנה לתשלום',
  'חיוב ביומן בלי הזמנה מאחוריו',
];

function refundOwedOutstanding(orderId: string, slug: string | null, amount: number, sinceDays: number): Discrepancy {
  return {
    severity: 'error',
    check: JOURNAL_ONLY_CHECKS[0]!,
    subject: `הזמנה ${shortId(orderId)}${slug ? ` · ${slug}` : ''}`,
    expected: 0,
    actual: amount,
    drift: drift(0, amount),
    explanation: `ההזמנה בוטלה אחרי שהתשלום כבר נגבה, כך שהכסף הזה שייך לקונה ועדיין לא הוחזר${sinceDays > 0 ? ` (${sinceDays} ימים)` : ''}. אין עדיין ספק סליקה מחובר, ולכן ההחזר הוא פעולה ידנית — ראו GO_LIVE_CHECKLIST §3.`,
  };
}

function stuckPending(orderId: string, amount: number, minutes: number): Discrepancy {
  // The checkout writes order rows as 'pending' and flips them to 'paid' only after the capture
  // (payment.ts). A row that never flipped means the process died in that window, or `markOrdersPaid`
  // itself threw after the money had been taken. Either way the stock is off the shelf, the seller
  // has nothing to ship, no notification fired, and — if the capture had in fact succeeded — a real
  // buyer paid for an order nobody will ever act on.
  return {
    severity: 'error',
    check: JOURNAL_ONLY_CHECKS[1]!,
    subject: `הזמנה ${shortId(orderId)}`,
    expected: 0,
    actual: amount,
    drift: drift(0, amount),
    explanation: `ההזמנה נוצרה לפני ${minutes} דקות ועדיין "ממתין לתשלום". החיוב לא הושלם ולא בוטל: המלאי ירד, המוכר לא קיבל התראה, והקונה לא יודע. צריך לבדוק מול ספק הסליקה אם נתפס כסף לפי האסמכתא שביומן.`,
  };
}

function chargeWithNoOrder(checkoutRef: string, amount: number): Discrepancy {
  // The 0017 class, as a live check rather than as a story. An authorization in the journal whose
  // checkout produced no order row and was never voided is money held (or taken) for a purchase that
  // does not exist — which is exactly the state the UNIQUE constraint on payment_ref used to create
  // on every multi-store cart.
  return {
    severity: 'error',
    check: JOURNAL_ONLY_CHECKS[2]!,
    subject: `אסמכתא ${checkoutRef}`,
    expected: 0,
    actual: amount,
    drift: drift(0, amount),
    explanation: 'ביומן יש אישור חיוב לאסמכתא שלא נוצרה עבורה אף הזמנה, וגם לא נרשם ביטול חיוב. ייתכן שנתפס כסף על כרטיס של קונה בלי שום הזמנה מאחוריו — צריך לבדוק מול ספק הסליקה.',
  };
}

function oversizedDiscount(orderId: string, slug: string, subtotal: number, applied: number): Discrepancy {
  // Ceiling is the SUBTOTAL, not subtotal + shipping: the seller discounts their own goods, never
  // the platform's shipping rate. A row above this ceiling was written before that rule existed,
  // and it is the shape that produced negative store revenue (`orderNetForStore` floors it at
  // zero, so without this check the bad row would simply vanish instead of being reported).
  return {
    severity: 'warning',
    check: 'הנחה גדולה מסכום המוצרים',
    subject: `הזמנה ${shortId(orderId)} · ${slug}`,
    expected: subtotal,
    actual: applied,
    drift: drift(subtotal, applied),
    explanation: 'ההנחה גדולה מסכום המוצרים בהזמנה — כנראה הנחה שחושבה גם על דמי המשלוח. ההכנסה מהחנות הזו מוצגת כאפס במקום כשלילית, אבל השורה עצמה שגויה.',
  };
}

/**
 * ⚠️ **The checks below now compare integers for exact equality, and that is a REAL change of
 * meaning, not just a change of unit.** In the ILS era every side of every comparison went through
 * `roundMoney` first, because two float routes to the same amount land a hair apart
 * (`19.99*3 = 59.97000000000001`) and a raw `!==` would have reported a discrepancy on every
 * healthy order. Rounding both sides to agorot hid that — and hid, along with it, any genuine
 * disagreement smaller than half an agora. Both sides are integer agorot now, so `!==` means the
 * two routes really did produce different numbers. This module reports MORE than it used to, and
 * everything extra it reports is real.
 */

/**
 * Run every cross-check over a set of orders.
 *
 * `storeSlugs` scopes the per-store reconciliation; pass the platform's stores for
 * the admin view, or one slug for a single seller.
 */
export function reconcileOrders(orders: Order[], storeSlugs: string[]): ReconciliationReport {
  const discrepancies: Discrepancy[] = [];

  for (const o of orders) {
    // ── Route A: the line items. Route B: the stored subtotal. ──────────────
    for (const [slug, sub] of Object.entries(o.storeSubtotals ?? {})) {
      const fromItems = o.items.filter((i) => i.storeSlug === slug).reduce((s, i) => s + i.priceAgorot * i.qty, 0);
      if (fromItems !== sub.subtotalAgorot) {
        discrepancies.push(itemsVsSubtotalDiscrepancy(o.id, slug, fromItems, sub.subtotalAgorot));
      }
    }

    // ── Route A: net + shipping, per store. Route B: the stored total. ────────
    const fromParts = Object.entries(o.storeSubtotals ?? {})
      .reduce((s, [slug, sub]) => s + orderNetForStore(o, slug) + sub.shippingAgorot, 0);
    if (fromParts !== o.totalAgorot) {
      discrepancies.push(totalVsPartsDiscrepancy(o.id, fromParts, o.totalAgorot));
    }
  }

  // ── Route A: the platform headline. Route B: the per-store rows. ───────────
  const gmv = getOrderTotals(orders).gmvAgorot;
  // '' as the month: this check is about the ALL-TIME column, and the month column plays no part
  // in it. Passing a real month would make the assertion depend on when it was run.
  const rowSum = [...getStoreRevenueMap(orders, '').values()].reduce((a, r) => a + r.totalRevenueAgorot, 0);
  if (rowSum !== gmv) {
    discrepancies.push(gmvVsRows(rowSum, gmv));
  }

  // ── Route A: sum per store. Route B: sum per order. ────────────────────────
  const known = new Set(storeSlugs);
  const paid = orders.filter(countsAsRevenue);
  const byStore = paid.reduce((a, o) => a + storeSlugs.reduce((s, slug) => s + orderNetForStore(o, slug), 0), 0);
  const byOrder = paid.reduce((a, o) => a + orderNetTotal(o), 0);
  if (storeSlugs.length > 0 && byStore !== byOrder) {
    const orphans = [...new Set(paid.flatMap((o) => Object.keys(o.storeSubtotals ?? {})).filter((s) => !known.has(s)))];
    discrepancies.push(byStoreVsByOrder(byOrder, byStore, orphans));
  }

  // ── Sanity bounds. Not a cross-check, but the same idea: a figure that is
  //    impossible is worth catching before anyone reasons from it. ─────────────
  for (const o of orders) {
    if (o.totalAgorot < 0) discrepancies.push(negativeTotal(o.id, o.totalAgorot));
    for (const [slug, sub] of Object.entries(o.storeSubtotals ?? {})) {
      const applied = sub.discount?.appliedAgorot ?? 0;
      if (applied > sub.subtotalAgorot) {
        discrepancies.push(oversizedDiscount(o.id, slug, sub.subtotalAgorot, applied));
      }
    }
  }

  return { checkedOrders: orders.length, discrepancies, clean: discrepancies.length === 0 };
}

// ── The same checks, as queries ──────────────────────────────────────────────

/**
 * `reconcileOrders` for the WHOLE platform, without reading the whole platform (§3, 2026-08-03).
 *
 * Every check above is a comparison of two computed columns, which is a thing a database is better
 * at than a `for` loop — and, crucially, one it answers by returning only the rows that DISAGREE.
 * The admin dashboard ran the JS version over every order on every render; this returns a handful
 * of rows, or none, whatever the platform's size.
 *
 * **The pure version stays and is not dead code.** It is the definition these statements are
 * written from, `tests/reporting-fuzz.test.ts` drives it over generated damage that no fixture
 * holds, and `tests/reporting-invariants.test.ts` runs the two side by side and requires the same
 * verdict. A reconciler is worth nothing if its two halves can drift.
 *
 * The one check that changed SHAPE rather than language is the platform-headline one. In JS the
 * two routes were two modules; here they are two queries — the ungrouped aggregate
 * (`getPlatformOrderTotals`) against the sum of the grouped one (`getStoreRevenueBySlug`). They
 * read the same rows through different plans, which is the property the check needs.
 */
export async function reconcilePlatform(storeSlugs: string[]): Promise<ReconciliationReport> {
  const revenueScope = [REVENUE_PAYMENT_STATUSES, REVENUE_SHIPPING_STATUSES] as const;
  const NET = 'GREATEST(os.subtotal_agorot - os.discount_applied_agorot, 0)';
  const COUNTS = 'o.payment_status = ANY($1::text[]) AND o.shipping_status = ANY($2::text[])';

  const [
    checked, itemsVsSubtotal, totalVsParts, bounds, byRoute, orphans, totals, byStore,
    refundsOwed, stuck, orphanCharges,
  ] = await Promise.all([
    firstRow<{ n: string | number }>('SELECT COUNT(*) AS n FROM orders'),

    // Route A: the line items. Route B: the stored subtotal.
    rows<{ id: string; store_slug: string; from_items: string | number; subtotal: string | number }>(
      `SELECT o.id, os.store_slug,
              COALESCE((SELECT SUM(it.price_agorot * it.qty) FROM order_items it
                         WHERE it.order_id = o.id AND it.store_slug = os.store_slug), 0) AS from_items,
              os.subtotal_agorot AS subtotal
         FROM order_stores os
         JOIN orders o ON o.id = os.order_id
        WHERE COALESCE((SELECT SUM(it.price_agorot * it.qty) FROM order_items it
                         WHERE it.order_id = o.id AND it.store_slug = os.store_slug), 0) <> os.subtotal_agorot
        ORDER BY o.created_at DESC, o.id
        LIMIT ${MAX_ROW_DISCREPANCIES + 1}`,
    ),

    // Route A: net + shipping, per store. Route B: the stored total.
    rows<{ id: string; from_parts: string | number; total: string | number }>(
      `SELECT o.id, parts.amount AS from_parts, o.total_agorot AS total
         FROM orders o
         JOIN LATERAL (
           SELECT COALESCE(SUM(${NET} + os.shipping_agorot), 0) AS amount
             FROM order_stores os WHERE os.order_id = o.id
         ) parts ON true
        WHERE parts.amount <> o.total_agorot
        ORDER BY o.created_at DESC, o.id
        LIMIT ${MAX_ROW_DISCREPANCIES + 1}`,
    ),

    // Sanity bounds — a negative total, and a discount bigger than what it discounts. The columns
    // carry CHECK constraints for both today, so a hit here means a constraint was dropped or the
    // rows predate it. That is exactly why the check stays: it costs nothing and it is the only
    // thing that would say so.
    rows<{ id: string; store_slug: string | null; kind: string; expected: string | number; actual: string | number }>(
      `SELECT id, NULL::text AS store_slug, 'negative' AS kind, 0 AS expected, total_agorot AS actual
         FROM orders WHERE total_agorot < 0
        UNION ALL
       SELECT os.order_id AS id, os.store_slug, 'discount' AS kind,
              os.subtotal_agorot AS expected, os.discount_applied_agorot AS actual
         FROM order_stores os WHERE os.discount_applied_agorot > os.subtotal_agorot
        LIMIT ${MAX_ROW_DISCREPANCIES + 1}`,
    ),

    // Route A: sum per known store. Route B: sum per order, every slug it names.
    firstRow<{ by_store: string | number; by_order: string | number }>(
      `SELECT COALESCE(SUM(${NET}) FILTER (WHERE os.store_slug = ANY($3::text[])), 0) AS by_store,
              COALESCE(SUM(${NET}), 0)                                               AS by_order
         FROM order_stores os
         JOIN orders o ON o.id = os.order_id
        WHERE ${COUNTS}`,
      [...revenueScope, storeSlugs],
    ),

    rows<{ store_slug: string }>(
      `SELECT DISTINCT os.store_slug
         FROM order_stores os
         JOIN orders o ON o.id = os.order_id
        WHERE ${COUNTS} AND NOT (os.store_slug = ANY($3::text[]))`,
      [...revenueScope, storeSlugs],
    ),

    getPlatformOrderTotals(),
    getStoreRevenueBySlug(''),

    // ── Journal route 1: refunds owed and never settled. ──
    // A `refund_due` with no `refund_settled` for the same order. Both are journal rows and the
    // journal is append-only, so "settled" can only ever be a row someone wrote — it cannot be
    // inferred, and it cannot quietly close itself.
    rows<{ order_id: string; store_slug: string | null; amount: string | number; days: string | number }>(
      `SELECT d.order_id, d.store_slug, d.amount_agorot AS amount,
              EXTRACT(day FROM now() - d.at)::int AS days
         FROM money_events d
        WHERE d.type = 'refund_due'
          AND NOT EXISTS (
                SELECT 1 FROM money_events s
                 WHERE s.type = 'refund_settled' AND s.order_id = d.order_id AND s.at >= d.at)
        ORDER BY d.at DESC
        LIMIT ${MAX_ROW_DISCREPANCIES + 1}`,
    ),

    // ── Journal route 2: orders stuck between the order write and the capture. ──
    // `STUCK_PENDING_MINUTES` past creation is long enough that no live checkout is still in flight
    // — the whole handler runs in under a second — so anything left here is a request that died.
    rows<{ id: string; total: string | number; minutes: string | number }>(
      `SELECT id, total_agorot AS total,
              EXTRACT(epoch FROM now() - created_at)::int / 60 AS minutes
         FROM orders
        WHERE payment_status = 'pending'
          AND created_at < now() - ($1::int * interval '1 minute')
        ORDER BY created_at DESC
        LIMIT ${MAX_ROW_DISCREPANCIES + 1}`,
      [STUCK_PENDING_MINUTES],
    ),

    // ── Journal route 3: an authorization with no order behind it. ──
    // Matched on `checkout_ref`, which is the only thing tying a charge to the orders it was for
    // before any order row exists — which is the entire point of the window this checks.
    rows<{ checkout_ref: string; amount: string | number }>(
      `SELECT a.checkout_ref, MAX(a.amount_agorot) AS amount
         FROM money_events a
        WHERE a.type = 'payment_attempted'
          AND a.checkout_ref IS NOT NULL
          AND a.detail LIKE 'authorized%'
          AND a.at < now() - ($1::int * interval '1 minute')
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.checkout_ref = a.checkout_ref)
          AND NOT EXISTS (
                SELECT 1 FROM money_events v
                 WHERE v.checkout_ref = a.checkout_ref AND v.type = 'charge_voided')
        GROUP BY a.checkout_ref
        ORDER BY MAX(a.at) DESC
        LIMIT ${MAX_ROW_DISCREPANCIES + 1}`,
      [STUCK_PENDING_MINUTES],
    ),
  ]);

  const n = (v: string | number | null | undefined): number => Number(v ?? 0);
  const discrepancies: Discrepancy[] = [];

  for (const r of itemsVsSubtotal.slice(0, MAX_ROW_DISCREPANCIES)) {
    discrepancies.push(itemsVsSubtotalDiscrepancy(r.id, r.store_slug, n(r.from_items), n(r.subtotal)));
  }
  for (const r of totalVsParts.slice(0, MAX_ROW_DISCREPANCIES)) {
    discrepancies.push(totalVsPartsDiscrepancy(r.id, n(r.from_parts), n(r.total)));
  }

  const rowSum = [...byStore.values()].reduce((a, r) => a + r.totalRevenueAgorot, 0);
  if (rowSum !== totals.gmvAgorot) discrepancies.push(gmvVsRows(rowSum, totals.gmvAgorot));

  if (storeSlugs.length > 0 && n(byRoute?.by_store) !== n(byRoute?.by_order)) {
    discrepancies.push(byStoreVsByOrder(n(byRoute?.by_order), n(byRoute?.by_store), orphans.map((o) => o.store_slug)));
  }

  for (const r of bounds.slice(0, MAX_ROW_DISCREPANCIES)) {
    discrepancies.push(r.kind === 'negative'
      ? negativeTotal(r.id, n(r.actual))
      : oversizedDiscount(r.id, r.store_slug ?? '', n(r.expected), n(r.actual)));
  }

  // The journal routes. Listed after the arithmetic ones because they are rarer, and because a
  // reader scanning this card is reading the first line: an order that disagrees with itself is a
  // reporting bug, while an unsettled refund is a person who is owed money today.
  for (const r of refundsOwed.slice(0, MAX_ROW_DISCREPANCIES)) {
    discrepancies.push(refundOwedOutstanding(r.order_id, r.store_slug, n(r.amount), n(r.days)));
  }
  for (const r of stuck.slice(0, MAX_ROW_DISCREPANCIES)) {
    discrepancies.push(stuckPending(r.id, n(r.total), n(r.minutes)));
  }
  for (const r of orphanCharges.slice(0, MAX_ROW_DISCREPANCIES)) {
    discrepancies.push(chargeWithNoOrder(r.checkout_ref, n(r.amount)));
  }

  return {
    checkedOrders: n(checked?.n),
    discrepancies,
    clean: discrepancies.length === 0,
    ...(itemsVsSubtotal.length > MAX_ROW_DISCREPANCIES
      || totalVsParts.length > MAX_ROW_DISCREPANCIES
      || bounds.length > MAX_ROW_DISCREPANCIES
      || refundsOwed.length > MAX_ROW_DISCREPANCIES
      || stuck.length > MAX_ROW_DISCREPANCIES
      || orphanCharges.length > MAX_ROW_DISCREPANCIES ? { truncated: true } : {}),
  };
}
