/**
 * A store's own product category tree — the third module moved off `data/*.json`
 * (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * The split in this file is the thing to see first: **the readers and writers are queries and are
 * therefore `async`; every tree computation below them is pure and stays synchronous.** A caller
 * fetches the store's categories once and then walks, counts, paths and builds a tree from that one
 * array — `[storeSlug]/index.astro` does exactly that, and turning `getAncestorChain` into a query
 * would have made one page a dozen round-trips for data it already held.
 *
 * What the database does that a file could not:
 *
 *   · **A duplicate sibling name is refused by an index, not by a read before the write (§7.4)** —
 *     `migrations/0002_category_sibling_name.sql`. Two dashboard tabs adding the same category in
 *     the same moment both used to pass the check.
 *   · **`position` is assigned inside the INSERT**, from `MAX(position) + 1` over the siblings, so
 *     two categories created at once cannot land on the same slot.
 *   · **Deleting is one conditional statement.** "Has children" is part of the `DELETE`'s `WHERE`,
 *     which is what stops a child created a millisecond earlier from being cascaded away by a
 *     check that had already passed.
 *   · **A product pointing at a deleted category is handled by the schema** — `store_products
 *     .category_id` is `ON DELETE SET NULL`, the same answer the pure code below gives for an id it
 *     cannot resolve.
 */
import crypto from 'node:crypto';
import { firstRow, isUuid, query, rows, withTransaction, type Queryable } from './db.js';

/** Keeps the dashboard tree editor and the store page's drill-down filter both simple to build and to use. */
export const MAX_CATEGORY_DEPTH = 3;

/**
 * Longest category name accepted, matching the `maxlength="40"` both name inputs already carry
 * (seller/dashboard.astro's root-category field, category-tree.ts's per-level one).
 *
 * **The UI cap was the only one, and a disabled input is not a rule** — this module is reached by a
 * hand-built POST and by a CSV cell, neither of which passes through those fields. It became
 * load-bearing with `store_categories_sibling_name_idx`: a btree index tuple has a hard size limit
 * (~2700 bytes), so a multi-kilobyte name no longer stores a silly value — it raises, and the
 * seller gets a 500 on a form that used to work. A name that cannot fit in a chip was never
 * useful anyway.
 */
export const MAX_CATEGORY_NAME_LENGTH = 40;

export interface StoreCategory {
  id: string;
  storeId: string;
  name: string;
  parentId: string | null;
  order: number;
  createdAt: string;
}

export interface CategoryNode extends StoreCategory {
  children: CategoryNode[];
}

/** `order` is a reserved word in SQL, so the column is `position`; the field keeps its name. */
const COLUMNS = 'id, store_id, name, parent_id, position, created_at';

/** §7.13: a table has no natural order. `position` is what the seller arranges; `created_at, id`
 *  breaks a tie so a tree stops reshuffling itself between two loads of the same dashboard. */
const ORDER = 'ORDER BY position, created_at, id';

interface CategoryRow {
  id: string;
  store_id: string;
  name: string;
  parent_id: string | null;
  position: number;
  created_at: Date | string | null;
}

function toCategory(row: CategoryRow): StoreCategory {
  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    parentId: row.parent_id,
    order: row.position,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  };
}

export async function getCategoriesByStoreId(storeId: string): Promise<StoreCategory[]> {
  if (!isUuid(storeId)) return [];
  return (await rows<CategoryRow>(`SELECT ${COLUMNS} FROM store_categories WHERE store_id = $1 ${ORDER}`, [storeId]))
    .map(toCategory);
}

/**
 * The category trees of MANY stores, grouped, in one statement.
 *
 * For a caller holding a list of stores and needing each one's tree — the Merchant/Meta product
 * feed walks every indexable store to name each product's category path. Per-store that was a round
 * trip each: 45 stores took the feed to six seconds, which is long enough for Merchant Center's own
 * fetch to give up on it. The single-store reader stays; this is the batched twin, and it keeps the
 * identical `ORDER` so each store's slice is the tree it would have got on its own.
 */
export async function getCategoriesByStoreIds(storeIds: readonly string[]): Promise<Map<string, StoreCategory[]>> {
  const ids = [...new Set(storeIds.filter(isUuid))];
  const byStore = new Map<string, StoreCategory[]>(ids.map((id) => [id, []]));
  // No ids means no statement — an empty `ANY(…)` is a query asking for nothing.
  const found = ids.length
    ? await rows<CategoryRow>(`SELECT ${COLUMNS} FROM store_categories WHERE store_id = ANY($1::uuid[]) ${ORDER}`, [ids])
    : [];
  for (const row of found) byStore.get(row.store_id)?.push(toCategory(row));
  return byStore;
}

