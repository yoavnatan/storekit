// The WRITE half of the back-to-store pill. The read half is deliberately not here:
// its one consumer is an inline script in Header.astro that has to run before first
// paint (a pill appearing late re-divides the space-between header row and shifts the
// nav), and an inline script cannot import. tests/header-cart-badge.test.ts pins that
// script to this KEY so the two halves can't drift apart.
const KEY = 'last_store_v1';

export interface LastStore {
  slug: string;
  name: string;
  url: string;
}

export function saveLastStore(store: LastStore): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(store)); } catch {}
}

export function clearLastStore(): void {
  try { sessionStorage.removeItem(KEY); } catch {}
}
