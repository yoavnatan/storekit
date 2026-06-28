import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_PATH = join(process.cwd(), 'data', 'store-favorite-counts.json');

function readCounts(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeCounts(counts: Record<string, number>): void {
  writeFileSync(DATA_PATH, JSON.stringify(counts, null, 2));
}

export function getFavoriteStoreCount(slug: string): number {
  return readCounts()[slug] ?? 0;
}

export function getAllFavoriteStoreCounts(): Record<string, number> {
  return readCounts();
}

export function adjustFavoriteStoreCount(slug: string, delta: 1 | -1): void {
  const counts = readCounts();
  counts[slug] = Math.max(0, (counts[slug] ?? 0) + delta);
  writeCounts(counts);
}
