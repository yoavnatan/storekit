/**
 * The store record, against a real Postgres — the second module moved off `data/*.json`
 * (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * **Why this file exists, again.** The sellers module taught that §9.1 ("the existing tests pass
 * unchanged") only proves something when there are tests that could fail. For stores the suite
 * covered the PURE half well — `store-slug.test.ts` pins `normalizeSlug`, `isReservedSlug`,
 * `computeNextPreviousSlugs`, `storeClaimsSlug` — and the I/O half not at all: nothing exercised
 * `getStoreBySlug`, `createStore`, `updateStore`, `renameStoreSlug` or the three discovery lists,
 * so a swap that returned null for every store would have stayed green.
 *
 * So this pins the behaviour the file-backed version had, plus the four things the move was meant
 * to gain: a slug race the index settles (§7.4), a 301 that survives a rename, absent-vs-null on
 * every optional field, and flags that are `false` rather than `NULL` (§7.12).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import {
  MAX_PREVIOUS_SLUGS,
  MAX_STORES_PER_SELLER,
  MAX_STORE_BG_COLORS,
  addStoreBgColor,
  canOpenAnotherStore,
  createStore,
  getAllStores,
  getDemoStores,
  getIndexableStores,
  getStoreByCustomDomain,
  claimCustomDomainHostname,
  getStoreByExportToken,
  getStoreById,
  getStoreByPreviousCustomDomain,
  getStoreByPreviousSlug,
  getStoreBySellerId,
  getStoreBySlug,
  getStoreBySlugOrPrevious,
  getStoresBySellerId,
  getVisibleStores,
  isCustomDomainTaken,
  isSlugTaken,
  rememberPreviousCustomDomain,
  renameStoreSlug,
  updateStore,
} from '../src/lib/stores.js';

const DANA = '11111111-1111-4111-8111-000000000001';
const KERAMIKA = '22222222-2222-4222-8222-000000000001';

/** A seller of this test's own, so a store cap test cannot be thrown off by fixture rows. */
async function freshSeller(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [id, `${id}@example.test`],
  );
  return id;
}

/** A unique slug base per call — tests run in one database and must not collide with each other. */
let seq = 0;
function freshBase(): string {
  seq += 1;
  return `t${seq}-${crypto.randomBytes(3).toString('hex')}`;
}

describe('reading a store', () => {
  it('returns the record behind a slug, an id and a seller', async () => {
    const bySlug = await getStoreBySlug('keramika');
    expect(bySlug).toMatchObject({ id: KERAMIKA, sellerId: DANA, slug: 'keramika', name: 'קרמיקה' });
    expect((await getStoreById(KERAMIKA))?.slug).toBe('keramika');
    expect((await getStoreBySellerId(DANA))?.id).toBe(KERAMIKA);
    expect((await getStoresBySellerId(DANA)).map((s) => s.id)).toContain(KERAMIKA);
  });

  it('answers "no such store" for an id that is not a uuid, instead of raising', async () => {
    // Postgres REJECTS a malformed uuid literal rather than not matching it — without the shape
    // check a stale dashboard id is a 500 where the honest answer is "not found".
    await expect(getStoreById('store-1')).resolves.toBeNull();
    await expect(getStoreById('')).resolves.toBeNull();
    await expect(getStoresBySellerId("' OR 1=1 --")).resolves.toEqual([]);
    await expect(getStoreBySlug('')).resolves.toBeNull();
  });

  it('keeps optional fields ABSENT rather than null, and the three arrays always present', async () => {
    const store = (await getStoreBySlug('tachshitim'))!;
    // ~40 call sites read `store.sale?.active` / `store.address ?? ''`; a null behaves differently.
    for (const key of ['sale', 'address', 'bannerImage', 'profileImage', 'hours', 'feedSync',
      'feedExportToken', 'customDomain', 'pausedAt', 'closePendingAt', 'closedAt']) {
      expect(store).not.toHaveProperty(key);
    }
    expect(store.categories).toEqual([]);
    expect(store.bgColors).toEqual([]);
    expect(store.previousSlugs).toEqual([]);
  });

  it('reads an absent flag as absent, not as a NULL that no filter matches (§7.12)', async () => {
    const store = (await getStoreBySlug('keramika'))!;
    // The fixture row carries none of these. In SQL a NULL answers neither `= true` nor `= false`,
    // so the import writes `false` — and this store must stay in every filtered list.
    expect(store.blocked).toBeUndefined();
    expect(store.demo).toBeUndefined();
    expect(store.addressVisible).toBeUndefined();
    const { rows } = await query<{ blocked: boolean | null }>(
      'SELECT blocked FROM stores WHERE id = $1', [KERAMIKA],
    );
    expect(rows[0]!.blocked).toBe(false);
    expect((await getVisibleStores()).map((s) => s.id)).toContain(KERAMIKA);
  });

  it('does not fold case when RESOLVING a slug, though the column is citext', async () => {
    // citext is there so `Acme` and `acme` cannot become two stores. Serving BOTH URLs is the
    // opposite problem — one store at every capitalisation of its name, all duplicate content.
    await expect(getStoreBySlug('KERAMIKA')).resolves.toBeNull();
    await expect(getStoreBySlug('Keramika')).resolves.toBeNull();
    // …but the uniqueness side does fold, which is what stops the second store existing.
    await expect(isSlugTaken('KERAMIKA', crypto.randomUUID())).resolves.toBe(true);
  });

  it('returns a stable order, not the order the rows happen to sit in (§7.13)', async () => {
    const first = (await getAllStores()).map((s) => s.id);
    await query('UPDATE stores SET name = name WHERE id = $1', [KERAMIKA]);
    expect((await getAllStores()).map((s) => s.id)).toEqual(first);
  });
});

