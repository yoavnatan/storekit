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
  createdAt: string;
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
