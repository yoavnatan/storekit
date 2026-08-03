import type { Store } from './stores.js';

import { businessDayISO } from './business-day.js';

export interface FeedStore {
  store: Store;
  /** The thumbnails this store's card draws — already narrowed to the few a card can show
   *  (`store-products.ts#getStorePreviews`). This used to be the store's entire visible catalogue,
   *  of which the card read one field of the first three or four rows; on a network that was most
   *  of the homepage's time-to-first-byte. This module never reads it either way — it decides which
   *  STORES go where — so it only has to carry it through to the shelf. */
  previewImages: string[];
}

export interface CategoryShelf {
  category: string;
  stores: FeedStore[];
}

export interface HomeFeed {
  liked: FeedStore[];
  /** Stores the buyer has actually bought from before (derived from order history), most
   *  recent first — the strongest personalization signal available, stronger than "liked". */
  buyAgain: FeedStore[];
  newStores: FeedStore[];
  discovery: FeedStore[];
  categories: CategoryShelf[];
  /** Stores that keep their full product carousel (today's homepage treatment) — a rotating
   *  subset, not every store, so the page stays bounded once there are hundreds of them. */
  spotlight: FeedStore[];
}

const SHELF_SIZE = 10;
const MAX_CATEGORY_SHELVES = 4;
/** Fewest stores a category needs before it earns its own shelf. Briefly raised to
 *  3 on 2026-07-28 because two cards left a third of the row empty, then put back:
 *  a 2-card shelf now widens its cards AND gives them a 4th preview thumb
 *  (HomeShelf), so it fills the row without looking stretched. */
const MIN_CATEGORY_SHELF_STORES = 2;
const SPOTLIGHT_SIZE = 5;
/** Below this many cards, a shelf reads as sparse/broken rather than a real row (CURRENT_TASK.md
 *  → סשן א׳: "always enough stores in New Stores to fill the section"). */
const MIN_SHELF_FILL = 6;

/** Deterministic string hash → 32-bit int, seed for mulberry32 below. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, seeded PRNG (good enough for shuffling a list, not cryptography). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle seeded off `seed` — same seed always produces the same order, so a
 *  "discovery"/"spotlight" row stays stable across requests within the same seed window
 *  (see dailySeed()) instead of reshuffling on every single page load. */
