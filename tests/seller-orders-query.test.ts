import { describe, it, expect } from 'vitest';
import { filterAndSortSellerOrders, parseSellerOrderQuery, ORDER_FILTER_STATUSES, type SellerOrderQuery } from '../src/lib/seller-orders-query';
import type { Order } from '../src/lib/orders';
import { readFileSync } from 'node:fs';

// Minimal Order factory — the urgency sort only reads shippingStatus + createdAt,
// but the type needs storeSubtotals present for the amount branch not under test.
function order(id: string, shippingStatus: string, createdAt: string): Order {
  return {
    id,
    shippingStatus,
    createdAt,
    storeSubtotals: { s: { subtotalAgorot: 0, shippingAgorot: 0 } },
    buyerName: '', buyerEmail: '', buyerPhone: '',
  } as unknown as Order;
}

const urgencyQuery: SellerOrderQuery = { q: '', sortCol: 'urgency', sortDir: 'asc', shippingStatus: [], returnState: [], includeOpenReturns: false };

describe('filterAndSortSellerOrders — urgency sort', () => {
  it('floats owe-action orders (pending/processing/ready) above shipped, then delivered last', () => {
    const orders = [
      order('delivered', 'delivered', '2026-07-20T10:00:00Z'),
      order('shipped', 'shipped', '2026-07-20T10:00:00Z'),
      order('pending', 'pending', '2026-07-20T10:00:00Z'),
      order('processing', 'processing', '2026-07-20T10:00:00Z'),
    ];
    const sorted = filterAndSortSellerOrders(orders, 's', urgencyQuery).map((o) => o.id);
    // Both owe-action orders come before shipped; delivered is last.
    expect(sorted.indexOf('pending')).toBeLessThan(sorted.indexOf('shipped'));
    expect(sorted.indexOf('processing')).toBeLessThan(sorted.indexOf('shipped'));
    expect(sorted.indexOf('shipped')).toBeLessThan(sorted.indexOf('delivered'));
    expect(sorted[sorted.length - 1]).toBe('delivered');
  });

  it('within the owe-action group, the oldest (most overdue) sorts to the top', () => {
    const orders = [
      order('fresh', 'pending', '2026-07-24T10:00:00Z'),
      order('old', 'processing', '2026-07-10T10:00:00Z'),
      order('mid', 'pending', '2026-07-18T10:00:00Z'),
    ];
    const sorted = filterAndSortSellerOrders(orders, 's', urgencyQuery).map((o) => o.id);
    expect(sorted).toEqual(['old', 'mid', 'fresh']);
  });

  it('only sorts what the status filter lets through (delivered absent unless filtered in)', () => {
    const orders = [
      order('delivered', 'delivered', '2026-07-20T10:00:00Z'),
      order('pending', 'pending', '2026-07-20T10:00:00Z'),
    ];
    const activeOnly: SellerOrderQuery = { ...urgencyQuery, shippingStatus: ['pending', 'processing', 'ready', 'shipped'] };
    const sorted = filterAndSortSellerOrders(orders, 's', activeOnly).map((o) => o.id);
    expect(sorted).toEqual(['pending']);
  });
});

