/**
 * The per-store category tree, against a real Postgres — the third module moved off `data/*.json`
 * (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * **Written from scratch, for the third time, for the same reason.** §9.1 ("the existing tests pass
 * unchanged") only proves something when a test could have failed. The suite covered this module's
 * PURE half — `store-category-counts.test.ts` pins `countProductsPerCategory` — and its I/O half not
 * at all: every other test that reached a category MOCKED `getCategoriesByStoreId`
 * (`sale-scope.test.ts`, `ad-campaign-scope.test.ts`, `ad-campaign-health.test.ts`), so a swap that
 * returned an empty tree for every store would have stayed green in 125 files.
 *
 * So this pins the behaviour the file-backed version had, plus the four things the move was meant to
 * gain: a duplicate sibling name settled by an index rather than by a read before the write (§7.4), a
 * `position` that two simultaneous creates cannot share, a delete whose "has children" guard is part
 * of the statement, and a reorder that still moves something when two rows carry the same position.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import {
  MAX_CATEGORY_DEPTH,
  MAX_CATEGORY_NAME_LENGTH,
  createCategory,
  deleteCategory,
  getCategoriesByStoreId,
  getCategoryById,
  moveCategory,
  renameCategory,
  resolveOrCreateCategoryPaths,
} from '../src/lib/store-categories.js';

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const HOUSEWARES = '33333333-3333-4333-8333-000000000001'; // "כלי בית", root
const CUPS = '33333333-3333-4333-8333-000000000002';       // "כוסות", beneath it

/** A store of this test's own, so ordering and name-collision tests cannot disturb each other. */
let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `cat-test-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

/** The id of a freshly created category, or a thrown assertion — keeps every test below flat. */
async function add(storeId: string, name: string, parentId: string | null = null): Promise<string> {
  const created = await createCategory(storeId, { name, parentId });
  if ('error' in created) throw new Error(`createCategory(${name}) failed: ${created.error}`);
  return created.id;
}

describe('reading the tree', () => {
  it('returns a store\'s own categories, with the parent link the import preserved', async () => {
    const categories = await getCategoriesByStoreId(KERAMIKA);
    expect(categories.map((c) => c.id)).toEqual([HOUSEWARES, CUPS]);
    // The child's parent survived the import. It is asserted here because the import writes the
    // whole tree in one pass now, parents first — the previous shape (insert flat, then UPDATE the
    // links) could not coexist with the sibling-name index.
    expect(categories.find((c) => c.id === CUPS)).toMatchObject({
      storeId: KERAMIKA, name: 'כוסות', parentId: HOUSEWARES, order: 1,
    });
    expect(categories.find((c) => c.id === HOUSEWARES)?.parentId).toBeNull();
  });

  it('returns them in position order, and breaks a tie the same way twice', async () => {
    const storeId = await freshStore();
    const ids = [await add(storeId, 'א'), await add(storeId, 'ב'), await add(storeId, 'ג')];
    // §7.13: a table has no natural order. Every row here shares `now()` to the microsecond in
    // PGlite, so the tie-break on id is what makes two reads agree.
    expect((await getCategoriesByStoreId(storeId)).map((c) => c.id)).toEqual(ids);
    expect((await getCategoriesByStoreId(storeId)).map((c) => c.id)).toEqual(ids);
  });

  it('answers "nothing" for a malformed id instead of raising (§7 uuid shape)', async () => {
    // Postgres REJECTS a malformed uuid literal rather than failing to match it, so a stale
    // dashboard URL would otherwise 500 the page that asked.
    expect(await getCategoriesByStoreId('store-1')).toEqual([]);
    expect(await getCategoryById('c1')).toBeNull();
    expect(await getCategoryById(crypto.randomUUID())).toBeNull();
  });

  it('never leaks another store\'s categories', async () => {
    const storeId = await freshStore();
    await add(storeId, 'שלי');
    expect((await getCategoriesByStoreId(KERAMIKA)).map((c) => c.name)).not.toContain('שלי');
  });
});

describe('creating', () => {
  it('appends after the last sibling, per level', async () => {
    const storeId = await freshStore();
    const first = await add(storeId, 'ריהוט');
    const second = await add(storeId, 'תאורה');
    expect((await getCategoryById(first))?.order).toBe(0);
    expect((await getCategoryById(second))?.order).toBe(1);
    // A child starts its own numbering rather than continuing its parent's.
    expect((await getCategoryById(await add(storeId, 'כיסאות', first)))?.order).toBe(0);
  });

  it('refuses a blank name and an unknown store', async () => {
    const storeId = await freshStore();
    expect(await createCategory(storeId, { name: '   ' })).toEqual({ error: 'שם קטגוריה נדרש.' });
    expect(await createCategory('store-1', { name: 'x' })).toMatchObject({ error: expect.any(String) });
    expect(await getCategoriesByStoreId(storeId)).toEqual([]);
  });

  // A hand-built POST and a CSV cell both reach this module without passing the inputs' maxlength.
  // Since the sibling-name index went in, an oversized name is not merely silly — a btree tuple has
  // a hard size limit, so it would raise and hand the seller a 500 on a form that used to work.
  it('refuses a name no chip could hold, on create and on rename', async () => {
    const storeId = await freshStore();
    const tooLong = 'א'.repeat(MAX_CATEGORY_NAME_LENGTH + 1);
    expect(await createCategory(storeId, { name: tooLong })).toMatchObject({ error: expect.stringContaining('ארוך') });
    expect(await createCategory(storeId, { name: 'א'.repeat(MAX_CATEGORY_NAME_LENGTH) })).toMatchObject({ name: expect.any(String) });
    const id = await add(storeId, 'ריהוט');
    expect(await renameCategory(id, tooLong)).toMatchObject({ error: expect.stringContaining('ארוך') });
    // A 3-kilobyte one is the case that would actually raise rather than merely look wrong.
    expect(await createCategory(storeId, { name: 'x'.repeat(3000) })).toMatchObject({ error: expect.any(String) });
    expect(await getCategoriesByStoreId(storeId)).toHaveLength(2);
  });

  it('refuses a duplicate name among siblings, but allows it under a different parent', async () => {
    const storeId = await freshStore();
    const men = await add(storeId, 'גברים');
    const women = await add(storeId, 'נשים');
    await add(storeId, 'חולצות', men);
    expect(await createCategory(storeId, { name: 'חולצות', parentId: men }))
      .toEqual({ error: 'כבר קיימת קטגוריה בשם הזה באותה רמה.' });
    // The same word under another branch is an ordinary catalog, not a collision — this is the case
    // the flat-then-link import shape could not have survived.
    expect(await createCategory(storeId, { name: 'חולצות', parentId: women })).toMatchObject({ name: 'חולצות' });
    expect(await createCategory(storeId, { name: 'גברים' })).toMatchObject({ error: expect.any(String) });
  });

  it('settles two simultaneous creates of the same name with the index, not with luck (§7.4)', async () => {
    const storeId = await freshStore();
    const outcomes = await Promise.all([
      createCategory(storeId, { name: 'מבצעים' }),
      createCategory(storeId, { name: 'מבצעים' }),
    ]);
    expect(outcomes.filter((o) => !('error' in o))).toHaveLength(1);
    expect(await getCategoriesByStoreId(storeId)).toHaveLength(1);
  });

  it('gives two simultaneous creates different positions', async () => {
    const storeId = await freshStore();
    await Promise.all([
      createCategory(storeId, { name: 'א' }),
      createCategory(storeId, { name: 'ב' }),
      createCategory(storeId, { name: 'ג' }),
    ]);
    const orders = (await getCategoriesByStoreId(storeId)).map((c) => c.order);
    expect([...new Set(orders)]).toHaveLength(3);
  });

  it('refuses a parent that belongs to another store, with the same answer as one that does not exist', async () => {
    const storeId = await freshStore();
    const foreign = await createCategory(storeId, { name: 'x', parentId: HOUSEWARES });
    expect(foreign).toEqual({ error: 'קטגוריית האב לא נמצאה.' });
    expect(await createCategory(storeId, { name: 'x', parentId: crypto.randomUUID() }))
      .toEqual({ error: 'קטגוריית האב לא נמצאה.' });
    expect(await createCategory(storeId, { name: 'x', parentId: 'not-a-uuid' }))
      .toEqual({ error: 'קטגוריית האב לא נמצאה.' });
  });

  it('stops nesting at MAX_CATEGORY_DEPTH', async () => {
    const storeId = await freshStore();
    let parentId: string | null = null;
    for (let level = 0; level < MAX_CATEGORY_DEPTH; level += 1) parentId = await add(storeId, `L${level}`, parentId);
    expect(await createCategory(storeId, { name: 'too deep', parentId }))
      .toEqual({ error: `לא ניתן לקנן יותר מ-${MAX_CATEGORY_DEPTH} רמות.` });
  });
});

describe('renaming', () => {
  it('renames, and lets a category keep the name it already holds', async () => {
    const storeId = await freshStore();
    const id = await add(storeId, 'ריהוט');
    expect(await renameCategory(id, '  ריהוט גן  ')).toMatchObject({ id, name: 'ריהוט גן' });
    expect(await renameCategory(id, 'ריהוט גן')).toMatchObject({ id, name: 'ריהוט גן' });
  });

  it('refuses a sibling\'s name, a blank one, and an id that is not there', async () => {
    const storeId = await freshStore();
    const first = await add(storeId, 'ריהוט');
    const second = await add(storeId, 'תאורה');
    expect(await renameCategory(second, 'ריהוט')).toEqual({ error: 'כבר קיימת קטגוריה בשם הזה באותה רמה.' });
    expect(await renameCategory(second, '  ')).toEqual({ error: 'שם קטגוריה נדרש.' });
    expect(await renameCategory(crypto.randomUUID(), 'x')).toEqual({ error: 'הקטגוריה לא נמצאה.' });
    expect(await renameCategory('c1', 'x')).toEqual({ error: 'הקטגוריה לא נמצאה.' });
    // The refused rename changed nothing.
    expect((await getCategoryById(second))?.name).toBe('תאורה');
    expect((await getCategoryById(first))?.name).toBe('ריהוט');
  });

  it('lets a name be reused under a different parent', async () => {
    const storeId = await freshStore();
    const men = await add(storeId, 'גברים');
    const women = await add(storeId, 'נשים');
    await add(storeId, 'חולצות', men);
    const other = await add(storeId, 'טי-שירט', women);
    expect(await renameCategory(other, 'חולצות')).toMatchObject({ name: 'חולצות' });
  });
});

describe('deleting', () => {
  it('refuses while subcategories exist, and succeeds once they are gone', async () => {
    const storeId = await freshStore();
    const parent = await add(storeId, 'ביגוד');
    const child = await add(storeId, 'חולצות', parent);
    expect(await deleteCategory(parent)).toEqual({ error: 'יש למחוק קודם את תתי-הקטגוריות.' });
    expect(await getCategoryById(child)).not.toBeNull();
    expect(await deleteCategory(child)).toEqual({ ok: true });
    expect(await deleteCategory(parent)).toEqual({ ok: true });
    expect(await getCategoriesByStoreId(storeId)).toEqual([]);
  });

  it('tells an unknown id apart from a blocked one', async () => {
    expect(await deleteCategory(crypto.randomUUID())).toEqual({ error: 'הקטגוריה לא נמצאה.' });
    expect(await deleteCategory('c1')).toEqual({ error: 'הקטגוריה לא נמצאה.' });
  });

  it('leaves a product filed under it — the product just loses its category', async () => {
    const storeId = await freshStore();
    const id = await add(storeId, 'ריהוט');
    const productId = crypto.randomUUID();
    await query(
      `INSERT INTO store_products (id, store_id, slug, name, price_agorot, category_id)
       VALUES ($1, $2, 'chair', 'כיסא', 9900, $3)`,
      [productId, storeId, id],
    );
    expect(await deleteCategory(id)).toEqual({ ok: true });
    const product = await query<{ category_id: string | null }>(
      'SELECT category_id FROM store_products WHERE id = $1', [productId],
    );
    expect(product.rows[0]?.category_id).toBeNull();
  });
});

describe('reordering', () => {
  const names = async (storeId: string) => (await getCategoriesByStoreId(storeId)).map((c) => c.name);

  it('moves one step up and one step down among its siblings', async () => {
    const storeId = await freshStore();
    await add(storeId, 'א');
    const b = await add(storeId, 'ב');
    await add(storeId, 'ג');
    expect(await moveCategory(b, 'up')).toEqual({ ok: true });
    expect(await names(storeId)).toEqual(['ב', 'א', 'ג']);
    expect(await moveCategory(b, 'down')).toEqual({ ok: true });
    expect(await names(storeId)).toEqual(['א', 'ב', 'ג']);
  });

  it('is a silent no-op at either edge, and an error only for an id that is not there', async () => {
    const storeId = await freshStore();
    const first = await add(storeId, 'א');
    const last = await add(storeId, 'ב');
    expect(await moveCategory(first, 'up')).toEqual({ ok: true });
    expect(await moveCategory(last, 'down')).toEqual({ ok: true });
    expect(await names(storeId)).toEqual(['א', 'ב']);
    expect(await moveCategory(crypto.randomUUID(), 'up')).toEqual({ error: 'הקטגוריה לא נמצאה.' });
    expect(await moveCategory('c1', 'up')).toEqual({ error: 'הקטגוריה לא נמצאה.' });
  });

  it('still moves when two siblings share a position — what a swap could not do', async () => {
    const storeId = await freshStore();
    const a = await add(storeId, 'א');
    const b = await add(storeId, 'ב');
    // The shape every JSON-era row arrives in when its file kept them all at 0.
    await query('UPDATE store_categories SET position = 0 WHERE id IN ($1, $2)', [a, b]);
    expect(await moveCategory(b, 'up')).toEqual({ ok: true });
    expect(await names(storeId)).toEqual(['ב', 'א']);
  });

  it('reorders only within one parent', async () => {
    const storeId = await freshStore();
    const parent = await add(storeId, 'ביגוד');
    const other = await add(storeId, 'הנעלה');
    const child = await add(storeId, 'חולצות', parent);
    await add(storeId, 'מכנסיים', parent);
    expect(await moveCategory(child, 'down')).toEqual({ ok: true });
    const tree = await getCategoriesByStoreId(storeId);
    expect(tree.filter((c) => c.parentId === parent).map((c) => c.name)).toEqual(['מכנסיים', 'חולצות']);
    expect(tree.filter((c) => !c.parentId).map((c) => c.id)).toEqual([parent, other]);
  });
});

describe('resolving CSV category paths', () => {
  it('creates what is missing, reuses what is there, and returns the leaf of each path', async () => {
    const storeId = await freshStore();
    const [first, second, third] = await resolveOrCreateCategoryPaths(storeId, [
      ['ביגוד', 'גברים', 'חולצות'],
      ['ביגוד', 'גברים'],
      ['ביגוד', 'נשים', 'חולצות'],
    ]);
    const tree = await getCategoriesByStoreId(storeId);
    expect(tree).toHaveLength(5); // ביגוד, גברים, חולצות, נשים, חולצות — one root, not two
    expect(tree.filter((c) => !c.parentId)).toHaveLength(1);
    expect(second).toBe(tree.find((c) => c.name === 'גברים')?.id);
    expect(tree.find((c) => c.id === first)?.parentId).toBe(second);
    expect(first).not.toBe(third); // same leaf name, different branch
  });

  it('reuses an existing tree instead of duplicating it', async () => {
    const storeId = await freshStore();
    const parent = await add(storeId, 'ביגוד');
    const child = await add(storeId, 'חולצות', parent);
    expect(await resolveOrCreateCategoryPaths(storeId, [['ביגוד', 'חולצות']])).toEqual([child]);
    expect(await getCategoriesByStoreId(storeId)).toHaveLength(2);
  });

  it('returns null per blank path and writes nothing at all', async () => {
    const storeId = await freshStore();
    expect(await resolveOrCreateCategoryPaths(storeId, [[], ['  ', ''], []])).toEqual([null, null, null]);
    expect(await getCategoriesByStoreId(storeId)).toEqual([]);
    // An unknown store resolves to nulls rather than raising — the row simply keeps no category.
    expect(await resolveOrCreateCategoryPaths('store-1', [['ביגוד']])).toEqual([null]);
  });

  it('ignores segments past MAX_CATEGORY_DEPTH rather than building an illegal tree', async () => {
    const storeId = await freshStore();
    const [leaf] = await resolveOrCreateCategoryPaths(storeId, [['a', 'b', 'c', 'd', 'e']]);
    const tree = await getCategoriesByStoreId(storeId);
    expect(tree).toHaveLength(MAX_CATEGORY_DEPTH);
    // Asserted as a CHAIN, not as a returned order: one batch writes every level inside one
    // transaction, so all three rows share `now()` and each is position 0 of its own level — the
    // only thing left to order them by is the random id. Nothing renders a flat list anyway
    // (`buildCategoryTree` groups by parent first), so there is no order here to promise.
    expect(tree.map((c) => c.name).sort()).toEqual(['a', 'b', 'c']);
    const byId = new Map(tree.map((c) => [c.id, c]));
    expect(byId.get(leaf!)?.name).toBe('c');
    expect(byId.get(byId.get(leaf!)!.parentId!)?.name).toBe('b');
  });

  // The bulk path truncates where the per-category editor rejects: failing a thousand-row upload
  // over one long spreadsheet cell is a worse answer than a clipped name the seller can rename.
  it('clips an oversized segment instead of failing the whole upload', async () => {
    const storeId = await freshStore();
    const [leaf] = await resolveOrCreateCategoryPaths(storeId, [['ב'.repeat(MAX_CATEGORY_NAME_LENGTH + 20)]]);
    expect((await getCategoryById(leaf!))?.name).toHaveLength(MAX_CATEGORY_NAME_LENGTH);
  });

  it('two uploads of the same spreadsheet build one tree, not two', async () => {
    const storeId = await freshStore();
    const paths = [['ביגוד', 'גברים'], ['ביגוד', 'נשים']];
    const [runA, runB] = await Promise.all([
      resolveOrCreateCategoryPaths(storeId, paths),
      resolveOrCreateCategoryPaths(storeId, paths),
    ]);
    expect(runA).toEqual(runB);
    expect(await getCategoriesByStoreId(storeId)).toHaveLength(3);
  });
});