export async function getCategoryById(id: string): Promise<StoreCategory | null> {
  if (!isUuid(id)) return null;
  const row = await firstRow<CategoryRow>(`SELECT ${COLUMNS} FROM store_categories WHERE id = $1`, [id]);
  return row ? toCategory(row) : null;
}

/** 1 for a root node, 2 for its children, etc. */
export function getDepth(categories: StoreCategory[], categoryId: string | null): number {
  let depth = 0;
  let current = categoryId;
  while (current) {
    const node = categories.find((c) => c.id === current);
    if (!node) break;
    depth++;
    current = node.parentId;
  }
  return depth;
}

export function getDescendantIds(categories: StoreCategory[], categoryId: string): string[] {
  const ids: string[] = [];
  const queue = [categoryId];
  while (queue.length) {
    const current = queue.shift()!;
    const children = categories.filter((c) => c.parentId === current);
    for (const child of children) {
      ids.push(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

/** A category id plus every id beneath it — what product-listing.ts#filterAndSortProducts needs to match a category AND its subcategories. */
export function resolveCategoryFilterIds(categories: StoreCategory[], categoryId: string): string[] {
  return [categoryId, ...getDescendantIds(categories, categoryId)];
}

/** Root-first: [root, ..., categoryId's own node]. */
export function getAncestorChain(categories: StoreCategory[], categoryId: string): StoreCategory[] {
  const chain: StoreCategory[] = [];
  let current: StoreCategory | undefined = categories.find((c) => c.id === categoryId);
  while (current) {
    chain.unshift(current);
    current = current.parentId ? categories.find((c) => c.id === current!.parentId) : undefined;
  }
  return chain;
}

/**
 * How many products sit behind each category, counting its whole subtree — the
 * number the store page prints on every category chip. A parent therefore counts
 * everything its children hold, which is what the chip does when clicked
 * (`resolveCategoryFilterIds`); a count that only reflected directly-assigned
 * products would contradict the filter it labels.
 *
 * Takes the product's category ids rather than products so it stays pure and
 * storage-agnostic. One walk up the ancestor chain per product — the naive
 * alternative (resolve the subtree per category, then scan all products) is
 * categories × products.
 */
export function countProductsPerCategory(
  categories: StoreCategory[],
  productCategoryIds: ReadonlyArray<string | null | undefined>,
): Record<string, number> {
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  const counts: Record<string, number> = {};
  for (const id of productCategoryIds) {
    let current = id ?? null;
    // A malformed cycle would spin forever; the depth cap is the guard, and
    // MAX_CATEGORY_DEPTH is the real ceiling anyway.
    for (let hop = 0; current && hop <= MAX_CATEGORY_DEPTH; hop++) {
      if (!parentOf.has(current)) break; // product points at a deleted category
      counts[current] = (counts[current] ?? 0) + 1;
      current = parentOf.get(current) ?? null;
    }
  }
  return counts;
}

/** "ביגוד › גברים › חולצות" — for table cells, badges, breadcrumbs; not for matching. */
export function categoryPath(categories: StoreCategory[], categoryId: string): string {
  return getAncestorChain(categories, categoryId).map((c) => c.name).join(' › ');
}

export function buildCategoryTree(categories: StoreCategory[]): CategoryNode[] {
  const byParent = new Map<string | null, StoreCategory[]>();
  for (const c of categories) {
    const siblings = byParent.get(c.parentId) ?? [];
    siblings.push(c);
    byParent.set(c.parentId, siblings);
  }
  function build(parentId: string | null): CategoryNode[] {
    return (byParent.get(parentId) ?? [])
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ ...c, children: build(c.id) }));
  }
  return build(null);
}

export interface CreateCategoryInput {
  name: string;
  parentId?: string | null;
}

const NAME_REQUIRED = 'שם קטגוריה נדרש.';
const NAME_TOO_LONG = `שם קטגוריה ארוך מדי (עד ${MAX_CATEGORY_NAME_LENGTH} תווים).`;
const NOT_FOUND = 'הקטגוריה לא נמצאה.';
const DUPLICATE_SIBLING = 'כבר קיימת קטגוריה בשם הזה באותה רמה.';

/**
 * Add one category.
 *
 * **The uniqueness check IS the insert.** `ON CONFLICT DO NOTHING` against
 * `store_categories_sibling_name_idx` returns zero rows when a sibling already holds the name, and
 * zero rows is the answer no matter who else was mid-write — the read-then-write it replaces let two
 * tabs both find the name free.
 *
 * `position` comes from the same statement for the same reason: `MAX(position) + 1` evaluated
 * inside the INSERT cannot be read by a second insert before this one lands.
 */
export async function createCategory(storeId: string, { name, parentId = null }: CreateCategoryInput): Promise<StoreCategory | { error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { error: NAME_REQUIRED };
  if (trimmed.length > MAX_CATEGORY_NAME_LENGTH) return { error: NAME_TOO_LONG };
  if (!isUuid(storeId)) return { error: 'החנות לא נמצאה.' };

  if (parentId) {
    if (!isUuid(parentId)) return { error: 'קטגוריית האב לא נמצאה.' };
    // The parent's depth, walked in the database rather than by fetching the whole tree: the
    // recursion climbs from the parent to the root and counts the hops, so a parent that belongs to
    // another store simply produces no rows and reads as "not found" — which is the same answer the
    // file version gave, and the one that refuses to leak that the id exists.
    const parent = await firstRow<{ depth: number }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_id, 1 AS depth FROM store_categories WHERE id = $1 AND store_id = $2
         UNION ALL
         SELECT c.id, c.parent_id, chain.depth + 1 FROM store_categories c JOIN chain ON c.id = chain.parent_id
       )
       SELECT MAX(depth)::int AS depth FROM chain`,
      [parentId, storeId],
    );
    if (!parent?.depth) return { error: 'קטגוריית האב לא נמצאה.' };
    if (parent.depth + 1 > MAX_CATEGORY_DEPTH) return { error: `לא ניתן לקנן יותר מ-${MAX_CATEGORY_DEPTH} רמות.` };
  }

  const row = await firstRow<CategoryRow>(
    `INSERT INTO store_categories (id, store_id, parent_id, name, position, created_at)
     SELECT $1, $2, $3::uuid, $4,
            COALESCE((SELECT MAX(position) + 1 FROM store_categories
                       WHERE store_id = $2 AND parent_id IS NOT DISTINCT FROM $3::uuid), 0),
            now()
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [crypto.randomUUID(), storeId, parentId, trimmed],
  );
  return row ? toCategory(row) : { error: DUPLICATE_SIBLING };
}

