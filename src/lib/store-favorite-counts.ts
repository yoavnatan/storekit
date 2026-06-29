import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const USER_CARTS_PATH = join(process.cwd(), 'data', 'user-carts.json');

function readAllUserCarts(): Record<string, { favoriteStores?: string[] }> {
  try {
    return JSON.parse(readFileSync(USER_CARTS_PATH, 'utf-8')) as Record<string, { favoriteStores?: string[] }>;
  } catch {
    return {};
  }
}

export function getFavoriteStoreCount(slug: string): number {
  const all = readAllUserCarts();
  return Object.values(all).filter((u) => u.favoriteStores?.includes(slug)).length;
}

export function getAllFavoriteStoreCounts(): Record<string, number> {
  const all = readAllUserCarts();
  const counts: Record<string, number> = {};
  for (const userData of Object.values(all)) {
    for (const slug of (userData.favoriteStores ?? [])) {
      counts[slug] = (counts[slug] ?? 0) + 1;
    }
  }
  return counts;
}

// No-op: counts are now derived from user-carts.json on every read, no separate file to update
export function adjustFavoriteStoreCount(_slug: string, _delta: 1 | -1): void {}
