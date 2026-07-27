import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STORES_PATH = path.join(process.cwd(), 'data/stores.json');

export interface StoreColors {
  primary: string;
  accent: string;
}

export interface StoreShipping {
  /** Seller opted in to self-pickup from the store address. This is the ONLY shipping
   *  lever a seller has — courier/pickup-point are platform methods and their prices are
   *  platform-set (see lib/shipping.ts). A seller never sets shipping prices. */
  selfPickup?: boolean;
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
  /** External-inventory sync config (see feed-mapping.ts / feed-fetch.ts). A store that manages its
   *  stock in another system (POS/ERP/Shopify/Woo/spreadsheet) saves its feed URL once plus the
   *  column mapping from that feed's headers to our canonical fields; "sync now" (and, once a
   *  scheduler exists, an automatic pull) re-fetches and re-applies them, matching products by sku.
   *  All optional/additive — absent = feature unused. `mapping` is sourceHeader → canonical CSV key. */
  feedSync?: {
    url?: string;
    mapping?: Record<string, string>;
    lastSyncAt?: string;
  };
  /** Outbound-feed credential: when set, another system can pull THIS store's live catalog (incl.
   *  stock) as CSV/JSON from a tokenized, login-free URL (/api/store-feed/[token]). Absent = the
   *  store shares nothing out. Rotating or clearing it instantly invalidates the old URL. */
  feedExportToken?: string;
  /** Optional seller-owned custom domain (e.g. "shop.mybrand.co.il") that serves this store from
   *  its ROOT — an *addition to*, never a replacement for, the always-live local path /<slug>.
   *  When verified, the custom domain becomes the store's SEO canonical (storeCanonicalUrl);
   *  until then the platform path is canonical. One canonical either way — no duplicate content. OFF by default;
   *  seller-activated in settings. SSL + edge routing are handled by Cloudflare-for-SaaS custom
   *  hostnames (see custom-domain.ts) — this record only holds the seller's state. Absent = unused.
   *  `status` gates middleware serving: only 'active' (DNS + SSL verified) is served from a custom
   *  host; a 'pending' domain still routes exclusively through the platform domain. */
  customDomain?: {
    hostname: string;               // normalized, lowercase, no scheme/path/port (e.g. "shop.example.com")
    status: 'pending' | 'active';
    addedAt: string;
  };
  /** Slugs this store used before the seller renamed its URL. The store page 301-redirects any of
   *  these to the current slug so old links + Google's index transfer instead of 404-ing — that's
   *  what makes the URL editable without losing SEO. Newest-last, capped, never contains the current
   *  slug. See renameStoreSlug + getStoreByPreviousSlug. */
  previousSlugs?: string[];
  createdAt: string;
}

/** How many old slugs to remember per store (older 301 sources fall off). */
export const MAX_PREVIOUS_SLUGS = 10;

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

/** Turn free text into a URL slug: lowercase, spaces→hyphens, keep only a-z/0-9/hyphen, collapse
 *  repeats, trim edge hyphens. Returns '' when nothing usable remains — e.g. an all-Hebrew name,
 *  which is exactly why the store-creation form asks for a separate latin URL name instead of
 *  deriving the slug from a Hebrew store name (which used to yield junk like "--"). */
export function normalizeSlug(input: string): string {
  return input.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Top-level path segments a store slug must NEVER equal — every one is a real platform route
 *  (page or folder under src/pages). Because stores now live at the ROOT (dezabin.com/<slug>, not
 *  /store/<slug>), a slug colliding with one of these would be permanently shadowed by the static
 *  route (Astro resolves static routes before the dynamic [storeSlug] one) and the store would be
 *  unreachable. createStore() bumps a colliding slug (foo → foo-2); the middleware + custom-domain
 *  resolver share this set so they never mistake a reserved path for a store. Keep in sync with
 *  src/pages/ top-level entries. */
export const RESERVED_SLUGS = new Set<string>([
  'store', 'stores', 'search', 'checkout', 'cart', 'wishlist', 'account',
  'admin', 'api', 'seller', 'buyer', '404', 'index',
  'sitemap-content', 'llms', 'robots', 'favicon', '_astro', '_image', '_actions',
]);

/** A usable store slug: non-empty and not a reserved platform route. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

interface CreateStoreInput {
  name: string;
  /** Seller-chosen latin URL name → the store's slug. Falls back to a name-derived slug, then
   *  'store', if empty/all-non-latin (the form requires it, so the fallback is a safety net). */
  slug?: string;
  tagline?: string;
  description?: string;
}