/**
 * Rename in place. The `NOT EXISTS` is the sibling check and it reads the same row set the index
 * guards, so the two can never disagree; `s.id <> t.id` is what lets a seller re-save the name it
 * already has. Zero rows means one of two things, and they need different sentences, so the row is
 * looked up once afterwards to tell them apart — on the failure path only.
 */
export async function renameCategory(id: string, name: string): Promise<StoreCategory | { error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { error: NAME_REQUIRED };
  if (trimmed.length > MAX_CATEGORY_NAME_LENGTH) return { error: NAME_TOO_LONG };
  if (!isUuid(id)) return { error: NOT_FOUND };

  const row = await firstRow<CategoryRow>(
    `UPDATE store_categories t SET name = $2
      WHERE t.id = $1
        AND NOT EXISTS (SELECT 1 FROM store_categories s
                         WHERE s.store_id = t.store_id
                           AND s.parent_id IS NOT DISTINCT FROM t.parent_id
                           AND s.name = $2 AND s.id <> t.id)
      RETURNING ${COLUMNS}`,
    [id, trimmed],
  );
  if (row) return toCategory(row);
  return (await getCategoryById(id)) ? { error: DUPLICATE_SIBLING } : { error: NOT_FOUND };
}

/**
 * Deleting a category with subcategories would either silently cascade-delete a whole branch or
 * silently reparent it — both surprising for a seller who isn't expected to think in tree semantics.
 * Blocking is the option with no silent side effect: the seller deletes the leaves first, on purpose.
 *
 * **The block has to be part of the statement, not a check before it.** `store_categories.parent_id`
 * is `ON DELETE CASCADE`, so a subcategory added between a passing check and the delete would be
 * erased along with its parent and nothing would report it.
 */
export async function deleteCategory(id: string): Promise<{ ok: true } | { error: string }> {
  if (!isUuid(id)) return { error: NOT_FOUND };
  const { rowCount } = await query(
    `DELETE FROM store_categories
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM store_categories c WHERE c.parent_id = $1)`,
    [id],
  );
  if (rowCount > 0) return { ok: true };
  return (await getCategoryById(id)) ? { error: 'יש למחוק קודם את תתי-הקטגוריות.' } : { error: NOT_FOUND };
}

/**
 * Move one step among its siblings — the only reordering control; no drag-and-drop.
 *
 * **Renumbers the whole sibling list rather than swapping two `position` values**, which the file
 * version did. A swap is a no-op whenever the two happen to hold the SAME number, and equal
 * positions are not exotic: every category imported from the JSON era carries the order it had, and
 * `resolveOrCreateCategoryPaths` can seed a level from an empty table. Rewriting the run from its
 * ordered form gives 0..n-1 every time, so the button always moves something.
 *
 * The read and the write share one transaction, so two arrows clicked at once cannot both renumber
 * from the same starting order and lose one of the moves.
 */
