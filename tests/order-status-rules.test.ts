import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SHIPPING_STATUS_RULES,
  PAYMENT_STATUS_RULES,
  CANCELLABLE_FROM,
  canTransition,
  orderCountsAsRevenue,
  orderHoldsStock,
  type ShippingStatus,
  type PaymentStatus,
} from '../src/lib/order-status-rules.js';
import { countsAsRevenue } from '../src/lib/orders.js';

/**
 * The status table is only worth having if it cannot be half-filled.
 *
 * These tests are the enforcement: adding a status to the Order type without adding
 * its row here fails the suite, and every consequence of every status is asserted
 * from the table rather than from a call site's local opinion.
 */

/** Parsed out of the Order type itself, so the check can't drift from the source. */
function statusesFromOrderType(field: 'paymentStatus' | 'shippingStatus'): string[] {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders.ts'), 'utf8');
  const line = new RegExp(`^\\s*${field}:\\s*(.+);\\s*$`, 'm').exec(src);
  if (!line) throw new Error(`could not find ${field} in orders.ts`);
  return [...line[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('the table covers every status that exists', () => {
  it('every shippingStatus in the Order type has a row', () => {
    // The whole point: a new status cannot be introduced somewhere else and quietly
    // inherit whatever the nearest `if` happens to do with it.
    const declared = statusesFromOrderType('shippingStatus').sort();
    expect(Object.keys(SHIPPING_STATUS_RULES).sort()).toEqual(declared);
  });

  it('every paymentStatus in the Order type has a row', () => {
    const declared = statusesFromOrderType('paymentStatus').sort();
    expect(Object.keys(PAYMENT_STATUS_RULES).sort()).toEqual(declared);
  });

  it('every row answers every question', () => {
    // A row with a missing column is the half-filled table this file exists to stop.
    const facets = ['countsAsRevenue', 'holdsStock', 'cancellableFrom', 'terminal', 'notifiesBuyer', 'buyerAwaiting', 'blocksStoreClosure'] as const;
    for (const [status, rule] of Object.entries(SHIPPING_STATUS_RULES)) {
      for (const facet of facets) {
        expect(typeof rule[facet], `${status}.${facet}`).toBe('boolean');
      }
    }
  });
});

describe('the rules say what the business actually means', () => {
  it('only a cancelled order stops counting as revenue', () => {
    // Cancelling deliberately leaves paymentStatus at 'paid' — the charge happened —
    // so the shipping side is the only thing that can take it out of a total.
    for (const [status, rule] of Object.entries(SHIPPING_STATUS_RULES) as Array<[ShippingStatus, typeof SHIPPING_STATUS_RULES[ShippingStatus]]>) {
      expect(rule.countsAsRevenue, status).toBe(status !== 'cancelled');
    }
  });

  it('only a paid order counts as revenue', () => {
    for (const [status, rule] of Object.entries(PAYMENT_STATUS_RULES) as Array<[PaymentStatus, typeof PAYMENT_STATUS_RULES[PaymentStatus]]>) {
      expect(rule.countsAsRevenue, status).toBe(status === 'paid');
    }
  });

  it('an order that no longer holds stock never counts as revenue either', () => {
    // These two must move together. A status that returns the units but keeps
    // counting the money is the exact bug that ran for seven sessions.
    for (const [status, rule] of Object.entries(SHIPPING_STATUS_RULES)) {
      if (!rule.holdsStock) expect(rule.countsAsRevenue, `${status}: released stock but still counts as revenue`).toBe(false);
    }
  });

  it('a terminal status cannot also be cancellable', () => {
    for (const [status, rule] of Object.entries(SHIPPING_STATUS_RULES)) {
      if (rule.terminal) expect(rule.cancellableFrom, `${status} is terminal AND cancellable`).toBe(false);
    }
  });

  it('cancellation is only possible before the parcel moves', () => {
    expect(CANCELLABLE_FROM.sort()).toEqual(['pending', 'processing', 'ready']);
  });
});

describe('transitions', () => {
  it('a cancelled order cannot be revived', () => {
    // Its units are already back on the shelf; reactivating would ship goods that
    // have been sold to someone else.
    for (const to of Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[]) {
      if (to === 'cancelled') continue;
      expect(canTransition('cancelled', to).ok, `cancelled → ${to}`).toBe(false);
    }
  });

  it('a shipped or delivered order cannot be cancelled', () => {
    for (const from of ['shipped', 'delivered'] as ShippingStatus[]) {
      expect(canTransition(from, 'cancelled').ok, `${from} → cancelled`).toBe(false);
    }
  });

  it('the normal fulfilment path is allowed end to end', () => {
    const path: ShippingStatus[] = ['pending', 'processing', 'ready', 'shipped', 'delivered'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!).ok, `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it('a no-op transition on a live order is allowed', () => {
    // A repeat request from a second dashboard tab setting the status it already
    // has must not 409.
    for (const s of Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[]) {
      if (SHIPPING_STATUS_RULES[s].terminal) continue;
      expect(canTransition(s, s).ok, `${s} → ${s}`).toBe(true);
    }
  });

  it('but re-cancelling an already-cancelled order is refused', () => {
    // Not pedantry: a 200 here is an invitation to whatever runs downstream of a
    // cancellation, and once refunds are real that is a second refund.
    expect(canTransition('cancelled', 'cancelled').ok).toBe(false);
  });

  it('every refusal carries a reason a seller can read', () => {
    const verdict = canTransition('shipped', 'cancelled');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0);
  });
});

describe('the whole matrix, both fields at once', () => {
  it('countsAsRevenue is true for exactly the paid, non-cancelled combinations', () => {
    // 3 payment states × 6 shipping states, asserted exhaustively rather than by
    // example — the combination nobody thinks to test is the one that bites.
    for (const paymentStatus of Object.keys(PAYMENT_STATUS_RULES) as PaymentStatus[]) {
      for (const shippingStatus of Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[]) {
        const expected = paymentStatus === 'paid' && shippingStatus !== 'cancelled';
        expect(orderCountsAsRevenue({ paymentStatus, shippingStatus }), `${paymentStatus}/${shippingStatus}`).toBe(expected);
        // orders.ts#countsAsRevenue is the name the codebase calls; it must agree.
        expect(countsAsRevenue({ paymentStatus, shippingStatus }), `orders.ts ${paymentStatus}/${shippingStatus}`).toBe(expected);
      }
    }
  });

  it('stock is held for exactly the non-cancelled statuses', () => {
    for (const shippingStatus of Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[]) {
      expect(orderHoldsStock({ shippingStatus }), shippingStatus).toBe(shippingStatus !== 'cancelled');
    }
  });

  it('an unrecognised status is treated as counting for nothing', () => {
    // A hand-edited data file or a future rollback can put an unknown value in the
    // field. It must fall out of revenue rather than crash a dashboard render or,
    // worse, default to counting.
    expect(orderCountsAsRevenue({ paymentStatus: 'paid', shippingStatus: 'refunded' as ShippingStatus })).toBe(false);
    expect(orderCountsAsRevenue({ paymentStatus: 'chargeback' as PaymentStatus, shippingStatus: 'delivered' })).toBe(false);
    expect(orderHoldsStock({ shippingStatus: 'nonsense' as ShippingStatus })).toBe(false);
  });
});

describe('the rules are not re-implemented at call sites', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the orders API does not carry its own cancellable list or status list', () => {
    const src = read('src/pages/api/seller/orders.ts');
    expect(src).not.toMatch(/CANCELLABLE_FROM\s*=\s*\[/);
    expect(src).not.toMatch(/validStatuses\s*=\s*\[\s*'pending'/);
  });

  it('no revenue module tests for the cancelled string itself', () => {
    for (const file of ['src/lib/seller-performance.ts', 'src/lib/admin-stats.ts', 'src/lib/platform-performance.ts']) {
      expect(read(file), file).not.toMatch(/shippingStatus\s*[!=]==\s*'cancelled'/);
    }
  });
});
