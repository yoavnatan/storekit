/**
 * The external-inventory pull as a whole — the half of stage 4a that writes STOCK on a timer
 * (DB_MIGRATION_PLAN.md §8, GO_LIVE §6.1).
 *
 * **Why this file exists at all.** The sequence used to live inside the route, where the only way
 * to reach it was a seller pressing a button, and the only thing that could go wrong was visible to
 * them immediately. On a timer both change: nobody sees the result, and it repeats. The property
 * that has to hold is therefore not "it imports a CSV" — `store-products-import` already covers
 * that — but **running it twice must be the same as running it once**, because the lease in
 * migration 0007 reduces double-runs and cannot rule them out.
 *
 * The network is stubbed, deliberately and only here. What is under test is what the pull DOES to a
 * catalog; the fetch itself, its SSRF guard and its DNS pin are tested against real sockets in
 * `tests/feed-fetch-ssrf.test.ts`, which is where a test that opens a socket belongs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';

const feed = vi.hoisted(() => ({ csv: '' as string, calls: 0 }));

vi.mock('../src/lib/feed-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/feed-fetch.js')>()),
  fetchFeedCsv: async () => {
    feed.calls += 1;
    return { ok: true, csv: feed.csv };
  },
}));

const { syncStoreFeed, syncedRowCount } = await import('../src/lib/store-feed-sync.js');
const { getStoreById } = await import('../src/lib/stores.js');
const { getProductsByStoreId } = await import('../src/lib/store-products.js');

/** The shape a seller's POS exports: their own sku, and what it says the stock is. */
function vendorCsv(rows: Array<[string, number]>): string {
  return ['Item Code,Qty On Hand', ...rows.map(([sku, qty]) => `${sku},${qty}`)].join('\n') + '\n';
}

interface Fixture { storeId: string; productId: string }