export async function moveCategory(id: string, direction: 'up' | 'down'): Promise<{ ok: true } | { error: string }> {
  if (!isUuid(id)) return { error: NOT_FOUND };
  return withTransaction(async (tx: Queryable) => {
    const target = (await tx.query<CategoryRow>(
      `SELECT ${COLUMNS} FROM store_categories WHERE id = $1 FOR UPDATE`, [id],
    )).rows[0];
    if (!target) return { error: NOT_FOUND };

    const siblings = (await tx.query<CategoryRow>(
      `SELECT ${COLUMNS} FROM store_categories
        WHERE store_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid ${ORDER} FOR UPDATE`,
      [target.store_id, target.parent_id],
    )).rows;

    const idx = siblings.findIndex((c) => c.id === id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) return { ok: true }; // already at the edge — no-op, not an error

    const reordered = siblings.map((c) => c.id);
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx]!, reordered[idx]!];
    await tx.query(
      `UPDATE store_categories c SET position = v.pos - 1
         FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id, pos)
        WHERE c.id = v.id`,
      [reordered],
    );
    return { ok: true };
  });
}

/**
 * Resolve each root-first path of segment NAMES to a category id, creating whatever is missing.
 *
 * Used by the CSV bulk import, where a seller's spreadsheet may define new structure just by listing
 * paths — no need to pre-build the tree by hand. Segments beyond MAX_CATEGORY_DEPTH are ignored (the
 * caller, csv-bulk.ts, already caps at 3 columns).
 *
 * **One `SELECT` for the store's whole tree, then an insert only for what is genuinely new** — a
 * catalog of a thousand rows shares a handful of categories, so resolving per row would be a
 * thousand round-trips for a dozen answers. A file with no category column at all does not touch the
 * database: the early return matters because that is the common shape (a sku+stock feed), and it
 * keeps a bulk upload of an uncategorised catalog at zero extra queries.
 *
 * The whole batch runs in one transaction, so a file that fails halfway leaves no half-built tree.
 * Each `INSERT` still carries `ON CONFLICT DO NOTHING` plus a re-read: a concurrent upload of the
 * same spreadsheet must join the category this one created, not fail on it.
 */
export async function resolveOrCreateCategoryPaths(storeId: string, paths: string[][]): Promise<Array<string | null>> {
  // A too-long segment is TRUNCATED here rather than rejected: this is the bulk path, and failing a
  // thousand-row upload over one long spreadsheet cell would be a worse answer than a clipped name
  // the seller can rename. The per-category editor rejects instead, because there it is one field
  // and the seller is standing in front of it.
  const wanted = paths.map((segments) => segments
    .map((s) => s.trim().slice(0, MAX_CATEGORY_NAME_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_CATEGORY_DEPTH));
  if (!wanted.some((segments) => segments.length) || !isUuid(storeId)) return wanted.map(() => null);

  return withTransaction(async (tx: Queryable) => {
    const existing = (await tx.query<CategoryRow>(
      `SELECT ${COLUMNS} FROM store_categories WHERE store_id = $1 ${ORDER}`, [storeId],
    )).rows;
    // Keyed by parent + name, which is exactly what the unique index keys on, so a hit here and a
    // conflict there are always the same question.
    const byKey = new Map<string, string>(existing.map((c) => [`${c.parent_id ?? ''} ${c.name}`, c.id] as const));
    const results: Array<string | null> = [];

    /** The id of this store's `name` under `parent`, creating it if nobody holds it yet. */
    async function ensure(parent: string | null, name: string): Promise<string | undefined> {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO store_categories (id, store_id, parent_id, name, position, created_at)
         SELECT $1, $2, $3::uuid, $4,
                COALESCE((SELECT MAX(position) + 1 FROM store_categories
                           WHERE store_id = $2 AND parent_id IS NOT DISTINCT FROM $3::uuid), 0),
                now()
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [crypto.randomUUID(), storeId, parent, name],
      );
      if (inserted.rows[0]) return inserted.rows[0].id;
      // Nothing inserted means a concurrent upload of the same spreadsheet already created it —
      // join theirs rather than failing on a name this batch was about to write anyway.
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM store_categories
          WHERE store_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND name = $3`,
        [storeId, parent, name],
      );
      return found.rows[0]?.id;
    }

    for (const segments of wanted) {
      let parentId: string | null = null;
      let finalId: string | null = null;
      for (const name of segments) {
        const key: string = `${parentId ?? ''} ${name}`;
        const id: string | undefined = byKey.get(key) ?? await ensure(parentId, name);
        if (!id) break; // unreachable: the insert either landed or something else already holds it
        byKey.set(key, id);
        parentId = id;
        finalId = id;
      }
      results.push(finalId);
    }

    return results;
  });
}