function seededShuffle<T>(arr: T[], seed: string): T[] {
  const rand = mulberry32(hashSeed(seed));
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Changes once a day — long enough that a shelf doesn't feel randomly reordered on
 *  every reload, short enough that the homepage doesn't go stale for weeks. On the
 *  BUSINESS day (business-day.ts), so the shuffle turns over at local midnight rather
 *  than at 02:00/03:00 while people are still browsing. */
function dailySeed(salt: string): string {
  return `${businessDayISO(new Date())}:${salt}`;
}

function normalizeCategory(raw: string): string {
  return raw.trim();
}

/** Float admin-promoted stores (curation weight, see stores.ts#promoWeight) to the front of a
 *  discovery row without disturbing the order among equal-weight stores — Array.sort is stable,
 *  so the daily seeded-shuffle order is preserved within each tier. This is the ONLY effect the
 *  silent "shop-window" promotion has: it reorders placement in the platform's own discovery
 *  surfaces, nothing more (CURRENT_TASK.md → סשן ב׳). */
function promoFirst(list: FeedStore[]): FeedStore[] {
  return list.slice().sort((a, b) => (b.store.promoWeight ?? 0) - (a.store.promoWeight ?? 0));
}

/** `previousStoreSlugs` — the buyer's past-order store slugs, most-recent purchase first
 *  (deduped by the caller); pass `[]` for a guest or a buyer with no order history. Kept as a
 *  plain input here rather than importing orders.ts directly, same reasoning as
 *  `storesWithProducts` — this module only decides *which stores go where*, not how to look
 *  them up.
 *
 *  `favoriteStoreSlugs` is now the same kind of input, for the same reason: it used to be looked up
 *  in here from a user id, which would have made the whole feed builder asynchronous the moment
 *  buyer state became a query. The caller does the one lookup; every shelf rule below stays pure
 *  and testable without a database (the pattern the page-view and analytics buckets set). */
export function buildHomeFeed(
  storesWithProducts: FeedStore[],
  favoriteStoreSlugs: readonly string[] = [],
  previousStoreSlugs: string[] = [],
): HomeFeed {
  const favoriteSlugs = new Set(favoriteStoreSlugs);
  const liked = storesWithProducts.filter((fs) => favoriteSlugs.has(fs.store.slug)).slice(0, SHELF_SIZE);
  const likedSlugs = new Set(liked.map((fs) => fs.store.slug));

  const storesBySlug = new Map(storesWithProducts.map((fs) => [fs.store.slug, fs]));
  const buyAgain: FeedStore[] = [];
  const buyAgainSlugs = new Set<string>();
  for (const slug of previousStoreSlugs) {
    if (likedSlugs.has(slug) || buyAgainSlugs.has(slug)) continue;
    const fs = storesBySlug.get(slug);
    if (!fs) continue;
    buyAgain.push(fs);
    buyAgainSlugs.add(slug);
    if (buyAgain.length >= SHELF_SIZE) break;
  }

  const newStores = storesWithProducts
    .filter((fs) => !likedSlugs.has(fs.store.slug) && !buyAgainSlugs.has(fs.store.slug))
    .slice()
    .sort((a, b) => new Date(b.store.createdAt).getTime() - new Date(a.store.createdAt).getTime())
    .slice(0, SHELF_SIZE);

  // Backfill: a young platform (or a buyer who's already liked/bought-from most of the
  // catalog) can leave this shelf too sparse to read as a real row — top it up with the next
  // most-recent stores overall, including ones already shown elsewhere (shelves are allowed to
  // repeat, same reasoning as the category shelves above), until it looks full or the whole
  // catalog is exhausted.
  if (newStores.length < Math.min(MIN_SHELF_FILL, storesWithProducts.length)) {
    const newStoreSlugsSoFar = new Set(newStores.map((fs) => fs.store.slug));
    const backfillPool = storesWithProducts
      .filter((fs) => !newStoreSlugsSoFar.has(fs.store.slug))
      .sort((a, b) => new Date(b.store.createdAt).getTime() - new Date(a.store.createdAt).getTime());
    for (const fs of backfillPool) {
      if (newStores.length >= Math.min(SHELF_SIZE, storesWithProducts.length)) break;
      newStores.push(fs);
    }
  }
  const newSlugs = new Set(newStores.map((fs) => fs.store.slug));

  // One shelf per category with enough stores to be worth a whole row — sorted by how many
  // stores carry it, so the most populated categories surface first. A store can appear in
  // several category shelves at once (categories aren't mutually exclusive) and can still also
  // appear in the daily discovery shuffle — repetition across shelves is fine, each shelf
  // answers a different "how did I get here" question for the buyer.
  const byCategory = new Map<string, FeedStore[]>();
  for (const fs of storesWithProducts) {
    for (const raw of fs.store.categories ?? []) {
      const cat = normalizeCategory(raw);
      if (!cat) continue;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(fs);
    }
  }
  const categories: CategoryShelf[] = [...byCategory.entries()]
    .filter(([, stores]) => stores.length >= MIN_CATEGORY_SHELF_STORES)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_CATEGORY_SHELVES)
    .map(([category, stores]) => ({ category, stores: stores.slice(0, SHELF_SIZE) }));

  const discoveryPool = storesWithProducts.filter((fs) => !likedSlugs.has(fs.store.slug) && !buyAgainSlugs.has(fs.store.slug) && !newSlugs.has(fs.store.slug));
  const discovery = promoFirst(seededShuffle(discoveryPool, dailySeed('discovery'))).slice(0, SHELF_SIZE);

  const spotlight = promoFirst(seededShuffle(storesWithProducts, dailySeed('spotlight'))).slice(0, SPOTLIGHT_SIZE);

  return { liked, buyAgain, newStores, discovery, categories, spotlight };
}
