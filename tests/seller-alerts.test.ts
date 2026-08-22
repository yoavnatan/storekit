/**
 * The seller's red dots, against a real Postgres.
 *
 * The point of this file is the SEVERITY rule, not the individual queries. The store switcher used
 * to dot a shop for a pending order or unread mail and for nothing else, so a shop whose shelf had
 * run out or whose boost the platform had stopped looked identical to a shop with nothing waiting
 * (owner, 2026-08-12). Adding states to a dot has two ways of going wrong and both are pinned here:
 *
 *   · a warning that never arrives — the whole bug being fixed;
 *   · a warning that arrives too loudly. `sellerHasAnyAlert` runs in the site header on every page,
 *     and low stock is a state a working shop is in most of the time; promoted there it would leave
 *     that dot permanently lit and teach the seller to stop seeing it, costing the orders it exists
 *     to announce. So the header's map must stay danger-only, and that is asserted directly rather
 *     than left to the comment in `seller-alerts.ts` that explains it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { query } from '../src/lib/db.js';
import { getStoreIdsWithStockAlerts } from '../src/lib/store-products.js';
import { getStoreIdsWithStalledCampaigns } from '../src/lib/ad-campaigns.js';
import { getSellerAlerts, getSellerStoreAlerts } from '../src/lib/seller-alerts.js';
import { LOW_STOCK_THRESHOLD } from '../src/lib/variant-combo.js';

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const TACHSHITIM = '22222222-2222-4222-8222-000000000002';
const SELLER_B = '11111111-1111-4111-8111-000000000002'; // owns tachshitim only
const CAMPAIGN = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; // keramika's, active in the fixture
const MIXED_ORDER = '55555555-5555-4555-8555-000000000001'; // the only one tachshitim is in

describe('getStoreIdsWithStockAlerts', () => {
  it('names the store at or under the threshold and skips the one above it', async () => {
    const low = await getStoreIdsWithStockAlerts([KERAMIKA, TACHSHITIM], LOW_STOCK_THRESHOLD);
    expect(low.has(TACHSHITIM)).toBe(true); // one product, stock 2
    // Keramika's visible product has 7. Its OTHER product has 0 — and is hidden, which is the
    // same exclusion the Products badge makes: a product deliberately off the shelf must never
    // nag, or a seller who hides seasonal stock can never clear the dot.
    expect(low.has(KERAMIKA)).toBe(false);
  });

  it('answers nothing for no stores, and never lets a non-uuid reach the query', async () => {
    expect(await getStoreIdsWithStockAlerts([], LOW_STOCK_THRESHOLD)).toEqual(new Set());
    expect(await getStoreIdsWithStockAlerts(['no-such-store'], LOW_STOCK_THRESHOLD)).toEqual(new Set());
  });
});

describe('getStoreIdsWithStalledCampaigns', () => {
  const setCampaign = (status: string, reason: string | null, archived = false) =>
    query(
      `UPDATE ad_campaigns SET status = $2, paused_reason = $3,
              archived_at = CASE WHEN $4 THEN now() ELSE NULL END
        WHERE id = $1`,
      [CAMPAIGN, status, reason, archived],
    );

  it('names only the pauses a human has to undo', async () => {
    expect(await getStoreIdsWithStalledCampaigns([KERAMIKA])).toEqual(new Set()); // active

    await setCampaign('paused', 'unavailable');
    expect((await getStoreIdsWithStalledCampaigns([KERAMIKA])).has(KERAMIKA)).toBe(true);

    await setCampaign('paused', 'no-image');
    expect((await getStoreIdsWithStalledCampaigns([KERAMIKA])).has(KERAMIKA)).toBe(true);

    // The one that undoes itself: the sweep resumes a sold-out campaign the moment stock returns,
    // and the Products badge is already saying the shelf is empty. A dot here would be the same
    // fact twice, and one the seller cannot clear from this tab.
    await setCampaign('paused', 'out-of-stock');
    expect(await getStoreIdsWithStalledCampaigns([KERAMIKA])).toEqual(new Set());

    // A cancelled campaign is a financial record, not something to act on.
    await setCampaign('paused', 'unavailable', true);
    expect(await getStoreIdsWithStalledCampaigns([KERAMIKA])).toEqual(new Set());

    await setCampaign('active', null);
  });
});

/**
 * The switcher's live half reads the current store's level off its own TAB STRIP
 * (`currentStoreTabLevel`, dashboard.astro) rather than off the panels, because a panel that has
 * not been opened holds no rows. That makes the list of tabs it reads a piece of load-bearing
 * configuration: a tab that grows a marker and is not on the list is a shop whose dot never
 * appears, and the Payments tab being ON the list would put an ACCOUNT-wide fact (no bank details)
 * onto every store row — the exact thing `seller-alerts.ts` keeps out of `byStore`.
 *
 * Neither mistake shows up in a diff of this file, so the source is scanned instead of trusted.
 */
describe('the tab strip and the switcher agree on which tabs are per-store', () => {
  it('accounts for every marker in the dashboard, one way or the other', () => {
    const src = readFileSync(new URL('../src/pages/seller/dashboard.astro', import.meta.url), 'utf8');

    const listed = /const PER_STORE_TABS = \[([^\]]+)\]/.exec(src);
    expect(listed, 'PER_STORE_TABS moved or was renamed').not.toBeNull();
    const perStore = [...listed![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    // Every tab button, in source order, so a marker can be attributed to the one it sits inside.
    const tabIds = [...src.matchAll(/id="(tab-[a-z-]+)"/g)].map((m) => ({ id: m[1], at: m.index! }));
    // `data-tab-alert="` — the attribute as RENDERED. Bare `data-tab-alert` also appears in this
    // file's own prose and in the `[data-tab-alert]` selectors of the script below, both of which
    // sit after the last tab button and would all be attributed to it.
    const owners = new Set(
      [...src.matchAll(/data-tab-alert="/g)].map((m) => {
        const before = tabIds.filter((t) => t.at < m.index!);
        return before.length ? before[before.length - 1].id : '(none)';
      }),
    );

    // There is no account-wide marker any more: the Payments tab carried the only one, and it
    // reported released money with no bank account to send it to — a state the split model cannot
    // reach, because the platform never holds the money to release. So every marker on the strip
    // now belongs to a per-store tab, and this asserts exactly that rather than carrying an
    // exclusion list that is empty.
    expect([...owners].sort()).toEqual([...perStore].sort());
  });
});

describe('per-store severity', () => {
  const shippingStatus = (status: string) =>
    query('UPDATE orders SET shipping_status = $2 WHERE id = $1', [MIXED_ORDER, status]);

  it('lets danger outrank the warning underneath it, then falls back to it', async () => {
    // Tachshitim has both: a pending order (someone waiting) and one product on 2 units.
    expect((await getSellerStoreAlerts(SELLER_B))[TACHSHITIM]).toBe('danger');

    // Handle the order and the shop is not clear — it is quieter. A dot that vanished here would
    // hide the shelf that is still nearly empty.
    await shippingStatus('delivered');
    expect((await getSellerStoreAlerts(SELLER_B))[TACHSHITIM]).toBe('warning');

    // ...and the header still says nothing, which is the anti-nag half of the rule.
    expect((await getSellerAlerts(SELLER_B)).byStore).toEqual({});

    await shippingStatus('pending');
  });
});
