import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import { getAdminNotifications, unreadCount } from '../src/lib/admin-notifications.js';
import { getAdminTabBadges } from '../src/lib/admin-tab-badges.js';
import type { TabViews } from '../src/lib/admin-tab-views.js';

/**
 * The bell and the tab badges are one signal, counted twice.
 *
 * The owner's requirement is a sentence — *every alert that appears on one of the tabs goes into
 * the bell* — and the way that requirement breaks is never dramatic. Somebody adds a sixth source
 * to the badge query, or narrows a predicate here by a `resolved` flag, and from then on a tab says
 * "(3)" over a bell that lists two. Nothing errors. The bell just stops being trustworthy, which is
 * the only property it has.
 *
 * So the invariant is asserted directly rather than described: seed one of each kind, then group
 * this module's UNREAD items by tab and compare with `getAdminTabBadges`'s own numbers. A drift in
 * either module fails here, and the failure names the tab.
 *
 * **One term is outside the equality on purpose.** The Alerts badge adds 1 when image moderation
 * has stopped — a CONDITION, still true after it has been read — and a bell is a list of arrivals.
 * That is why the alerts case below compares against the error term alone and says so.
 */

const SELLER = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const STORE = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const ORDER = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
const ERROR = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
const MESSAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005';

/** Everything below is "seen a long time ago", so everything seeded after it counts as unread. */
const LONG_AGO = new Date(Date.now() - 365 * 86_400_000).toISOString();
const VIEWS: TabViews = { sellers: LONG_AGO, stores: LONG_AGO, orders: LONG_AGO, alerts: LONG_AGO };

beforeEach(async () => {
  for (const t of ['admin_messages', 'error_log', 'order_items', 'order_stores', 'orders', 'stores', 'sellers']) {
    await query(`DELETE FROM ${t}`);
  }
  await query('INSERT INTO sellers (id, name, email, created_at) VALUES ($1, $2, $3, now())',
    [SELLER, 'מוכר בדיקה', 'bell@example.test']);
  await query(`INSERT INTO stores (id, seller_id, slug, name, created_at) VALUES ($1, $2, 'bell-shop', 'חנות בדיקה', now())`,
    [STORE, SELLER]);
  await query(
    `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, total_agorot, payment_status, shipping_status, created_at)
          VALUES ($1, 'CHK-BELL', 'קונה בדיקה', 'buyer@example.test', 9900, 'paid', 'pending', now())`, [ORDER]);
  await query(`INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot) VALUES ($1, 'bell-shop', 'חנות בדיקה', 9900)`, [ORDER]);
  await query(`INSERT INTO error_log (id, source, message, created_at) VALUES ($1, 'server', 'משהו נשבר', now())`, [ERROR]);
  await query(
    `INSERT INTO admin_messages (id, seller_id, from_role, subject, content, read_by_admin, created_at)
          VALUES ($1, $2, 'seller', 'שאלה על תשלום', 'לא הבנתי את החיוב', false, now())`, [MESSAGE, SELLER]);
});

/** Unread items, grouped the way the tab strip groups them. */
async function unreadByTab(): Promise<Record<string, number>> {
  const items = await getAdminNotifications(VIEWS);
  const counts: Record<string, number> = {};
  for (const item of items.filter((i) => i.unread)) counts[item.tab] = (counts[item.tab] ?? 0) + 1;
  return counts;
}

