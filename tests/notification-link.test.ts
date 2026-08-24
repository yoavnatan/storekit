import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { notificationHref } from '../src/lib/notification-link.js';
import type { NotificationType } from '../src/lib/notifications.js';

// The vocabulary this deploy writes. Kept here as a literal on purpose: if a new type is added to
// notifications.ts and nobody teaches this file about it, the exhaustiveness check below fails and
// the author is made to decide where it lands, instead of it silently defaulting to a dashboard
// root — which is how 'feed_status' ended up sending sellers to the buyer dashboard.
const SELLER_TYPES: NotificationType[] = [
  'new_message', 'new_order', 'order_update', 'return_update', 'low_stock', 'out_of_stock',
  'admin_message', 'domain_status', 'feed_status', 'payout_status', 'store_live', 'store_unpublished',
  'merchant_approved',
];
const BUYER_TYPES: NotificationType[] = ['seller_reply', 'new_message', 'order_update'];

describe('notificationHref', () => {
  it('never sends a buyer into the seller dashboard', () => {
    for (const type of [...BUYER_TYPES, ...SELLER_TYPES, 'something_a_newer_deploy_writes']) {
      expect(notificationHref({ role: 'buyer', type })).not.toContain('/seller/');
    }
  });

  it('never sends a seller into the buyer dashboard', () => {
    for (const type of [...SELLER_TYPES, ...BUYER_TYPES, 'something_a_newer_deploy_writes']) {
      expect(notificationHref({ role: 'seller', type })).not.toContain('/buyer/');
    }
  });

  it("routes the buyer's own order update to their orders tab, not the seller's orders panel", () => {
    // The regression this file exists for: 'order_update' is written to BOTH roles
    // (order-notify.ts → buyer, order-sla-run.ts → seller), so type alone cannot answer.
    expect(notificationHref({ role: 'buyer', type: 'order_update' })).toBe('/buyer/dashboard?tab=orders');
    expect(notificationHref({ role: 'seller', type: 'order_update' })).toBe('/seller/dashboard?panel=orders');
  });

  it('opens the returns tab for a return, never the orders tab', () => {
    // Owner, 2026-08-23: *"לחיצה עליו לא מביאה להחזרות אלא להזמנות"*. Every seller-facing return
    // notification was typed `order_update` because it carries an order's id — including the one
    // whose body tells him to look at the returns tab. `relatedId` is still the order id here on
    // purpose: the destination must come from the type, not from what the row happens to point at.
    const href = notificationHref({ role: 'seller', type: 'return_update', relatedId: 'order-1' });
    expect(href).toBe('/seller/dashboard?panel=returns');
    expect(href).not.toContain('panel=orders');
  });

  it('lands each seller type on the tab that can act on it', () => {
    const expected: Record<string, string> = {
      new_message: '/seller/dashboard?panel=messages',
      admin_message: '/seller/dashboard?panel=messages',
      new_order: '/seller/dashboard?panel=orders',
      order_update: '/seller/dashboard?panel=orders',
      return_update: '/seller/dashboard?panel=returns',
      payout_status: '/seller/dashboard?panel=payouts',
      low_stock: '/seller/dashboard?panel=products',
      out_of_stock: '/seller/dashboard?panel=products',
      feed_status: '/seller/dashboard?panel=products',
      domain_status: '/seller/dashboard?panel=settings',
      // The overview, and it is the one entry here with no `?panel=` on purpose: the seller last
      // saw that screen telling him what was still missing, and this is the same screen with
      // nothing left on it.
      store_live: '/seller/dashboard',
      // The one place the single thing that undoes it lives — not the overview, which would make
      // him hunt for it.
      store_unpublished: '/seller/dashboard?panel=payouts',
      merchant_approved: '/seller/dashboard',
    };
    for (const type of SELLER_TYPES) {
      expect(notificationHref({ role: 'seller', type })).toBe(expected[type]);
    }
  });

  it('opens the sync panel for a sync alert, and only for that one', () => {
    // `feed_status` carries two different pieces of news and the type cannot tell them apart: an ad
    // network rejecting a PRODUCT (fixed on the product) and the external inventory sync failing
    // (fixed in a panel the seller would otherwise have to hunt for). The key does tell them apart.
    expect(notificationHref({ role: 'seller', type: 'feed_status', relatedId: 'feed-sync:abc:unreachable' }))
      .toBe('/seller/dashboard?panel=products&feed=1');
    expect(notificationHref({ role: 'seller', type: 'feed_status', relatedId: 'feed:google:p1:rejected' }))
      .toBe('/seller/dashboard?panel=products');
    expect(notificationHref({ role: 'seller', type: 'feed_status' }))
      .toBe('/seller/dashboard?panel=products');
  });

  it('deep-links a system message to its own thread', () => {
    expect(notificationHref({ role: 'seller', type: 'admin_message', relatedId: 'thread 1' }))
      .toBe('/seller/dashboard?panel=messages&msg=thread%201');
  });

  it('falls back to the reader\'s own dashboard for a type it does not know', () => {
    expect(notificationHref({ role: 'seller', type: 'written_by_a_newer_deploy' })).toBe('/seller/dashboard');
    expect(notificationHref({ role: 'buyer', type: 'written_by_a_newer_deploy' })).toBe('/buyer/dashboard');
  });

  it('knows every type notifications.ts declares', () => {
    const source = readFileSync(new URL('../src/lib/notifications.ts', import.meta.url), 'utf8');
    const declared = (source.match(/export type NotificationType = ([^;]+);/)?.[1] ?? '')
      .split('|').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    const known = new Set([...SELLER_TYPES, ...BUYER_TYPES]);
    expect(declared.filter((t) => !known.has(t as NotificationType))).toEqual([]);
  });
});

describe('one routing table, two renderers', () => {
  // The dropdown (Header.astro) and the toast poller (BaseLayout.astro) both used to carry their
  // own copy of this table, and they had already drifted apart. Both now read the `href` the API
  // derives. A second copy here is the bug, not a style question.
  it('neither renderer branches on notification type to build a link', () => {
    for (const file of ['../src/components/Header.astro', '../src/layouts/BaseLayout.astro']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const lines = source.split('\n').filter((l) => /panel=(orders|returns|messages|products|settings|payouts)|tab=(orders|messages)/.test(l));
      for (const line of lines) {
        expect(line, `${file} builds a notification link from its type`).not.toMatch(/type\s*===?\s*'/);
      }
    }
  });
});
