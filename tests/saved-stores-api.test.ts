import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { storeMark, storeMarkGradient } from '../src/lib/store-mark.js';

/**
 * `/api/saved-stores` — the list behind the header's avatar menu, against a real Postgres and the
 * real modules beneath it. Only the SESSION is stubbed, for the same reason `user-cart-api.test.ts`
 * gives: what this endpoint decides is *whose* list it answers with and *which* of those stores may
 * still be linked to, and both of those are decided here, at the route.
 *
 * Three of the four cases are rules that rot silently rather than breaking loudly:
 *  · a store that got blocked or closed stays in `favorite_stores` forever — nothing deletes the
 *    row — so the menu would keep linking at a URL that answers 404/410 unless the route filters;
 *  · `total` is what tells the menu whether to offer its "all saved stores" link, so it has to
 *    count the stores that SURVIVED that filter, not the raw favourites;
 *  · the cap is what keeps a menu a menu, and a cap with no test is a cap someone raises by
 *    accident.
 */

const BUYER = 'buyer-saved-1';
const OTHER = 'buyer-saved-2';

let session: string | null = BUYER;

vi.mock('../src/lib/seller-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/seller-auth.js')>()),
  getSellerSession: () => session,
}));

const saved = await import('../src/pages/api/saved-stores.js');

const cookies = {} as never;

interface SavedRow { slug: string; name: string; image: string; initial: string; gradient: string }

function get(): Promise<Response> {
  return saved.GET({ cookies } as never) as Promise<Response>;
}

async function body(): Promise<{ total: number; stores: SavedRow[] }> {
  return (await get()).json() as Promise<{ total: number; stores: SavedRow[] }>;
}

let sellerId: string;

/** One store, saved by `userId`. `over` sets the lifecycle/profile columns a case needs. */
async function makeSavedStore(
  userId: string,
  over: { blocked?: boolean; closedAt?: boolean; profileImage?: string; name?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const slug = `saved-${crypto.randomBytes(4).toString('hex')}`;
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, blocked, closed_at, profile_image)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, sellerId, slug, over.name ?? 'חנות', over.blocked ?? false,
      over.closedAt ? new Date().toISOString() : null, over.profileImage ?? null],
  );
  await query('INSERT INTO favorite_stores (user_id, store_id) VALUES ($1, $2)', [userId, id]);
  return slug;
}

beforeEach(async () => {
  session = BUYER;
  await query('DELETE FROM favorite_stores');

  sellerId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${sellerId}@example.test`]);
});

describe('/api/saved-stores', () => {
  it('refuses to answer without a session', async () => {
    session = null;
    expect((await get()).status).toBe(401);
  });

  it('answers with the signed-in account only, never another', async () => {
    const mine = await makeSavedStore(BUYER);
    await makeSavedStore(OTHER);

    expect((await body()).stores.map((s) => s.slug)).toEqual([mine]);

    session = OTHER;
    expect((await body()).stores.map((s) => s.slug)).not.toContain(mine);
  });

  it('drops a saved store whose URL no longer serves a page, and does not count it', async () => {
    const live = await makeSavedStore(BUYER);
    await makeSavedStore(BUYER, { blocked: true });
    await makeSavedStore(BUYER, { closedAt: true });

    const data = await body();
    expect(data.stores.map((s) => s.slug)).toEqual([live]);
    // `total` drives the "all saved stores" link — counted after the filter, so it can never
    // promise a page holding stores the menu was right to hide.
    expect(data.total).toBe(1);
  });

  it('caps the menu at six while total still reports the truth', async () => {
    for (let i = 0; i < 8; i++) await makeSavedStore(BUYER);

    const data = await body();
    expect(data.stores).toHaveLength(6);
    expect(data.total).toBe(8);
  });

  it('carries the store\'s own mark when it has no uploaded logo, and the image when it has one', async () => {
    const bare = await makeSavedStore(BUYER, { name: 'אורה' });
    const withLogo = await makeSavedStore(BUYER, { profileImage: 'https://cdn.test/logo.png' });

    const rows = (await body()).stores;
    const bareRow = rows.find((s) => s.slug === bare)!;
    const logoRow = rows.find((s) => s.slug === withLogo)!;

    // The same identity the store wears on a card — resolved server-side so store-mark.ts stays
    // out of the bundle that loads on every page of the site.
    const mark = storeMark(bare, 'אורה');
    expect(bareRow.initial).toBe(mark.initial);
    expect(bareRow.gradient).toBe(storeMarkGradient(mark));
    expect(bareRow.image).toBe('');
    expect(logoRow.image).toBe('https://cdn.test/logo.png');
  });
});