describe('opening a store', () => {
  it('creates it with the default colours and the slug the seller asked for', async () => {
    const base = freshBase();
    const store = await createStore(DANA, { name: 'X', slug: base, tagline: 'tl' });
    expect(store).toMatchObject({ slug: base, name: 'X', tagline: 'tl', sellerId: DANA });
    expect(store.colors).toEqual({ primary: '#1e7a46', accent: '#f97316' });
    expect((await getStoreBySlug(base))?.id).toBe(store.id);
  });

  it('bumps a slug another LIVE store already holds — the index decides, not a prior read (§7.4)', async () => {
    const base = freshBase();
    const a = await createStore(DANA, { name: 'A', slug: base });
    const b = await createStore(DANA, { name: 'B', slug: base });
    expect(a.slug).toBe(base);
    expect(b.slug).toBe(`${base}-2`);
  });

  it('never hands a new store a slug some other store RETIRED', async () => {
    // The retired slug still 301s to its original owner. Giving it to a new store would make the
    // new store's live slug win resolution, and the old link would silently stop arriving.
    const base = freshBase();
    const owner = await createStore(DANA, { name: 'A', slug: base });
    await renameStoreSlug(owner.id, `${base}-new`);
    const other = await createStore(DANA, { name: 'B', slug: base });
    expect(other.slug).not.toBe(base);
    expect((await getStoreByPreviousSlug(base))?.id).toBe(owner.id);
  });

  it('two sellers opening the same slug at the same moment get two different URLs', async () => {
    // The file version read, found the slug free in both requests, and wrote — the second silently
    // took the first's URL. Here one attempt returns zero rows and retries.
    const base = freshBase();
    const [a, b] = await Promise.all([
      createStore(DANA, { name: 'A', slug: base }),
      createStore(DANA, { name: 'B', slug: base }),
    ]);
    expect(a.slug).not.toBe(b.slug);
    expect(new Set([a.slug, b.slug]).size).toBe(2);
  });

  it('skips a reserved platform path instead of minting an unreachable store', async () => {
    const store = await createStore(DANA, { name: 'Checkout', slug: 'checkout' });
    expect(store.slug).toBe('checkout-2');
  });

  it('caps a seller at MAX_STORES_PER_SELLER', async () => {
    const seller = await freshSeller();
    for (let i = 0; i < MAX_STORES_PER_SELLER; i += 1) {
      expect(await canOpenAnotherStore(seller)).toBe(true);
      await createStore(seller, { name: `S${i}`, slug: freshBase() });
    }
    expect(await canOpenAnotherStore(seller)).toBe(false);
    expect((await getStoresBySellerId(seller)).length).toBe(MAX_STORES_PER_SELLER);
  });
});