async function storeWithFeed(sku: string, stock: number): Promise<Fixture> {
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const suffix = crypto.randomBytes(4).toString('hex');
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, feed_sync)
     VALUES ($1, $2, $3, 'Feed store', $4::jsonb)`,
    [storeId, sellerId, `feed-sync-${suffix}`, JSON.stringify({
      url: 'https://vendor.example.com/stock.csv',
      // The mapping the seller confirmed once, from THEIR headers to our canonical fields.
      mapping: { 'Item Code': 'sku', 'Qty On Hand': 'stock' },
    })],
  );
  await query(
    `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock, sku)
     VALUES ($1, $2, $3, 'Widget', 9900, $4, $5)`,
    [productId, storeId, `widget-${suffix}`, stock, sku],
  );
  return { storeId, productId };
}

async function stockOf(productId: string): Promise<number> {
  const { rows } = await query<{ stock: number }>('SELECT stock FROM store_products WHERE id = $1', [productId]);
  return rows[0]!.stock;
}

beforeEach(() => { feed.calls = 0; });

describe('applying a feed', () => {
  it('matches by sku and SETS the stock the feed declares', async () => {
    const { storeId, productId } = await storeWithFeed('A-1', 5);
    feed.csv = vendorCsv([['A-1', 12]]);

    const { status, body } = await syncStoreFeed((await getStoreById(storeId))!, true);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(await stockOf(productId)).toBe(12);
    // The rows the run actually wrote — the number the job puts in its log line.
    expect(syncedRowCount(body)).toBe(1);
  });

  it('stamps lastSyncAt only on a commit, so a preview leaves no trace', async () => {
    const { storeId, productId } = await storeWithFeed('A-1', 5);
    feed.csv = vendorCsv([['A-1', 7]]);

    const preview = await syncStoreFeed((await getStoreById(storeId))!, false);
    expect(preview.body.lastSyncAt).toBeUndefined();
    expect(await stockOf(productId), 'a preview must not write').toBe(5);

    const committed = await syncStoreFeed((await getStoreById(storeId))!, true);
    expect(committed.body.lastSyncAt).toBeTypeOf('string');
    expect((await getStoreById(storeId))!.feedSync?.lastSyncAt).toBe(committed.body.lastSyncAt);
  });
});

describe('running it twice is running it once', () => {
  it('writes on the first pass and nothing on the second', async () => {
    const { storeId, productId } = await storeWithFeed('A-1', 5);
    feed.csv = vendorCsv([['A-1', 12]]);

    const first = await syncStoreFeed((await getStoreById(storeId))!, true);
    const second = await syncStoreFeed((await getStoreById(storeId))!, true);

    expect(syncedRowCount(first.body), 'first pass writes').toBe(1);
    // Zero, not "one that happened to write the same value". The import resolves an identical row as
    // `unchanged` and skips it entirely, which is also what keeps a re-run from churning the
    // seller's restock notifications.
    expect(syncedRowCount(second.body), 'second pass writes nothing').toBe(0);
    expect(await stockOf(productId)).toBe(12);
  });

  it('is an absolute write, not a delta — five syncs land on the feed\'s number', async () => {
    // This is the property that makes a double-run harmless. A pull that ADDED the feed's quantity
    // would look correct on one run and oversell the moment the lease was ever crossed.
    const { storeId, productId } = await storeWithFeed('A-1', 5);
    feed.csv = vendorCsv([['A-1', 3]]);

    for (let i = 0; i < 5; i += 1) await syncStoreFeed((await getStoreById(storeId))!, true);

    expect(await stockOf(productId)).toBe(3);
  });

  it('follows the feed back DOWN as well as up', async () => {
    const { storeId, productId } = await storeWithFeed('A-1', 40);
    feed.csv = vendorCsv([['A-1', 2]]);
    await syncStoreFeed((await getStoreById(storeId))!, true);
    expect(await stockOf(productId)).toBe(2);

    // Sold out in the seller's own system: the storefront has to follow, or the platform keeps
    // taking orders for units that are gone.
    feed.csv = vendorCsv([['A-1', 0]]);
    await syncStoreFeed((await getStoreById(storeId))!, true);
    expect(await stockOf(productId)).toBe(0);
  });

  it('leaves a product the feed never mentions alone', async () => {
    const { storeId } = await storeWithFeed('A-1', 5);
    const otherId = crypto.randomUUID();
    await query(
      `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock, sku)
       VALUES ($1, $2, 'untouched', 'Untouched', 500, 33, 'B-9')`,
      [otherId, storeId],
    );
    feed.csv = vendorCsv([['A-1', 1]]);

    await syncStoreFeed((await getStoreById(storeId))!, true);

    // A feed is a statement about the skus it lists, never about the ones it omits — a partial
    // export must not read as "everything else is out of stock".
    expect(await stockOf(otherId)).toBe(33);
  });
});

describe('refusing to run', () => {
  it('does not reach the network when the store has no feed URL', async () => {
    const { storeId } = await storeWithFeed('A-1', 5);
    await query('UPDATE stores SET feed_sync = NULL WHERE id = $1', [storeId]);

    const { status, body } = await syncStoreFeed((await getStoreById(storeId))!, true);

    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, error: 'no-feed-url' });
    expect(feed.calls, 'nothing was fetched').toBe(0);
  });

  it('reports the fetch failure without touching the catalog', async () => {
    const { storeId, productId } = await storeWithFeed('A-1', 5);
    const failing = await import('../src/lib/feed-fetch.js');
    const spy = vi.spyOn(failing, 'fetchFeedCsv').mockResolvedValue({ ok: false, error: 'blocked-host' });

    const { status, body } = await syncStoreFeed((await getStoreById(storeId))!, true);

    // 502, because the failure is somebody else's server — not the seller's request.
    expect(status).toBe(502);
    expect(body).toEqual({ ok: false, error: 'feed-blocked-host' });
    expect(await stockOf(productId), 'a failed pull is not a zero-stock feed').toBe(5);
    spy.mockRestore();
  });

  it('treats an empty response as an error rather than as an empty catalog', async () => {
    const { storeId, productId } = await storeWithFeed('A-1', 5);
    feed.csv = '';

    const { status, body } = await syncStoreFeed((await getStoreById(storeId))!, true);

    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, error: 'empty-file' });
    expect(await stockOf(productId)).toBe(5);
  });
});

describe('what a TIMER is allowed to infer — nothing', () => {
  /** The seller confirmed sku + stock, and nothing else. Everything below asks what happens when the
   *  remote file later says more than that. */
  async function mappedSkuAndStockOnly(): Promise<Fixture> {
    return storeWithFeed('A-1', 5);
  }

  it('ignores a column the seller never mapped, however obvious its name', async () => {
    const { storeId, productId } = await mappedSkuAndStockOnly();
    // The supplier adds a price column to their export. Nobody asked for it, and nobody is looking.
    feed.csv = 'Item Code,Qty On Hand,Price\nA-1,4,1.00\n';

    await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    expect(await stockOf(productId), 'the mapped column still applies').toBe(4);
    const { rows } = await query<{ price_agorot: number }>(
      'SELECT price_agorot FROM store_products WHERE id = $1', [productId],
    );
    // 9900 = what the seller set. Under `guessMapping` this would be 100 — a ₪99 product repriced to
    // ₪1 by a remote file, on an hourly timer, with no preview and no seller in the loop.
    expect(rows[0]!.price_agorot, 'an unmapped column may not move money').toBe(9900);
  });

  it('but the seller pressing the button still gets the guess', async () => {
    // The two triggers differ ON PURPOSE, and this is the half that must not be lost: a human sees a
    // preview before anything is written, so guessing for them is a convenience, not a risk.
    const { storeId, productId } = await mappedSkuAndStockOnly();
    feed.csv = 'Item Code,Qty On Hand,Price\nA-1,4,1.00\n';

    await syncStoreFeed((await getStoreById(storeId))!, true, 'seller');

    const { rows } = await query<{ price_agorot: number }>(
      'SELECT price_agorot FROM store_products WHERE id = $1', [productId],
    );
    expect(rows[0]!.price_agorot).toBe(100);
  });

  it('refuses a feed with no matcher column instead of creating the catalogue again', async () => {
    const { storeId } = await mappedSkuAndStockOnly();
    // The supplier renames their sku column. Every row now resolves to nothing to match against, so
    // the import would CREATE all of them — and again an hour later, and again after that.
    feed.csv = 'Product Reference,Qty On Hand\nA-1,4\n';

    const { status, body } = await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled');

    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, error: 'no-matcher-column' });
    const { rows } = await query<{ n: number }>(
      'SELECT COUNT(*)::bigint AS n FROM store_products WHERE store_id = $1', [storeId],
    );
    expect(rows[0]!.n, 'nothing was created').toBe(1);
  });

  it('refuses when the store saved a URL but never confirmed a mapping', async () => {
    const { storeId } = await mappedSkuAndStockOnly();
    await query(`UPDATE stores SET feed_sync = jsonb_build_object('url', 'https://v.example.com/s.csv') WHERE id = $1`, [storeId]);
    feed.csv = vendorCsv([['A-1', 4]]);

    // With no confirmed mapping there is nothing to apply, and inferring one is exactly what this
    // trigger may not do. Refusing is loud (it lands in the job's log line); guessing would be silent.
    expect((await syncStoreFeed((await getStoreById(storeId))!, true, 'scheduled')).body)
      .toEqual({ ok: false, error: 'no-matcher-column' });
  });
});

describe('who the import runs as', () => {
  it('uses the store\'s own seller, so the scheduler needs no session', async () => {
    // The route proved the caller owns the store before calling; the job has no caller at all. Both
    // reach the same import as the store's owner, which is whose stock notifications get cleared.
    const { storeId, productId } = await storeWithFeed('A-1', 5);
    feed.csv = vendorCsv([['A-1', 6]]);
    const store = (await getStoreById(storeId))!;

    await syncStoreFeed(store, true);

    expect(await stockOf(productId)).toBe(6);
    expect((await getProductsByStoreId(storeId)).find((p) => p.id === productId)?.stock).toBe(6);
  });
});
