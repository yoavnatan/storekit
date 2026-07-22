import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STORES_PATH = path.join(process.cwd(), 'data/stores.json');

export interface StoreColors {
  primary: string;
  accent: string;
}

export interface StoreShipping {
  flatRate: number;
  freeAbove: number | null;
  processingDays: number;
}

export type StoreWeekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export const STORE_WEEKDAYS: StoreWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface StoreDayHours {
  closed: boolean;
  open: string;  // "HH:MM"
  close: string; // "HH:MM"
}

export type StoreHours = Record<StoreWeekday, StoreDayHours>;

export interface Store {
  id: string;
  sellerId: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  colors: StoreColors;
  categories?: string[];
  shipping?: StoreShipping;
  bannerImage?: string;
  profileImage?: string;
  address?: string;
  addressVisible?: boolean;
  hours?: StoreHours;
  hoursVisible?: boolean;
  /** Admin-only kill switch (see admin-moderation.ts) — a blocked store 404s on every
   *  public route and is excluded from every discovery surface (homepage, /stores,
   *  search), so it can't keep damaging the shared platform domain's Google standing
   *  while the seller sorts it out. Never set by anything but an admin action. */
  blocked?: boolean;
  /** Admin-only "shop-window" curation weight (see /api/admin/promote + CURRENT_TASK.md → סשן ב׳).
   *  Higher = the store floats higher in the platform's OWN discovery surfaces (homepage
   *  discovery + spotlight, /stores directory). It only reorders placement in real estate the
   *  platform itself owns and pays for — it never fabricates ratings/badges/social proof, never
   *  costs the seller anything, and is never shown to or settable by the seller (the seller store
   *  update endpoint whitelists fields explicitly, see /api/store.ts). 0/undefined = no boost.
   *  Deliberately silent: unlike `blocked`, promotion has nothing to disclose or appeal. */
  promoWeight?: number;
  /** Seller's saved image-editor background colours (hex), most-recent first. A per-store
   *  preference so it follows the store across devices, not the browser. Capped, see
   *  addStoreBgColor. */
  bgColors?: string[];
  createdAt: string;
}

/** Most saved background colours kept per store (newest-first, older ones fall off). */
export const MAX_STORE_BG_COLORS = 12;

/** Highest curation weight the admin can assign (0 = none, 1 = promoted, 2 = spotlight). */
export const MAX_PROMO_WEIGHT = 2;

/** Descending curation-weight comparator (0 = unpromoted). Returns 0 for equal weights, so a
 *  caller can layer it on top of an existing order (a stable sort keeps that order within a tier). */
export function byPromoWeight(a: Store, b: Store): number {
  return (b.promoWeight ?? 0) - (a.promoWeight ?? 0);
}

function readStores(): Store[] {
  try { return JSON.parse(fs.readFileSync(STORES_PATH, 'utf8')) as Store[]; }
  catch { return []; }
}

function writeStores(stores: Store[]): void {
  fs.writeFileSync(STORES_PATH, JSON.stringify(stores, null, 2));
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

interface CreateStoreInput {
  name: string;
  tagline?: string;
  description?: string;
}

export function createStore(sellerId: string, { name, tagline = '', description = '' }: CreateStoreInput): Store {
  const stores = readStores();
  const base = slugify(name) || 'store';
  let slug = base;
  let n = 2;
  while (stores.find((s) => s.slug === slug)) { slug = `${base}-${n++}`; }

  const store: Store = {
    id: crypto.randomUUID(),
    sellerId,
    slug,
    name,
    tagline,
    description,
    colors: { primary: '#1e7a46', accent: '#f97316' },
    createdAt: new Date().toISOString(),
  };
  stores.push(store);
  writeStores(stores);
  return store;
}

export function getStoreBySellerId(sellerId: string): Store | null {
  return readStores().find((s) => s.sellerId === sellerId) ?? null;
}

export function getStoresBySellerId(sellerId: string): Store[] {
  return readStores().filter((s) => s.sellerId === sellerId);
}

export function getStoreBySlug(slug: string): Store | null {
  return readStores().find((s) => s.slug === slug) ?? null;
}

export function getStoreById(id: string): Store | null {
  return readStores().find((s) => s.id === id) ?? null;
}

export function getAllStores(): Store[] {
  return readStores();
}

/** false for an admin-blocked store (see admin-moderation.ts). Every public discovery/purchase
 *  surface must gate through this — not repeat `!store.blocked` inline — so a future call site
 *  can't forget the check the way a few already did (found in review, 2026-07-14). */
export function isStoreVisible(store: Store): boolean {
  return !store.blocked;
}

/** getAllStores(), pre-filtered to non-blocked — the version every public discovery surface
 *  (homepage, /stores, search) should call instead of getAllStores() + an inline filter. */
export function getVisibleStores(): Store[] {
  return readStores().filter(isStoreVisible);
}

export function updateStore(storeId: string, updates: Partial<Omit<Store, 'id' | 'sellerId' | 'createdAt'>>): Store | null {
  const stores = readStores();
  const idx = stores.findIndex((s) => s.id === storeId);
  if (idx === -1) return null;
  stores[idx] = { ...stores[idx]!, ...updates };
  writeStores(stores);
  return stores[idx]!;
}

/** Prepends a background colour to the store's saved palette (deduped, newest-first, capped),
 *  returning the resulting list — the caller must have already validated the hex + ownership. */
export function addStoreBgColor(storeId: string, hex: string): string[] | null {
  const stores = readStores();
  const idx = stores.findIndex((s) => s.id === storeId);
  if (idx === -1) return null;
  const current = stores[idx]!.bgColors ?? [];
  const next = [hex, ...current.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, MAX_STORE_BG_COLORS);
  stores[idx] = { ...stores[idx]!, bgColors: next };
  writeStores(stores);
  return next;
}