describe('updating a store', () => {
  it('writes only the fields the call carried, leaving the rest alone', async () => {
    const store = await createStore(DANA, { name: 'Before', slug: freshBase(), tagline: 'keep me' });
    await updateStore(store.id, { name: 'After' });
    const after = (await getStoreById(store.id))!;
    expect(after.name).toBe('After');
    // The record-rev rule: a save carrying one field must never revert one it did not carry.
    expect(after.tagline).toBe('keep me');
  });

  it('treats a PRESENT key holding undefined as "clear it", which is how a store reopens', async () => {
    const store = await createStore(DANA, { name: 'P', slug: freshBase() });
    await updateStore(store.id, { pausedAt: '2026-02-01T00:00:00.000Z', address: 'somewhere' });
    expect((await getStoreById(store.id))?.pausedAt).toBeTruthy();
    await updateStore(store.id, { pausedAt: undefined });
    const after = (await getStoreById(store.id))!;
    expect(after).not.toHaveProperty('pausedAt');
    expect(after.address).toBe('somewhere');
  });

  it('round-trips the uncropped originals behind the two store images (0012)', async () => {
    const store = await createStore(DANA, { name: 'Img', slug: freshBase() });
    // Nothing uploaded yet, and nothing uploaded before the column existed: absent, not null —
    // the widget reads `?? ''` into a hidden input, and a null would render the string "null".
    expect(store).not.toHaveProperty('profileImageSource');
    expect(store).not.toHaveProperty('bannerImageSource');

    const crop = 'https://res.cloudinary.com/demo/image/upload/v1/avatar-crop.png';
    const source = 'https://res.cloudinary.com/demo/image/upload/v1/avatar-source.jpg';
    await updateStore(store.id, { profileImage: crop, profileImageSource: source });
    const after = (await getStoreById(store.id))!;
    expect(after.profileImage).toBe(crop);
    expect(after.profileImageSource).toBe(source);
    // The site never serves the source — only the crop — so the two must stay distinguishable.
    expect(after.bannerImageSource).toBeUndefined();

    // Removing the image clears its original too: nothing can reach it afterwards.
    await updateStore(store.id, { profileImage: undefined, profileImageSource: undefined });
    const cleared = (await getStoreById(store.id))!;
    expect(cleared).not.toHaveProperty('profileImage');
    expect(cleared).not.toHaveProperty('profileImageSource');
  });

  it('round-trips the nested records the storefront renders', async () => {
    const store = await createStore(DANA, { name: 'N', slug: freshBase() });
    const hours = { sun: { closed: false, open: '09:00', close: '17:00' } } as never;
    await updateStore(store.id, {
      categories: ['בית', 'מתנות'],
      shipping: { selfPickup: true },
      sale: { active: true, percent: 30, headline: 'sale' } as never,
      hours,
      hoursVisible: true,
      feedSync: { url: 'https://f.example/x.csv', mapping: { A: 'sku' } },
      customDomain: { hostname: 'shop.example.test', status: 'pending', addedAt: '2026-02-01T00:00:00.000Z' },
    });
    const after = (await getStoreById(store.id))!;
    expect(after.categories).toEqual(['בית', 'מתנות']);
    expect(after.shipping).toEqual({ selfPickup: true });
    expect(after.sale).toMatchObject({ active: true, percent: 30 });
    expect(after.hours).toEqual(hours);
    expect(after.hoursVisible).toBe(true);
    expect(after.feedSync).toEqual({ url: 'https://f.example/x.csv', mapping: { A: 'sku' } });
    expect(after.customDomain).toMatchObject({ hostname: 'shop.example.test', status: 'pending' });
  });

  it('clears the whole custom domain together, never a status without a hostname', async () => {
    const store = await createStore(DANA, { name: 'D', slug: freshBase() });
    const hostname = `${freshBase()}.example.test`;
    await updateStore(store.id, { customDomain: { hostname, status: 'active', addedAt: '2026-02-01T00:00:00.000Z' } });
    expect((await getStoreByCustomDomain(hostname.toUpperCase()))?.id).toBe(store.id);
    await updateStore(store.id, { customDomain: undefined });
    expect(await getStoreByCustomDomain(hostname)).toBeNull();
    const { rows } = await query<{ custom_domain_status: string | null }>(
      'SELECT custom_domain_status FROM stores WHERE id = $1', [store.id],
    );
    expect(rows[0]!.custom_domain_status).toBeNull();
  });

  it('serves a custom domain only once it is verified', async () => {
    const store = await createStore(DANA, { name: 'D', slug: freshBase() });
    const hostname = `${freshBase()}.example.test`;
    await updateStore(store.id, { customDomain: { hostname, status: 'pending', addedAt: '2026-02-01T00:00:00.000Z' } });
    // A pending domain must never route — an unverified hostname could otherwise hijack a store.
    expect(await getStoreByCustomDomain(hostname)).toBeNull();
  });

  /**
   * Migration 0029. A pending claim is an ASSERTION — the settings field takes any string — so it
   * may not exclude anybody. It used to, because the column was globally UNIQUE, which handed every
   * seller a free permanent squat: type a hostname you do not own, it can never verify, and its real
   * owner is answered `domain-taken` from then on. Only a hostname actually being SERVED conflicts,
   * because only routing can be ambiguous.
   */
  it('lets two stores claim one hostname, and refuses only once one is served on it', async () => {
    const squatter = await createStore(DANA, { name: 'S', slug: freshBase() });
    const owner = await createStore(DANA, { name: 'O', slug: freshBase() });
    const hostname = `${freshBase()}.example.test`;

    await updateStore(squatter.id, { customDomain: { hostname, status: 'pending', addedAt: '2026-02-01T00:00:00.000Z' } });
    expect(await isCustomDomainTaken(hostname, owner.id)).toBe(false);
    // …and the schema agrees: the real owner can store their own claim on the same hostname.
    await updateStore(owner.id, { customDomain: { hostname, status: 'pending', addedAt: '2026-02-02T00:00:00.000Z' } });
    expect(await getStoreByCustomDomain(hostname)).toBeNull();

    // Whichever one verifies is the one that becomes real, and from then on it is the other's to be
    // refused — and the partial index refuses a second `active` row outright.
    await updateStore(owner.id, { customDomain: { hostname, status: 'active', addedAt: '2026-02-02T00:00:00.000Z' } });
    expect((await getStoreByCustomDomain(hostname))?.id).toBe(owner.id);
    expect(await isCustomDomainTaken(hostname, squatter.id)).toBe(true);
    expect(await isCustomDomainTaken(hostname, owner.id)).toBe(false);
    await expect(
      updateStore(squatter.id, { customDomain: { hostname, status: 'active', addedAt: '2026-02-01T00:00:00.000Z' } }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  /**
   * Area audit row 5 (2026-08-16). The 301 memory of a store that MOVED lives in a different table
   * from the hostname's uniqueness, so `stores.custom_domain_hostname UNIQUE` does not protect it:
   * once a store has moved off `old.example`, nothing holds that string in `stores` and any seller
   * could register it — which used to delete the previous owner's row on the spot, turning every
   * link, bookmark and indexed page that store earned there into a 404, permanently and with no
   * error anywhere. Typing a hostname is not evidence of owning it; verifying it is.
   */
  it('keeps a previous domain redirecting until someone actually verifies that hostname', async () => {
    const mover = await createStore(DANA, { name: 'M', slug: freshBase() });
    const hostname = `${freshBase()}.example.test`;
    await updateStore(mover.id, { customDomain: { hostname, status: 'active', addedAt: '2026-02-01T00:00:00.000Z' } });
    await rememberPreviousCustomDomain(mover.id, hostname);
    await updateStore(mover.id, { customDomain: undefined });
    expect((await getStoreByPreviousCustomDomain(hostname))?.id).toBe(mover.id);

    // A second store now registers that hostname — allowed, since no store holds it any more. Its
    // record is `pending` and nothing about the mover's redirect may change.
    const claimer = await createStore(DANA, { name: 'C', slug: freshBase() });
    await updateStore(claimer.id, { customDomain: { hostname, status: 'pending', addedAt: '2026-03-01T00:00:00.000Z' } });
    expect((await getStoreByPreviousCustomDomain(hostname))?.id).toBe(mover.id);

    // Only the proven claim takes it — which is what `custom-domain-verify.ts` calls on promotion.
    await claimCustomDomainHostname(hostname);
    expect(await getStoreByPreviousCustomDomain(hostname)).toBeNull();
  });

  it('resolves the export token, and rotating it invalidates the old URL at once', async () => {
    const store = await createStore(DANA, { name: 'F', slug: freshBase() });
    const first = crypto.randomBytes(24).toString('hex');
    await updateStore(store.id, { feedExportToken: first });
    expect((await getStoreByExportToken(first))?.id).toBe(store.id);
    await updateStore(store.id, { feedExportToken: undefined });
    expect(await getStoreByExportToken(first)).toBeNull();
    expect(await getStoreByExportToken('')).toBeNull();
  });

  it('ignores a key that is not a real field, including an inherited one', async () => {
    const store = await createStore(DANA, { name: 'K', slug: freshBase() });
    // `UPDATABLE['toString']` resolves to Function.prototype.toString — truthy, and with no `.sql`.
    // A truthy lookup instead of `Object.hasOwn` crashes here the moment a caller forwards a parsed
    // request body rather than an object literal.
    const hostile = { toString: 'x', constructor: 'y', nope: 1, name: 'K2' } as unknown as Parameters<typeof updateStore>[1];
    expect((await updateStore(store.id, hostile))?.name).toBe('K2');
  });

  it('returns null for a store that does not exist, rather than reporting a write', async () => {
    expect(await updateStore(crypto.randomUUID(), { name: 'x' })).toBeNull();
    expect(await updateStore('not-a-uuid', { name: 'x' })).toBeNull();
  });
});

describe('renaming the URL', () => {
  it('moves the store and keeps the old slug resolving, so old links and Google transfer', async () => {
    const base = freshBase();
    const store = await createStore(DANA, { name: 'R', slug: base });
    const renamed = await renameStoreSlug(store.id, `${base}-two`);
    expect(renamed?.slug).toBe(`${base}-two`);
    expect(await getStoreBySlug(base)).toBeNull();
    expect((await getStoreByPreviousSlug(base))?.id).toBe(store.id);
    // The checkout path: a cart holds the slug from when the item was added.
    expect((await getStoreBySlugOrPrevious(base))?.slug).toBe(`${base}-two`);
    expect(renamed?.previousSlugs).toEqual([base]);
  });

  it('keeps the history in rename order, oldest first — not alphabetically', async () => {
    const base = freshBase();
    const store = await createStore(DANA, { name: 'R', slug: `${base}-zzz` });
    await renameStoreSlug(store.id, `${base}-mmm`);
    await renameStoreSlug(store.id, `${base}-aaa`);
    const after = (await getStoreById(store.id))!;
    expect(after.previousSlugs).toEqual([`${base}-zzz`, `${base}-mmm`]);
  });

  it('reclaims its own old slug on a revert, instead of 301-ing the store to itself', async () => {
    const base = freshBase();
    const store = await createStore(DANA, { name: 'R', slug: base });
    await renameStoreSlug(store.id, `${base}-two`);
    const back = await renameStoreSlug(store.id, base);
    expect(back?.slug).toBe(base);
    expect(back?.previousSlugs).toEqual([`${base}-two`]);
    expect(await getStoreByPreviousSlug(base)).toBeNull();
  });

  it('caps the remembered slugs at MAX_PREVIOUS_SLUGS, dropping the oldest', async () => {
    const base = freshBase();
    const store = await createStore(DANA, { name: 'R', slug: `${base}-0` });
    for (let i = 1; i <= MAX_PREVIOUS_SLUGS + 2; i += 1) await renameStoreSlug(store.id, `${base}-${i}`);
    const after = (await getStoreById(store.id))!;
    expect(after.previousSlugs).toHaveLength(MAX_PREVIOUS_SLUGS);
    expect(after.previousSlugs![0]).toBe(`${base}-2`);
    expect(await getStoreBySlug(`${base}-0`)).toBeNull();
    expect(await getStoreByPreviousSlug(`${base}-0`)).toBeNull();
  });

  it('is a no-op when the slug is unchanged, and null for a store that is gone', async () => {
    const base = freshBase();
    const store = await createStore(DANA, { name: 'R', slug: base });
    expect((await renameStoreSlug(store.id, base))?.previousSlugs).toEqual([]);
    expect(await renameStoreSlug(crypto.randomUUID(), 'x')).toBeNull();
  });

  it('reports a retired slug as taken, so a rename cannot steal one', async () => {
    const base = freshBase();
    const store = await createStore(DANA, { name: 'R', slug: base });
    await renameStoreSlug(store.id, `${base}-two`);
    expect(await isSlugTaken(base, crypto.randomUUID())).toBe(true);
    // …but its own owner may rename back to it.
    expect(await isSlugTaken(base, store.id)).toBe(false);
  });
});

describe('the discovery lists', () => {
  it('drops a blocked store from every surface but keeps it in the admin roster', async () => {
    const store = await createStore(DANA, { name: 'B', slug: freshBase() });
    await updateStore(store.id, { blocked: true });
    expect((await getVisibleStores()).map((s) => s.id)).not.toContain(store.id);
    expect((await getIndexableStores()).map((s) => s.id)).not.toContain(store.id);
    expect((await getAllStores()).map((s) => s.id)).toContain(store.id);
  });

  it('drops a paused store from discovery — its own URL stays up, that is store-status.ts', async () => {
    const store = await createStore(DANA, { name: 'P', slug: freshBase() });
    await updateStore(store.id, { pausedAt: new Date().toISOString() });
    expect((await getVisibleStores()).map((s) => s.id)).not.toContain(store.id);
    expect((await getStoreById(store.id))?.id).toBe(store.id);
  });

  it('keeps a showcase store out of everything a search engine or a feed may see', async () => {
    const store = await createStore(DANA, { name: 'Demo', slug: freshBase() });
    await updateStore(store.id, { demo: true });
    expect((await getIndexableStores()).map((s) => s.id)).not.toContain(store.id);
    expect((await getDemoStores()).map((s) => s.id)).toContain(store.id);
  });

  it('treats a soft-deleted store as gone everywhere, without losing the row (§7.9)', async () => {
    // Its orders point at it and are financial records, so the row must survive the disappearance.
    const store = await createStore(DANA, { name: 'X', slug: freshBase() });
    await query('UPDATE stores SET deleted_at = now() WHERE id = $1', [store.id]);
    expect(await getStoreById(store.id)).toBeNull();
    expect(await getStoreBySlug(store.slug)).toBeNull();
    expect((await getAllStores()).map((s) => s.id)).not.toContain(store.id);
    expect((await getStoresBySellerId(DANA)).map((s) => s.id)).not.toContain(store.id);
    const { rows } = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM stores WHERE id = $1', [store.id]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('the saved background palette', () => {
  it('prepends, dedupes case-insensitively and caps', async () => {
    const store = await createStore(DANA, { name: 'C', slug: freshBase() });
    expect(await addStoreBgColor(store.id, '#aabbcc')).toEqual(['#aabbcc']);
    expect(await addStoreBgColor(store.id, '#112233')).toEqual(['#112233', '#aabbcc']);
    // Re-picking a colour moves it to the front rather than storing it twice.
    expect(await addStoreBgColor(store.id, '#AABBCC')).toEqual(['#AABBCC', '#112233']);
    for (let i = 0; i < MAX_STORE_BG_COLORS + 3; i += 1) {
      await addStoreBgColor(store.id, `#0000${i.toString(16).padStart(2, '0')}`);
    }
    expect((await getStoreById(store.id))?.bgColors).toHaveLength(MAX_STORE_BG_COLORS);
  });

  it('returns null for a store that does not exist', async () => {
    expect(await addStoreBgColor(crypto.randomUUID(), '#aabbcc')).toBeNull();
    expect(await addStoreBgColor('not-a-uuid', '#aabbcc')).toBeNull();
  });
});
