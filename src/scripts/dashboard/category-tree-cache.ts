import type { CategoryNode } from '../../lib/store-categories.js';

// Small standalone module (not folded into products.ts or category-picker.ts) so both can share
// the same in-page cache of the category tree without importing from each other.
let cachedTree: CategoryNode[] | null = null;

export function getCategoryTree(): CategoryNode[] {
  if (cachedTree) return cachedTree;
  try { cachedTree = JSON.parse(document.getElementById('category-tree-data')?.textContent ?? '[]') as CategoryNode[]; }
  catch { cachedTree = []; }
  return cachedTree;
}

/** Called after the category picker creates a new category — the server response already has
 *  the authoritative up-to-date tree, so every consumer just adopts it instead of trying to
 *  merge in the new node locally. */
export function setCategoryTree(tree: CategoryNode[]): void {
  cachedTree = tree;
}
