import type { Order } from './orders.js';
import { countsAsRevenue } from './orders.js';
import { orderNetForStore, orderNetTotal, getStoreRevenueMap, getPlatformOverview } from './admin-stats.js';
import { roundMoney } from './money.js';

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
 * Summing an order's `totalAmount` twice proves nothing. Summing line items on one
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
  expected: number;
  actual: number;
  /** expected − actual, rounded. The size of the problem. */
  drift: number;
  /** What it means and what to do — this is read by someone who did not write it. */
  explanation: string;
}

export interface ReconciliationReport {
  checkedOrders: number;
  discrepancies: Discrepancy[];
  /** Nothing disagreed. The number an owner actually wants to see. */
  clean: boolean;
}

function drift(expected: number, actual: number): number {
  return roundMoney(expected - actual);
}

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
    // These are written by different code at different times: the items at
    // checkout, the subtotal again on every seller edit of the order. A mismatch
    // means one was updated without the other, and the seller's product breakdown
    // will never add up to their revenue.
    for (const [slug, sub] of Object.entries(o.storeSubtotals ?? {})) {
      const fromItems = roundMoney(o.items.filter((i) => i.storeSlug === slug).reduce((s, i) => s + i.price * i.qty, 0));
      if (fromItems !== roundMoney(sub.subtotal)) {
        discrepancies.push({
          severity: 'error',
          check: 'שורות ההזמנה מול הסכום השמור',
          subject: `הזמנה ${o.id.slice(0, 8)} · ${slug}`,
          expected: fromItems,
          actual: roundMoney(sub.subtotal),
          drift: drift(fromItems, sub.subtotal),
          explanation: 'סכום שורות המוצרים לא שווה לסכום החנות השמור על ההזמנה. אחד מהם עודכן בלי השני — הפירוט למוכר לא יסתדר מול ההכנסה.',
        });
      }
    }

    // ── Route A: net + shipping, per store. Route B: the stored totalAmount. ──
    // totalAmount is what the buyer was charged and what the confirmation email
    // shows. If it drifts from the parts, the buyer and the seller are reading two
    // different numbers for the same order.
    const fromParts = roundMoney(
      Object.entries(o.storeSubtotals ?? {}).reduce((s, [slug, sub]) => s + orderNetForStore(o, slug) + sub.shipping, 0),
    );
    if (fromParts !== roundMoney(o.totalAmount)) {
      discrepancies.push({
        severity: 'error',
        check: 'סכום ההזמנה מול מרכיביו',
        subject: `הזמנה ${o.id.slice(0, 8)}`,
        expected: fromParts,
        actual: roundMoney(o.totalAmount),
        drift: drift(fromParts, o.totalAmount),
        explanation: 'הסכום הכולל של ההזמנה לא שווה ל(סכום נטו + משלוח). הקונה חויב בסכום אחד והדוחות מציגים אחר.',
      });
    }
  }

  // ── Route A: the platform headline. Route B: the per-store rows. ───────────
  // Two different modules, two different tabs, one concept. This is the check that
  // would have caught the old Overview card summing totalAmount while the Stores
  // tab summed net subtotals.
  const overview = getPlatformOverview([], [], orders);
  const rowSum = roundMoney([...getStoreRevenueMap(orders).values()].reduce((a, r) => a + r.totalRevenue, 0));
  if (rowSum !== overview.gmv) {
    discrepancies.push({
      severity: 'error',
      check: 'מחזור הפלטפורמה מול סכום החנויות',
      expected: rowSum,
      actual: overview.gmv,
      drift: drift(rowSum, overview.gmv),
      explanation: 'הכותרת בלשונית "סקירה" לא שווה לסכום שורות החנויות. שני המספרים מתארים את אותו דבר ומחושבים בשני מקומות — אחד מהם השתנה.',
    });
  }

  // ── Route A: sum per store. Route B: sum per order. ────────────────────────
  // Catches an order whose storeSubtotals hold a slug outside the known set — the
  // shape a store rename leaves behind if the repointing missed a row, which would
  // make that money vanish from every per-store view while still counting in GMV.
  const known = new Set(storeSlugs);
  const paid = orders.filter(countsAsRevenue);
  const byStore = roundMoney(
    paid.reduce((a, o) => a + storeSlugs.reduce((s, slug) => s + orderNetForStore(o, slug), 0), 0),
  );
  const byOrder = roundMoney(paid.reduce((a, o) => a + orderNetTotal(o), 0));
  if (storeSlugs.length > 0 && byStore !== byOrder) {
    const orphans = [...new Set(paid.flatMap((o) => Object.keys(o.storeSubtotals ?? {})).filter((s) => !known.has(s)))];
    discrepancies.push({
      severity: 'error',
      check: 'הכנסות לפי חנות מול הכנסות לפי הזמנה',
      expected: byOrder,
      actual: byStore,
      drift: drift(byOrder, byStore),
      explanation: orphans.length
        ? `יש הזמנות ששייכות לחנויות שלא קיימות ברשימה: ${orphans.join(', ')}. הכסף הזה נספר במחזור הכללי אבל לא מופיע באף חנות — כנראה שינוי כתובת חנות שלא עודכן בכל ההזמנות.`
        : 'סכום ההכנסות לפי חנות לא שווה לסכום לפי הזמנה, בלי חנות יתומה מזוהה. צריך בדיקה ידנית.',
    });
  }

  // ── Sanity bounds. Not a cross-check, but the same idea: a figure that is
  //    impossible is worth catching before anyone reasons from it. ─────────────
  for (const o of orders) {
    if (o.totalAmount < 0) {
      discrepancies.push({
        severity: 'error',
        check: 'סכום שלילי',
        subject: `הזמנה ${o.id.slice(0, 8)}`,
        expected: 0,
        actual: roundMoney(o.totalAmount),
        drift: drift(0, o.totalAmount),
        explanation: 'הזמנה עם סכום שלילי. הנחה שגדולה מהסכום, או עריכה שהורידה פריטים בלי לעדכן את ההנחה.',
      });
    }
    for (const [slug, sub] of Object.entries(o.storeSubtotals ?? {})) {
      // Ceiling is the SUBTOTAL, not subtotal + shipping: the seller discounts their
      // own goods, never the platform's shipping rate. A row above this ceiling was
      // written before that rule existed, and it is the shape that produced negative
      // store revenue (orderNetForStore floors it at zero, so without this check the
      // bad row would simply vanish instead of being reported).
      const applied = sub.discount?.applied ?? 0;
      if (applied > roundMoney(sub.subtotal)) {
        discrepancies.push({
          severity: 'warning',
          check: 'הנחה גדולה מסכום המוצרים',
          subject: `הזמנה ${o.id.slice(0, 8)} · ${slug}`,
          expected: roundMoney(sub.subtotal),
          actual: roundMoney(applied),
          drift: drift(sub.subtotal, applied),
          explanation: 'ההנחה גדולה מסכום המוצרים בהזמנה — כנראה הנחה שחושבה גם על דמי המשלוח. ההכנסה מהחנות הזו מוצגת כאפס במקום כשלילית, אבל השורה עצמה שגויה.',
        });
      }
    }
  }

  return { checkedOrders: orders.length, discrepancies, clean: discrepancies.length === 0 };
}