export function createStore(sellerId: string, { name, slug: rawSlug, tagline = '', description = '' }: CreateStoreInput): Store {
  const stores = readStores();
  const base = normalizeSlug(rawSlug ?? '') || normalizeSlug(name) || 'store';
  let slug = base;
  let n = 2;
  // Bump on a slug that ANY store already claims (current OR previous — old slugs stay reserved so
  // 301s never break) OR a reserved route name (a root-level store can't own a real platform path).
  while (stores.some((s) => storeClaimsSlug(s, slug)) || isReservedSlug(slug)) { slug = `${base}-${n++}`; }

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

/** Resolves the unguessable per-store export token to its store (the outbound-feed counterpart to the
 *  inbound sync — another system pulls this store's live catalog from a tokenized URL, no login). The
 *  token IS the credential, so it must be long/random (see /api/store.ts gen-export-token). Linear
 *  scan today; an indexed lookup at DB-migration time (same signature). */
export function getStoreByExportToken(token: string): Store | null {
  if (!token) return null;
  return readStores().find((s) => s.feedExportToken === token) ?? null;
}

export function getAllStores(): Store[] {
  return readStores();
}

/** Resolves an inbound request Host to the store that owns it as an ACTIVE custom domain — the
 *  routing counterpart the middleware calls on every custom-host request. Only a verified
 *  (status 'active') hostname is served; a 'pending' one is ignored so an unverified domain can
 *  never hijack routing. Host is lowercased + port-stripped to match the stored normalized form.
 *  Linear scan today; an indexed lookup at DB-migration time (same signature). */
export function getStoreByCustomDomain(hostname: string): Store | null {
  const h = hostname.toLowerCase().replace(/:\d+$/, '').trim();
  if (!h) return null;
  return readStores().find((s) => s.customDomain?.status === 'active' && s.customDomain.hostname === h) ?? null;
}

/** True if ANY store other than `exceptStoreId` has already registered this hostname (pending OR
 *  active). A custom domain must be globally unique — two stores claiming the same host would make
 *  routing ambiguous (first-match wins). Enforced when a seller sets their domain (see /api/store.ts). */
export function isCustomDomainTaken(hostname: string, exceptStoreId: string): boolean {
  const h = hostname.toLowerCase().trim();
  return readStores().some((s) => s.id !== exceptStoreId && s.customDomain?.hostname === h);
}

/** True if a store CLAIMS this slug — either as its current slug OR in its previousSlugs. A previous
 *  slug stays reserved so it can never be reused by another store: otherwise the new owner's current
 *  slug would win resolution and silently break the original store's old 301 redirect. Pure. */
export function storeClaimsSlug(store: Pick<Store, 'slug' | 'previousSlugs'>, slug: string): boolean {
  return store.slug === slug || (store.previousSlugs?.includes(slug) ?? false);
}

/** True if `slug` is claimed (current OR previously) by some store OTHER than exceptStoreId — the
 *  cross-store uniqueness check for a rename/create. Reserving old slugs preserves everyone's 301s. A
 *  store's OWN previous slug is excluded (exceptStoreId), so it can freely rename back to it. */
export function isSlugTaken(slug: string, exceptStoreId: string): boolean {
  return readStores().some((s) => s.id !== exceptStoreId && storeClaimsSlug(s, slug));
}

/** Resolve a slug to its store by the CURRENT slug, falling back to a PREVIOUS slug (renamed since).
 *  Critical for checkout: a buyer's cart holds the slug from when the item was added, so a URL rename
 *  mid-purchase must NOT make the store "not found" and fail the order. Callers should key downstream
 *  work off the returned store.slug (the current one), not the slug they passed in. */
export function getStoreBySlugOrPrevious(slug: string): Store | null {
  return getStoreBySlug(slug) ?? getStoreByPreviousSlug(slug);
}

/** Find a store within an already-fetched list by its current slug OR any previous slug. Used by the
 *  seller data APIs so a client that cached an old slug (e.g. right after a URL rename, before the
 *  page updates) still resolves to the right store instead of 404-ing. */
export function findStoreBySlugOrPrevious(stores: Store[], slug: string | null): Store | undefined {
  if (!slug) return undefined;
  return stores.find((s) => s.slug === slug || s.previousSlugs?.includes(slug));
}

/** Resolve a slug that USED to belong to a store (renamed since) → that store, so the route can 301
 *  to its current slug. A live slug always wins first: callers check getStoreBySlug before this. */
export function getStoreByPreviousSlug(slug: string): Store | null {
  if (!slug) return null;
  return readStores().find((s) => s.slug !== slug && s.previousSlugs?.includes(slug)) ?? null;
}

/** The previousSlugs list after renaming oldSlug→newSlug: keep history + add oldSlug, drop newSlug
 *  (a revert), dedupe, cap to the most recent MAX_PREVIOUS_SLUGS. Pure — unit-tested. */
export function computeNextPreviousSlugs(current: string[] | undefined, oldSlug: string, newSlug: string): string[] {
  const list = [...(current ?? []), oldSlug].filter((s) => s && s !== newSlug);
  return Array.from(new Set(list)).slice(-MAX_PREVIOUS_SLUGS);
}

/** Change a store's URL slug, remembering the old one for 301 redirects (getStoreByPreviousSlug).
 *  The caller MUST have validated newSlug (normalized, non-empty, not reserved, not taken). The
 *  slug-keyed side stores (page-views, favorites) are migrated by the caller, not here. */
export function renameStoreSlug(storeId: string, newSlug: string): Store | null {
  const stores = readStores();
  const idx = stores.findIndex((s) => s.id === storeId);
  if (idx === -1) return null;
  const oldSlug = stores[idx]!.slug;
  if (oldSlug === newSlug) return stores[idx]!;
  const previousSlugs = computeNextPreviousSlugs(stores[idx]!.previousSlugs, oldSlug, newSlug);
  stores[idx] = { ...stores[idx]!, slug: newSlug, previousSlugs };
  writeStores(stores);
  return stores[idx]!;
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