describe('the bell carries exactly what the tabs count', () => {
  it('agrees with every badge, tab by tab', async () => {
    const badges = await getAdminTabBadges(VIEWS);
    const bell = await unreadByTab();

    expect(bell['sellers'] ?? 0, 'sellers').toBe(badges.sellers);
    expect(bell['stores'] ?? 0, 'stores').toBe(badges.stores);
    expect(bell['orders'] ?? 0, 'orders').toBe(badges.orders);
    expect(bell['messages'] ?? 0, 'messages').toBe(badges.messages);
    // Alerts: the error term only — the moderation term is a condition, not an arrival (see header).
    expect(bell['alerts'] ?? 0, 'alerts').toBe(badges.alerts);
  });

  it('counts a multi-store purchase as ONE row, like the Orders tab does', async () => {
    // The same checkout, a second store. The tab shows one card; a bell showing two would be the
    // first disagreement anybody noticed.
    const second = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000006';
    await query(
      `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, total_agorot, payment_status, shipping_status, created_at)
            VALUES ($1, 'CHK-BELL', 'קונה בדיקה', 'buyer@example.test', 4900, 'paid', 'pending', now())`, [second]);

    const badges = await getAdminTabBadges(VIEWS);
    expect((await unreadByTab())['orders'] ?? 0).toBe(badges.orders);
    expect(badges.orders).toBe(1);
  });

  it('leaves a resolved error in, because the badge does', async () => {
    // Resolving is not reading. Filtering resolved errors out here — which the first draft did —
    // put a number on the Alerts tab with no row behind it in the bell.
    await query('UPDATE error_log SET resolved = true WHERE id = $1', [ERROR]);
    const badges = await getAdminTabBadges(VIEWS);
    expect((await unreadByTab())['alerts'] ?? 0).toBe(badges.alerts);
    expect(badges.alerts).toBeGreaterThan(0);
  });
});

describe('what the toasts depend on', () => {
  it('gives every row a stable id across calls', async () => {
    // The whole no-duplicate-toast mechanism rests on this: `ToastContainer` dedups by key, and the
    // key is this id. An id that changed between polls would toast the same seller every fifteen
    // seconds until somebody opened the tab.
    const first = (await getAdminNotifications(VIEWS)).map((n) => n.id);
    const second = (await getAdminNotifications(VIEWS)).map((n) => n.id);
    expect(second).toEqual(first);
    expect(new Set(first).size, 'ids are unique').toBe(first.length);
  });

  it('prefixes each id by source, so two tables cannot collide on one row id', async () => {
    const ids = (await getAdminNotifications(VIEWS)).map((n) => n.id);
    expect(ids.some((id) => id.startsWith('seller:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('store:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('error:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('msg:'))).toBe(true);
  });

  it('returns nothing for a cursor in the future — the poll that must not re-toast', async () => {
    const ahead = new Date(Date.now() + 60_000).toISOString();
    expect(await getAdminNotifications(VIEWS, ahead)).toEqual([]);
  });

  it('returns the new row, and only it, for a cursor in the middle', async () => {
    const cursor = new Date().toISOString();
    const fresh = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000007';
    // A second of daylight between the cursor and the row, since both are wall-clock here.
    await query(`INSERT INTO error_log (id, source, message, created_at) VALUES ($1, 'server', 'חדש', now() + interval '2 seconds')`, [fresh]);
    const since = await getAdminNotifications(VIEWS, cursor);
    expect(since.map((n) => n.id)).toEqual([`error:${fresh}`]);
  });

  it('orders newest first', async () => {
    const items = await getAdminNotifications(VIEWS);
    const times = items.map((n) => new Date(n.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('counts the unread from the very list it returns', async () => {
    // A second query for the number is how a badge and the rows behind it come to disagree.
    const items = await getAdminNotifications(VIEWS);
    expect(unreadCount(items)).toBe(items.filter((i) => i.unread).length);
  });
});

describe('what "read" means here', () => {
  it('drops a tab out of the unread set once that tab has been opened', async () => {
    // There is no mark-read call: opening the tab moves the boundary, and the row falls out by
    // itself. That is the tab strip's own vocabulary, and the reason the bell needs no read flag.
    const seenNow: TabViews = { ...VIEWS, sellers: new Date(Date.now() + 1000).toISOString() };
    const items = await getAdminNotifications(seenNow);
    expect(items.filter((i) => i.tab === 'sellers' && i.unread)).toEqual([]);
    // Still LISTED, just no longer unread — a bell that hid what you had seen would be a bell you
    // could not use to look something up again.
    expect(items.some((i) => i.tab === 'sellers')).toBe(true);
  });
});