// A fresh Orders tab already renders a FILTERED list (the "active" preset), so the
// toolbar's filter badge has to say so on the very first paint. It used to be a
// hardcoded hidden "0" that only came alive when the client re-fetched after some
// other filter change — the seller saw "no filter" over a filtered list.
describe('seller dashboard — Orders filter badge is SSR-computed', () => {
  const dashboard = readFileSync(new URL('../src/pages/seller/dashboard.astro', import.meta.url), 'utf8');

  it('defaults to a non-empty status filter, i.e. one active filter column', () => {
    expect(parseSellerOrderQuery(new URLSearchParams()).shippingStatus.length).toBeGreaterThan(0);
  });

  it('an explicitly cleared ?ostatus= means no active filter column', () => {
    expect(parseSellerOrderQuery(new URLSearchParams('ostatus=')).shippingStatus).toEqual([]);
  });

  it('the default view only holds statuses the filter menu can express', () => {
    // Otherwise the SSR page shows a status (e.g. a future carrier-set 'ready') that the
    // client's first re-fetch drops, with no visible change in the filter.
    for (const s of parseSellerOrderQuery(new URLSearchParams()).shippingStatus) {
      expect(ORDER_FILTER_STATUSES).toContain(s);
    }
  });

  it('the client toolbar reads both lists from this module, never a second copy', () => {
    const client = readFileSync(new URL('../src/scripts/dashboard/orders.ts', import.meta.url), 'utf8');
    expect(client).toContain('ORDER_ACTIVE_STATUSES');
    expect(client).toContain('ORDER_FILTER_STATUSES');
    expect(client).not.toMatch(/const (ACTIVE_STATUSES|ORDER_STATUSES) = (new Set\(\[|\[)'/);
  });

  it('binds the badge to that count instead of a hardcoded hidden 0', () => {
    const badge = dashboard.split('\n').find((l) => l.includes('id="orders-filter-count"')) ?? '';
    expect(badge).toContain('hidden={ordersActiveFilterCount === 0}');
    expect(badge).toContain('{ordersActiveFilterCount}');
  });
});

/**
 * A DELIVERED order with an open return stays on the seller's default screen.
 *
 * ── The gap this closes (owner's decision, 2026-08-20) ──
 * A return can only be opened on a delivered order, and `ORDER_ACTIVE_STATUSES` excludes delivered.
 * So the "בתהליך החזרה" chip — built 2026-08-17 to tell a seller that one of his orders is coming
 * back — had been rendering on a card the default view never shows. He found it by asking whether
 * the information was on the order card at all, and the honest answer was "yes, on a screen you
 * would have to know to go looking for".
 *
 * The widening applies to the DEFAULT and nothing else, which is the half worth pinning: a seller
 * who picks "בוטלו" and is shown a delivered order has been lied to by his own filter.
 */
describe('an open return keeps its order on the default screen', () => {
  const dflt = parseSellerOrderQuery(new URLSearchParams(''));
  const chosen = parseSellerOrderQuery(new URLSearchParams('ostatus=cancelled'));
  const delivered = order('back', 'delivered', '2026-07-20T10:00:00Z');
  // A MAP now, not a Set: the same input answers both questions the filter asks — whether the
  // order stays on the default screen, and which state it is in (the return column).
  const openReturns = new Map([['back', 'received']]);

  it('is filtered out when nothing says it has a return', () => {
    expect(filterAndSortSellerOrders([delivered], 's', dflt).map((o) => o.id)).toEqual([]);
  });

  it('survives the default status filter when it does', () => {
    expect(filterAndSortSellerOrders([delivered], 's', dflt, openReturns).map((o) => o.id)).toEqual(['back']);
  });

  it('does NOT survive a filter the seller chose himself', () => {
    expect(chosen.includeOpenReturns, 'a narrowed ?ostatus must switch the widening off').toBe(false);
    expect(filterAndSortSellerOrders([delivered], 's', chosen, openReturns).map((o) => o.id)).toEqual([]);
  });

  it('survives when the CLIENT re-sends the active set explicitly — the twin case', () => {
    // `/api/seller/orders` is how every search, sort and page change re-fetches, and the toolbar
    // always sends its current selection: seeded from the active set, so spelled out rather than
    // absent. Keying the widening off "no ?ostatus" made the server's first paint show a returning
    // order and the first keystroke drop it.
    const fromClient = parseSellerOrderQuery(new URLSearchParams(`ostatus=${dflt.shippingStatus.join(',')}`));
    expect(fromClient.includeOpenReturns).toBe(true);
    expect(filterAndSortSellerOrders([delivered], 's', fromClient, openReturns).map((o) => o.id)).toEqual(['back']);
  });

  it('the default really does exclude delivered, or this whole rule is a no-op', () => {
    expect(dflt.includeOpenReturns).toBe(true);
    expect(dflt.shippingStatus).not.toContain('delivered');
  });
});

/**
 * Filtering the orders list BY the return case — the third column.
 *
 * The other two cannot express it and it is not an oversight: a cancellation is a shipping status
 * and always was filterable, a finished return is `returned` and likewise, and a return still
 * running leaves the order at `delivered` on purpose (decisions §0 — the sale did complete). So the
 * question "show me what is coming back" had no answer on this screen until the column existed.
 */
describe('the return column', () => {
  const delivered = order('back', 'delivered', '2026-07-20T10:00:00Z');
  const plain = order('plain', 'delivered', '2026-07-20T10:00:00Z');
  const live = new Map([['back', 'received']]);

  it('keeps only the orders whose case is in a chosen state', () => {
    const q = parseSellerOrderQuery(new URLSearchParams('oret=received'));
    expect(q.returnState).toEqual(['received']);
    expect(filterAndSortSellerOrders([delivered, plain], 's', q, live).map((o) => o.id)).toEqual(['back']);
  });

  it('excludes an order whose case is in a DIFFERENT state', () => {
    const q = parseSellerOrderQuery(new URLSearchParams('oret=disputed'));
    expect(filterAndSortSellerOrders([delivered, plain], 's', q, live).map((o) => o.id)).toEqual([]);
  });

  it('excludes an order with no live case at all, whatever its status', () => {
    const q = parseSellerOrderQuery(new URLSearchParams('oret=received'));
    expect(filterAndSortSellerOrders([plain], 's', q, live).map((o) => o.id)).toEqual([]);
  });

  it('refuses a state the machine does not have, rather than matching nothing', () => {
    // Echoed straight through, an unrecognised value would narrow the list to zero and read to the
    // seller as "you have no returns" — the one answer this filter must never invent.
    expect(parseSellerOrderQuery(new URLSearchParams('oret=banana')).returnState).toEqual([]);
  });

  it('an empty column is no opinion, not "match nothing"', () => {
    // Asked with the STATUS filter cleared (`?ostatus=` present and empty), so the only thing that
    // could be narrowing the list is this column — and it is not.
    const q = parseSellerOrderQuery(new URLSearchParams('ostatus='));
    expect(q.returnState).toEqual([]);
    expect(filterAndSortSellerOrders([delivered, plain], 's', q, live).map((o) => o.id).sort())
      .toEqual(['back', 'plain']);
  });

  it('narrows the DEFAULT view too, where the widening would otherwise have kept it', () => {
    // The two rules meet here: `includeOpenReturns` puts a delivered order back on the default
    // screen, and this column then narrows that screen. A seller who ticks "בהכרעה" must not be
    // handed the `received` case the widening had just rescued.
    const q = parseSellerOrderQuery(new URLSearchParams('oret=disputed'));
    expect(q.includeOpenReturns, 'no ?ostatus, so the default set is in play').toBe(true);
    expect(filterAndSortSellerOrders([delivered], 's', q, live).map((o) => o.id)).toEqual([]);
  });
});
