/**
 * The badge the unattended pull raises — and, just as much, the one it must NOT raise.
 *
 * The whole point is that nobody is looking at a scheduled sync (owner, 2026-08-19: *"הסנכרון מגיע
 * מבחוץ, אז הוא לא באמת יכול להסתכל על זה בזמן אמת"*). So every silent way it can stop working has
 * to become something visible, and it has to stay quiet enough to keep being read: an hourly job
 * that alerted every hour would train the seller to ignore the bell inside a day.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const feed = vi.hoisted(() => ({ csv: '' as string, ok: true, error: 'timeout' }));
vi.mock('../src/lib/feed-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/feed-fetch.js')>()),
  fetchFeedCsv: async () => (feed.ok ? { ok: true, csv: feed.csv } : { ok: false, error: feed.error }),
}));

const { query } = await import('../src/lib/db.js');
const { syncStoreFeed } = await import('../src/lib/store-feed-sync.js');
const { getStoreById } = await import('../src/lib/stores.js');
const { classifyFeedSyncOutcome } = await import('../src/lib/feed-sync-alert.js');

interface Fixture { storeId: string; sellerId: string }

async function storeWithFeed(): Promise<Fixture> {
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  const suffix = crypto.randomBytes(4).toString('hex');
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, feed_sync)
     VALUES ($1, $2, $3, 'Feed store', $4::jsonb)`,
    [storeId, sellerId, `alert-${suffix}`, JSON.stringify({
      url: 'https://vendor.example.com/stock.csv',
      mapping: { 'Item Code': 'sku', 'Qty On Hand': 'stock' },
    })],
  );
  await query(
    `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock, sku)
     VALUES ($1, $2, $3, 'Widget', 9900, 5, 'A-1')`,
    [crypto.randomUUID(), storeId, `widget-${suffix}`],
  );
  return { storeId, sellerId };
}

async function alerts(sellerId: string): Promise<Array<{ related_id: string; title: string }>> {
  const { rows } = await query<{ related_id: string; title: string }>(
    `SELECT related_id, title FROM notifications WHERE user_id = $1 AND related_id LIKE 'feed-sync:%'`,
    [sellerId],
  );
  return rows;
}

const vendorCsv = (qty: number) => `Item Code,Qty On Hand\nA-1,${qty}\n`;

beforeEach(() => { feed.ok = true; feed.csv = vendorCsv(3); });

describe('classifyFeedSyncOutcome', () => {
  it('reads a clean run as nothing to say', () => {
    expect(classifyFeedSyncOutcome(200, { ok: true, results: [{ action: 'update' }] })).toBeUndefined();
  });

  it('separates a refused ROW from a failed run — the partial case a count hides', () => {
    // The run reports ok and stamps lastSyncAt; some products were simply never touched.
    expect(classifyFeedSyncOutcome(200, { ok: true, results: [{ action: 'update' }, { action: 'error' }] }))
      .toBe('rows-refused');
  });

  it('names each way the pull can fail, and stays silent about a store with no feed', () => {
    expect(classifyFeedSyncOutcome(502, { ok: false, error: 'feed-timeout' })).toBe('unreachable');
    expect(classifyFeedSyncOutcome(400, { ok: false, error: 'no-matcher-column' })).toBe('no-matcher-column');
    expect(classifyFeedSyncOutcome(400, { ok: false, error: 'empty-file' })).toBe('empty-file');
    expect(classifyFeedSyncOutcome(400, { ok: false, error: 'missing-columns' })).toBe('file-rejected');
    expect(classifyFeedSyncOutcome(400, { ok: false, error: 'no-feed-url' })).toBeUndefined();
  });
});

describe('what a scheduled pull leaves in the seller\'s bell', () => {
  it('raises one alert when the feed cannot be fetched', async () => {
    const { storeId, sellerId } = await storeWithFeed();
    feed.ok = false;

    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    const raised = await alerts(sellerId);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.related_id).toBe(`feed-sync:${storeId}:unreachable`);
  });

  it('says it once a day, not once an hour', async () => {
    const { storeId, sellerId } = await storeWithFeed();
    feed.ok = false;

    for (let i = 0; i < 5; i += 1) await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    // Five failed hours, one alert. A bell that repeats itself stops being read, and that damage
    // does not heal the way a missed hour does.
    expect(await alerts(sellerId)).toHaveLength(1);
  });

  it('clears itself the moment a pull comes back clean', async () => {
    const { storeId, sellerId } = await storeWithFeed();
    feed.ok = false;
    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');
    expect(await alerts(sellerId)).toHaveLength(1);

    feed.ok = true;
    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    // The alert is a claim about the present, not a log of what once happened — nobody should have
    // to dismiss a warning about a problem that fixed itself.
    expect(await alerts(sellerId)).toHaveLength(0);
  });

  it('says nothing at all when the SELLER pressed the button', async () => {
    // They are looking at the answer. A notification for something already on screen is noise.
    const { storeId, sellerId } = await storeWithFeed();
    feed.ok = false;

    await syncStoreFeed((await getStoreById(storeId))!, true);

    expect(await alerts(sellerId)).toHaveLength(0);
  });

  it('raises the partial alert when the run succeeded but a row was refused', async () => {
    const { storeId, sellerId } = await storeWithFeed();
    // A row whose sku matches nothing and carries no name — the import refuses it by itself.
    feed.csv = 'Item Code,Qty On Hand\nA-1,4\nGHOST-9,7\n';

    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    const raised = await alerts(sellerId);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.related_id).toBe(`feed-sync:${storeId}:rows-refused`);
  });
});

/**
 * The same verdict, kept on the STORE — which is what the products tab reads to put a card in front
 * of the seller. A notification is read once and dismissed; the sync stays broken for days.
 */
describe('what the store remembers about a failing pull', () => {
  const feedSyncOf = async (storeId: string) =>
    (await query<{ feed_sync: { lastError?: { problem: string; at: string }; lastSyncAt?: string } }>(
      'SELECT feed_sync FROM stores WHERE id = $1', [storeId])).rows[0]!.feed_sync;

  it('records WHY, and when it stopped working', async () => {
    const { storeId } = await storeWithFeed();
    feed.ok = false;

    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    const { lastError } = await feedSyncOf(storeId);
    expect(lastError?.problem).toBe('unreachable');
    expect(Date.parse(lastError!.at)).toBeGreaterThan(0);
  });

  it('keeps the ORIGINAL timestamp while the same problem persists', async () => {
    // "Since when" is the number the seller needs; the last attempt is not news.
    const { storeId } = await storeWithFeed();
    feed.ok = false;
    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');
    const first = (await feedSyncOf(storeId)).lastError!.at;

    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    expect((await feedSyncOf(storeId)).lastError!.at).toBe(first);
  });

  it('forgets it the moment a pull succeeds', async () => {
    const { storeId } = await storeWithFeed();
    feed.ok = false;
    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');
    expect((await feedSyncOf(storeId)).lastError).toBeDefined();

    feed.ok = true;
    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    const after = await feedSyncOf(storeId);
    expect(after.lastError, 'a card must not outlive the problem').toBeUndefined();
    expect(after.lastSyncAt, 'and the success is still stamped').toBeTypeOf('string');
  });

  it('says nothing about the run the seller watched', async () => {
    const { storeId } = await storeWithFeed();
    feed.ok = false;

    await syncStoreFeed((await getStoreById(storeId))!, true);

    expect((await feedSyncOf(storeId)).lastError).toBeUndefined();
  });
});
