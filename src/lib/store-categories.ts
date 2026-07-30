import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CATEGORIES_PATH = path.join(process.cwd(), 'data/store-categories.json');

/** Keeps the dashboard tree editor and the store page's drill-down filter both simple to build and to use. */
export const MAX_CATEGORY_DEPTH = 3;

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

function readCategories(): StoreCategory[] {
  try { return JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8')) as StoreCategory[]; }
  catch { return []; }
}

function writeCategories(categories: StoreCategory[]): void {
  fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(categories, null, 2));
}

export function getCategoriesByStoreId(storeId: string): StoreCategory[] {
  return readCategories().filter((c) => c.storeId === storeId);
}

export function getCategoryById(id: string): StoreCategory | null {
  return readCategories().find((c) => c.id === id) ?? null;
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

export function createCategory(storeId: string, { name, parentId = null }: CreateCategoryInput): StoreCategory | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: 'שם קטגוריה נדרש.' };

  const categories = readCategories();
  const storeCategories = categories.filter((c) => c.storeId === storeId);

  if (parentId) {
    const parent = storeCategories.find((c) => c.id === parentId);
    if (!parent) return { error: 'קטגוריית האב לא נמצאה.' };
  }
  if (getDepth(storeCategories, parentId) + 1 > MAX_CATEGORY_DEPTH) {
    return { error: `לא ניתן לקנן יותר מ-${MAX_CATEGORY_DEPTH} רמות.` };
  }
  const siblings = storeCategories.filter((c) => c.parentId === parentId);
  if (siblings.some((c) => c.name === trimmed)) {
    return { error: 'כבר קיימת קטגוריה בשם הזה באותה רמה.' };
  }

  const category: StoreCategory = {
    id: crypto.randomUUID(),
    storeId,
    name: trimmed,
    parentId,
    order: siblings.length ? Math.max(...siblings.map((c) => c.order)) + 1 : 0,
    createdAt: new Date().toISOString(),
  };
  categories.push(category);
  writeCategories(categories);
  return category;
}

export function renameCategory(id: string, name: string): StoreCategory | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: 'שם קטגוריה נדרש.' };

  const categories = readCategories();
  const idx = categories.findIndex((c) => c.id === id);
  if (idx === -1) return { error: 'הקטגוריה לא נמצאה.' };

  const target = categories[idx]!;
  const siblings = categories.filter((c) => c.storeId === target.storeId && c.parentId === target.parentId && c.id !== id);
  if (siblings.some((c) => c.name === trimmed)) {
    return { error: 'כבר קיימת קטגוריה בשם הזה באותה רמה.' };
  }

  categories[idx] = { ...target, name: trimmed };
  writeCategories(categories);
  return categories[idx];
}

// Deleting a category with subcategories would either silently cascade-delete
// a whole branch or silently reparent it — both surprising for a seller who
// isn't expected to think in tree semantics. Blocking is the option with no
// silent side effect: the seller deletes the leaves first, on purpose.
export function deleteCategory(id: string): { ok: true } | { error: string } {
  const categories = readCategories();
  const target = categories.find((c) => c.id === id);
  if (!target) return { error: 'הקטגוריה לא נמצאה.' };
  const hasChildren = categories.some((c) => c.parentId === id);
  if (hasChildren) return { error: 'יש למחוק קודם את תתי-הקטגוריות.' };

  writeCategories(categories.filter((c) => c.id !== id));
  return { ok: true };
}

/** Swaps `order` with the previous/next sibling — the only reordering control; no drag-and-drop. */
export function moveCategory(id: string, direction: 'up' | 'down'): { ok: true } | { error: string } {
  const categories = readCategories();
  const target = categories.find((c) => c.id === id);
  if (!target) return { error: 'הקטגוריה לא נמצאה.' };

  const siblings = categories
    .filter((c) => c.storeId === target.storeId && c.parentId === target.parentId)
    .sort((a, b) => a.order - b.order);
  const idx = siblings.findIndex((c) => c.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return { ok: true }; // already at the edge — no-op, not an error

  const other = siblings[swapIdx]!;
  const targetOrder = target.order;
  const otherOrder = other.order;
  const updated = categories.map((c) => {
    if (c.id === target.id) return { ...c, order: otherOrder };
    if (c.id === other.id) return { ...c, order: targetOrder };
    return c;
  });
  writeCategories(updated);
  return { ok: true };
}

/** Bulk-inserts categories with pre-assigned ids/order — used only by the one-time migration script. */
export function seedCategories(categories: StoreCategory[]): void {
  const existing = readCategories();
  writeCategories([...existing, ...categories]);
}

/** One read + one write for the whole batch (CSV bulk import can carry hundreds/thousands of rows —
 *  walking each row's path through the per-row create/rename API would mean that many separate
 *  file read+writes). Each path (root-first segment names) is matched against existing siblings by
 *  name at each level; a missing segment is auto-created — so a seller's spreadsheet can define new
 *  category structure just by listing paths, no need to pre-build the tree by hand first. Segments
 *  beyond MAX_CATEGORY_DEPTH are ignored (the caller — csv-bulk.ts — already caps at 3 columns). */
export function resolveOrCreateCategoryPaths(storeId: string, paths: string[][]): Array<string | null> {
  const categories = readCategories();
  const results: Array<string | null> = [];

  for (const segments of paths) {
    const trimmed = segments.map((s) => s.trim()).filter(Boolean).slice(0, MAX_CATEGORY_DEPTH);
    if (!trimmed.length) { results.push(null); continue; }

    let parentId: string | null = null;
    let finalId: string | null = null;
    for (const name of trimmed) {
      let node = categories.find((c) => c.storeId === storeId && c.parentId === parentId && c.name === name);
      if (!node) {
        const siblings = categories.filter((c) => c.storeId === storeId && c.parentId === parentId);
        node = {
          id: crypto.randomUUID(),
          storeId,
          name,
          parentId,
          order: siblings.length ? Math.max(...siblings.map((c) => c.order)) + 1 : 0,
          createdAt: new Date().toISOString(),
        };
        categories.push(node);
      }
      parentId = node.id;
      finalId = node.id;
    }
    results.push(finalId);
  }

  writeCategories(categories);
  return results;
}
