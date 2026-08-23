/**
 * The store record — the second module moved off `data/*.json` (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * Every exported reader and writer here is a query now, so all of them are `async` and all ~58
 * callers `await` (§3). The types and the answers are unchanged; what moved is where they come
 * from, plus the four things a file could not do and the database does:
 *
 *   · **Slug uniqueness is the index, not a scan before the write (§7.4).** Two sellers opening a
 *     store in the same moment used to both find the slug free and both take it.
 *   · **`previousSlugs` is its own table** (`store_previous_slugs`, §4). A 301 lookup is an indexed
 *     hit on a primary key instead of an array scan across every store, and the same table is what
 *     keeps a retired slug reserved against a *new* store claiming it.
 *   · **`customDomain.hostname` is a column, not a JSONB field**, because the middleware resolves it
 *     on every request that arrives — including the ones that are not a store at all.
 *   · **A deleted store is `deleted_at`, never a missing row (§7.9)** — its orders are financial
 *     records and must keep pointing at something. Every read here filters it out, so "deleted" and
 *     "not found" stay the same answer to the rest of the app.
 */
import crypto from 'node:crypto';
import { filterShopperStores, isDemoStore } from './demo-stores.js';
import { isStoreReachable, isStoreDiscoverable } from './store-status.js';
import type { StoreSale } from './discounts.js';
import { toSlug } from './url-base.js';
import { confusableSkeleton } from './slug-confusable.js';
import { NO_SUCH_UUID, firstRow, isUuid, query, rows, withTransaction, type Queryable } from './db.js';

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
  /** The uncropped uploads the two images above were cut from — written and read by the
   *  dashboard's image widget alone, so a seller can re-frame from the full photo instead of
   *  from their own previous crop (migration 0012). Absent for anything uploaded before that,
   *  and whenever the source upload failed; the widget falls back to the cropped image. Never
   *  rendered anywhere: every public surface reads `bannerImage`/`profileImage`. */
  bannerImageSource?: string;
  profileImageSource?: string;
  /** The seller's own logo for the TOP OF THEIR STORE, and nothing else — every other surface
   *  (store cards, search rows, the saved-stores menu, emails) keeps reading `profileImage`,
   *  because those are fixed circular slots and a logo's whole meaning is its aspect ratio
   *  (migration 0021). Uploading one does not adopt it: `headerStyle` decides. */
  headerLogo?: string;
  /** Which lockup the store header renders. 'name' is today's avatar + store name and the default
   *  for every store that has never chosen. Kept apart from `headerLogo` so switching back to the
   *  name does not throw the upload away. */
  headerStyle?: 'name' | 'logo';
  /** Store-wide sale: the seller's own headline/copy for a running sale, plus an optional
   *  percent that automatically applies to every product WITHOUT its own discount (a
   *  product's own discount always wins — see discounts.ts). Announcement and price live in
   *  one record on purpose, so a banner promising 30% can't drift from what the buyer pays.
   *  Absent/`active:false` = no banner, no price change. */
  sale?: StoreSale;
  address?: string;
  addressVisible?: boolean;
  hours?: StoreHours;
  hoursVisible?: boolean;
  /** Admin-only kill switch (see admin-moderation.ts) — a blocked store 404s on every
   *  public route and is excluded from every discovery surface (homepage, /stores,
   *  search), so it can't keep damaging the shared platform domain's Google standing
   *  while the seller sorts it out. Never set by anything but an admin action. */
  blocked?: boolean;
  /** Platform-owned showcase store ("חנות לדוגמה") — see lib/demo-stores.ts and
   *  GO_LIVE_CHECKLIST.md §6.2. Never indexed, never counted toward a store
   *  threshold, never checkout-able, and dropped from shopper discovery once the
   *  mall has real stores. Set only by the showcase seeder / by hand in data;
   *  the seller store-update endpoint whitelists fields, so a seller can't set it. */
  demo?: boolean;
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
    /** Why the last UNATTENDED pull failed, and when. Written and cleared by the scheduled run
     *  alone (`store-feed-sync.ts`), because it answers a question only the unattended run raises:
     *  the seller pressing "sync now" is reading the answer on screen. It is what lets the products
     *  tab say "your stock has stopped updating" without asking anything at render time —
     *  `lastSyncAt` cannot: a feed that broke an hour ago still carries yesterday's success. */
    lastError?: { problem: string; at: string };
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
    /** Last time the edge provider was asked whether this hostname still verifies (migration 0014).
     *  Absent = never re-checked since the column existed, which sorts FIRST in the job's rotation.
     *  `status` is only ever as true as this timestamp: a domain the seller has since unpointed
     *  stays 'active' until something asks again (jobs/registry.ts → custom-domain-check). */
    checkedAt?: string;
  };
  /** Slugs this store used before the seller renamed its URL. The store page 301-redirects any of
   *  these to the current slug so old links + Google's index transfer instead of 404-ing — that's
   *  what makes the URL editable without losing SEO. Newest-last, capped, never contains the current
   *  slug. See renameStoreSlug + getStoreByPreviousSlug. */
  previousSlugs?: string[];
  /** Seller-owned lifecycle — an operational halt or a permanent closure. All three are plain
   *  timestamps, all absent by default, and NONE of them deletes anything: the store record, its
   *  products, its orders, its ad spend and every historical total derived from them survive
   *  whatever state it is in, because that history happened. What each state means for shoppers,
   *  search engines and checkout is one table in lib/store-status.ts — read it there rather than
   *  testing these fields directly. Written only through lib/store-lifecycle.ts. */
  pausedAt?: string;
  /** Closure requested while orders were still open: the store stops selling at once and closes
   *  by itself when the last one is done (store-lifecycle.ts#settleStoreClosure). */
  closePendingAt?: string;
  closedAt?: string;
  /** When the store first became public. Absent = built but never live: the seller previews it,
   *  the public gets a 404 and no platform surface lists it (lib/store-status.ts, `unpublished`).
   *  Written only by lib/store-publication.ts. */
  publishedAt?: string;
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

/**
 * The logo the store HEADER should render, or `undefined` for the name-and-avatar lockup.
 *
 * One function rather than the two-part test written at each call site, because it is already asked
 * from three places that must agree — the store page, the product page, and the settings preview
 * that promises the seller what those two will do. The two halves are deliberately separate columns
 * (migration 0021): an uploaded logo the seller has not chosen must not appear, and choosing the
 * name back must not delete the upload. Conflating them at a call site is how one of the three ends
 * up rendering a logo the other two do not.
 */
export function storeHeaderLogo(store: Pick<Store, 'headerStyle' | 'headerLogo'>): string | undefined {
  return store.headerStyle === 'logo' && store.headerLogo ? store.headerLogo : undefined;
}

/**
 * One store row.
 *
 * Selected explicitly rather than `SELECT *`, so a column a later migration adds cannot silently
 * change what this module returns. `previous_slugs` is not a column at all — it is aggregated from
 * `store_previous_slugs` in the same statement, so every reader gets the whole record in one
 * round-trip instead of an N+1 per store on a list page.
 */
const COLUMNS = `s.id, s.seller_id, s.slug, s.name, s.tagline, s.description, s.colors,
    s.categories, s.shipping, s.banner_image, s.profile_image,
    s.banner_image_source, s.profile_image_source, s.header_logo, s.header_style,
    s.sale, s.address,
    s.address_visible, s.hours, s.hours_visible, s.blocked, s.demo, s.promo_weight, s.bg_colors,
    s.feed_sync, s.feed_export_token, s.custom_domain_hostname, s.custom_domain_status,
    s.custom_domain_added_at, s.custom_domain_checked_at,
    s.paused_at, s.close_pending_at, s.closed_at, s.published_at, s.created_at,
    (SELECT array_agg(p.slug::text ORDER BY p.replaced_at, p.slug)
       FROM store_previous_slugs p WHERE p.store_id = s.id) AS previous_slugs`;

/** The same columns unqualified, for `RETURNING` on an INSERT — where there is no alias to hang
 *  `s.` on, and no previous slug to aggregate because the store is one statement old. */
const INSERT_RETURNING = COLUMNS
  .slice(0, COLUMNS.indexOf('(SELECT'))
  .replace(/\bs\./g, '')
  .replace(/,\s*$/, '');

/**
 * `FROM` plus the one predicate that is never optional: a soft-deleted store is gone as far as the
 * application is concerned (§7.9). Written once so no query can forget it — the failure mode is a
 * closed-and-deleted store reappearing on the homepage, which nothing would report.
 */
const FROM_LIVE = 'FROM stores s WHERE s.deleted_at IS NULL';

/** §7.13: a table has no natural order. Ascending `created_at` is the order the JSON file gave, so
 *  no discovery surface reshuffles on the way over; `id` breaks a same-millisecond tie. */
const ORDER = 'ORDER BY s.created_at, s.id';

interface StoreRow {
  id: string;
  seller_id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  colors: StoreColors | null;
  categories: string[] | null;
  shipping: StoreShipping | null;
  banner_image: string | null;
  profile_image: string | null;
  banner_image_source: string | null;
  profile_image_source: string | null;
  header_logo: string | null;
  header_style: 'name' | 'logo' | null;
  sale: StoreSale | null;
  address: string | null;
  address_visible: boolean;
  hours: StoreHours | null;
  hours_visible: boolean;
  blocked: boolean;
  demo: boolean;
  promo_weight: number;
  bg_colors: string[] | null;
  feed_sync: Store['feedSync'] | null;
  feed_export_token: string | null;
  custom_domain_hostname: string | null;
  custom_domain_status: 'pending' | 'active' | null;
  custom_domain_added_at: Date | string | null;
  custom_domain_checked_at: Date | string | null;
  paused_at: Date | string | null;
  close_pending_at: Date | string | null;
  closed_at: Date | string | null;
  published_at: Date | string | null;
  created_at: Date | string | null;
  previous_slugs: string[] | null;
}

/** A `timestamptz` back to the ISO string every call site already reads. */
function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Row → `Store`, in the exact shape the rest of the app reads today.
 *
 * **Absent, not `null`.** Every optional field on the interface is written only when it has a
 * value, because ~40 call sites are written as `store.sale?.active` / `store.address ?? ''` and a
 * `null` behaves differently from a missing key under `??` and under `JSON.stringify`. The three
 * ARRAYS go the other way and are always present (possibly empty): every consumer already reads
 * them as `(store.categories ?? [])`, and an always-array removes the branch instead of preserving
 * a distinction — absent vs `[]` — that nothing in the app has ever acted on.
 */
function toStore(row: StoreRow): Store {
  const store: Store = {
    id: row.id,
    sellerId: row.seller_id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    colors: (row.colors ?? {}) as StoreColors,
    categories: row.categories ?? [],
    shipping: (row.shipping ?? {}) as StoreShipping,
    bgColors: row.bg_colors ?? [],
    previousSlugs: row.previous_slugs ?? [],
    createdAt: iso(row.created_at) ?? '',
  };
  if (row.banner_image) store.bannerImage = row.banner_image;
  if (row.profile_image) store.profileImage = row.profile_image;
  if (row.banner_image_source) store.bannerImageSource = row.banner_image_source;
  if (row.profile_image_source) store.profileImageSource = row.profile_image_source;
  if (row.header_logo) store.headerLogo = row.header_logo;
  // Only the non-default is carried, so `headerStyle` reads absent for the overwhelming majority of
  // stores and every consumer's `=== 'logo'` test is the same shape as the other optional fields.
  if (row.header_style === 'logo') store.headerStyle = 'logo';
  if (row.sale) store.sale = row.sale;
  if (row.address) store.address = row.address;
  if (row.address_visible) store.addressVisible = true;
  if (row.hours) store.hours = row.hours;
  if (row.hours_visible) store.hoursVisible = true;
  if (row.blocked) store.blocked = true;
  if (row.demo) store.demo = true;
  if (row.promo_weight) store.promoWeight = row.promo_weight;
  if (row.feed_sync) store.feedSync = row.feed_sync;
  if (row.feed_export_token) store.feedExportToken = row.feed_export_token;
  if (row.custom_domain_hostname && row.custom_domain_status) {
    store.customDomain = {
      hostname: row.custom_domain_hostname,
      status: row.custom_domain_status,
      addedAt: iso(row.custom_domain_added_at) ?? '',
    };
    const checkedAt = iso(row.custom_domain_checked_at);
    if (checkedAt) store.customDomain.checkedAt = checkedAt;
  }
  const pausedAt = iso(row.paused_at);
  if (pausedAt) store.pausedAt = pausedAt;
  const closePendingAt = iso(row.close_pending_at);
  if (closePendingAt) store.closePendingAt = closePendingAt;
  const closedAt = iso(row.closed_at);
  if (closedAt) store.closedAt = closedAt;
  const publishedAt = iso(row.published_at);
  if (publishedAt) store.publishedAt = publishedAt;
  return store;
}

async function selectStores(where: string, params: readonly unknown[] = []): Promise<Store[]> {
  return (await rows<StoreRow>(`SELECT ${COLUMNS} ${FROM_LIVE} AND ${where} ${ORDER}`, params)).map(toStore);
}

async function selectStore(where: string, params: readonly unknown[] = []): Promise<Store | null> {
  const row = await firstRow<StoreRow>(`SELECT ${COLUMNS} ${FROM_LIVE} AND ${where} ${ORDER} LIMIT 1`, params);
  return row ? toStore(row) : null;
}

/** Turn free text into a store URL slug — `url-base.ts#toSlug`, which is also what product slugs
 *  use. Latin stays the suggested form (the field's placeholder, and what the hint recommends),
 *  but Hebrew is ACCEPTED since 2026-08-02: the seller picks this one himself, so the form states
 *  the trade-off (a Hebrew link percent-encodes to a long string when some apps paste it) and lets
 *  him decide, rather than the field silently deleting what he typed. */
export function normalizeSlug(input: string): string {
  return toSlug(input);
}

/** Top-level path segments a store slug must NEVER equal — every one is a real platform route
 *  (page or folder under src/pages). Because stores now live at the ROOT (dezabin.co.il/<slug>, not
 *  /store/<slug>), a slug colliding with one of these would be permanently shadowed by the static
 *  route (Astro resolves static routes before the dynamic [storeSlug] one) and the store would be
 *  unreachable. createStore() bumps a colliding slug (foo → foo-2); the middleware + custom-domain
 *  resolver share this set so they never mistake a reserved path for a store. Keep in sync with
 *  src/pages/ top-level entries. */
export const RESERVED_SLUGS = new Set<string>([
  'store', 'stores', 'search', 'checkout', 'cart', 'wishlist', 'account',
  'admin', 'api', 'seller', 'buyer', '404', 'index',
  'sitemap-content', 'llms', 'robots', 'favicon', '_astro', '_image', '_actions',
  'store-unavailable', 'store-gone',
  // The two footer routes. They were linked from every page on the site while being neither pages
  // nor reserved words — so `/terms` fell through to the store router, and a seller who registered
  // the slug `terms` would have had the whole platform linking "תנאי שימוש" to their storefront.
  // A reserved word and a real page are two halves of one fix: reserving alone leaves the 404 that
  // Merchant Center reads as a shop with no published terms (contact.astro).
  'terms', 'contact', 'returns-policy',
  // The review link the order mail and the buyer's own order list both point at (`/review/<id>`).
  // Reserved for the same reason as the two above — an unreserved segment falls through to the
  // store router, so a seller registering the slug `review` would answer for everyone's review
  // links. `tests/external-contract.test.ts` is what caught it.
  'review',
]);

const LONGEST_RESERVED_SLUG = Math.max(...[...RESERVED_SLUGS].map((s) => s.length));

/** A usable store slug: non-empty and not a reserved platform route.
 *
 *  Matched on the slug's SKELETON (slug-confusable.ts), not the raw string: since slugs may hold
 *  non-Latin letters, `аdmin` with a Cyrillic а is a different string that reads as `admin` to
 *  every human and to Google. Folding the confusables covers every lookalike spelling of every
 *  reserved word at once — the alternative was enumerating variations by hand and staying wrong
 *  about the ones nobody listed. A Hebrew or Arabic slug folds to itself and can never collide. */
export function isReservedSlug(slug: string): boolean {
  // Length first: the middleware and the custom-domain resolver call this with a RAW request path
  // segment, which no toSlug cap has been near. A segment longer than the longest reserved word
  // cannot be one, so it never reaches the per-character fold. Skeletons are 1:1 on length, so this
  // can't skip a real match.
  if (slug.length > LONGEST_RESERVED_SLUG) return false;
  return RESERVED_SLUGS.has(confusableSkeleton(slug));
}

interface CreateStoreInput {
  name: string;
  /** Seller-chosen latin URL name → the store's slug. Falls back to a name-derived slug, then
   *  'store', if empty/all-non-latin (the form requires it, so the fallback is a safety net). */
  slug?: string;
  tagline?: string;
  description?: string;
}

/** How many stores one seller account may open (decided 2026-07-27). All of a seller's stores bill
 *  through their ONE registered business — the sub-merchant at the payment processor is per legal
 *  entity, not per store — so a separate legal entity means a separate account, not a 6th store.
 *  The cap is an abuse brake (a logged-in seller could otherwise mint slugs endlessly), not a
 *  product tier; raise it here and both the API guard and the dashboard's "open another store"
 *  entry point follow. */
export const MAX_STORES_PER_SELLER = 5;

/** True when the seller has room for another store. Callers MUST check this server-side before
 *  createStore() — hiding the button is not the guard. */
export async function canOpenAnotherStore(sellerId: string): Promise<boolean> {
  if (!isUuid(sellerId)) return false;
  const row = await firstRow<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM stores WHERE seller_id = $1 AND deleted_at IS NULL',
    [sellerId],
  );
  return (row?.n ?? 0) < MAX_STORES_PER_SELLER;
}

/**
 * How many bumped slugs to try before giving up on `foo-2, foo-3, …` and appending randomness.
 * Sequential bumping is what a seller expects to see; past a couple of dozen collisions the
 * readable form has stopped being informative and the loop only has to terminate.
 */
const SLUG_BUMP_ATTEMPTS = 24;

/**
 * Open a store, giving it a slug nobody else holds.
 *
 * **The uniqueness check IS the insert (§7.4).** The file version read every store, looked for the
 * slug, then wrote — so two sellers registering `keramika` in the same moment both found it free
 * and the second silently overwrote the first's URL. Here the attempt either lands or comes back
 * with zero rows, and zero rows means "taken" no matter who else was mid-write.
 *
 * A slug is taken by TWO tables, which is why the statement carries a `NOT EXISTS` beside the
 * `ON CONFLICT`: `stores.slug` for a live store, and `store_previous_slugs` for one some store used
 * to have. Handing a retired slug to a new store would silently break the original owner's 301 —
 * the new store's live slug wins resolution and the old link stops arriving where it was pointed.
 */
export async function createStore(sellerId: string, { name, slug: rawSlug, tagline = '', description = '' }: CreateStoreInput): Promise<Store> {
  const base = normalizeSlug(rawSlug ?? '') || normalizeSlug(name) || 'store';

  for (let attempt = 0; attempt <= SLUG_BUMP_ATTEMPTS + 1; attempt += 1) {
    const slug = attempt === 0 ? base
      : attempt <= SLUG_BUMP_ATTEMPTS ? `${base}-${attempt + 1}`
      : `${base}-${crypto.randomBytes(4).toString('hex')}`;
    // A root-level store can never own a real platform path — that route would shadow it forever.
    if (isReservedSlug(slug)) continue;

    const row = await firstRow<StoreRow>(
      // `published_at` is named and left NULL — the column DEFAULTS to now() so that a row written
      // by a seeder or a fixture means "already on the site", and this is the one place where the
      // opposite is true: a shop a real person just opened is his to build and look at before he is
      // asked for a card, and it goes public when `store-publication.ts` says both holds are clear.
      `INSERT INTO stores (id, seller_id, slug, name, tagline, description, colors, created_at, published_at)
       SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, now(), NULL
        WHERE NOT EXISTS (SELECT 1 FROM store_previous_slugs WHERE slug = $3)
       ON CONFLICT (slug) DO NOTHING
       RETURNING ${INSERT_RETURNING}`,
      [
        crypto.randomUUID(), sellerId, slug, name, tagline, description,
        JSON.stringify({ primary: '#1e7a46', accent: '#f97316' }),
      ],
    );
    if (row) return toStore({ ...row, previous_slugs: null });
  }
  // Unreachable in practice — the last attempt carries 32 bits of randomness. Throwing beats
  // returning a store the caller would then have to null-check for the first time.
  throw new Error(`Could not find a free slug for "${name}"`);
}

/** The seller's first store (oldest), or null. Kept for the call sites that predate multi-store. */
export async function getStoreBySellerId(sellerId: string): Promise<Store | null> {
  if (!isUuid(sellerId)) return null;
  return selectStore('s.seller_id = $1', [sellerId]);
}

export async function getStoresBySellerId(sellerId: string): Promise<Store[]> {
  if (!isUuid(sellerId)) return [];
  return selectStores('s.seller_id = $1', [sellerId]);
}

/** Stored slugs are NFKC (normalizeSlug), so the incoming one is folded the same way before it is
 *  compared: now that a slug can be Hebrew, the SAME word can arrive spelled a second way — a link
 *  pasted out of a source using presentation forms, or a decomposed paste — and an exact match
 *  would 404 a store that plainly exists.
 *
 *  **Case is deliberately NOT folded, and the column being `citext` is why that needs saying.**
 *  `citext` is there so `Acme` and `acme` can never become two stores (§7.11) — a uniqueness rule.
 *  Resolution is the opposite question: if `/MyStore` also served the page, one store would sit at
 *  every capitalisation of its name, which is duplicate content pointing at one canonical. The
 *  `::text` comparison beside the indexed one keeps the file version's answer — `/MyStore` misses —
 *  while the index still does the work of finding the candidate row. */
export async function getStoreBySlug(slug: string): Promise<Store | null> {
  if (!slug) return null;
  const wanted = slug.normalize('NFKC');
  // Two parameters for one value on purpose: `$1` is inferred as `citext` from the indexed
  // comparison, and reusing it under a `::text` cast would leave its type ambiguous to the planner.
  return selectStore('s.slug = $1 AND s.slug::text = $2', [wanted, wanted]);
}

export async function getStoreById(id: string): Promise<Store | null> {
  if (!isUuid(id)) return null;
  return selectStore('s.id = $1', [id]);
}

/** Resolves the unguessable per-store export token to its store (the outbound-feed counterpart to the
 *  inbound sync — another system pulls this store's live catalog from a tokenized URL, no login). The
 *  token IS the credential, so it must be long/random (see /api/store.ts gen-export-token). */
export async function getStoreByExportToken(token: string): Promise<Store | null> {
  if (!token) return null;
  return selectStore('s.feed_export_token = $1', [token]);
}

/**
 * Every store, including blocked and closed ones — the ADMIN ROSTER.
 *
 * **What §3 left here on purpose (2026-08-03).** Everything this used to be summed FOR is a query
 * now: revenue per store, product counts, open orders, sales per period and the platform headline
 * (`order-reporting.ts`, `store-products.ts#getProductCountsByStore`). What remains is the roster
 * itself — the admin's Stores tab and Sellers tab are lists OF stores, cross-searched by seller
 * name and sorted by a Hebrew `localeCompare` the database's collation is not, and the Attention
 * and Advertising tabs partition the same list. One read serves all of them.
 *
 * It is still O(platform), and at 100,000 stores this screen needs SQL paging, a collation
 * decision and a per-tab query each. That is a bigger change than §3 and it is written down in
 * DB_MIGRATION_PLAN.md §3 rather than started halfway: the numbers were the part that could not
 * wait, because they are what the owner reads as money.
 */
export async function getAllStores(): Promise<Store[]> {
  return (await rows<StoreRow>(`SELECT ${COLUMNS} ${FROM_LIVE} ${ORDER}`)).map(toStore);
}

/**
 * The stores that have a saved external-inventory feed URL — the scheduler's `feed-sync` work list
 * (`lib/jobs/registry.ts`, DB_MIGRATION_PLAN.md §8 stage 4a).
 *
 * A query rather than `getAllStores().filter(…)` for the reason §3 settled every other list on:
 * the job runs on a timer whether or not anyone is looking, and reading every store on the platform
 * to find the handful with a feed is O(platform) work to produce an O(few) answer. The predicate is
 * cheap enough to belong in SQL — it is `is this JSON field non-empty`, not a business rule, so
 * there is no pure-function twin here to drift from.
 *
 * It does NOT filter on whether the store may sell. That stays in the job, over `canStoreSell`, so
 * the lifecycle table (`store-status.ts`) keeps exactly one definition and the database never grows
 * a second copy of it.
 *
 * **Bounded, and ordered by who has waited longest.** The job's work is one outbound request per
 * store to a server we do not control, run in sequence, so it is the one job whose duration grows
 * with the platform: at a thousand feed-syncing stores an unbounded run would outlast its own
 * 30-minute lease, and a second instance would start a duplicate pass over the same stores. Nothing
 * would break — every job is idempotent — but the platform would spend the hour doing the work
 * twice. `lastSyncAt ASC NULLS FIRST` makes the cap a rotation rather than a cut-off: a store that
 * did not fit in this run is first in the next one, and a store that has never synced goes first of
 * all. The job says out loud when the cap bound it (`registry.ts`) — a silent truncation reads as
 * "everyone was synced".
 */
export async function getStoresWithFeedUrl(limit = 200): Promise<Store[]> {
  return (await rows<StoreRow>(
    `SELECT ${COLUMNS} ${FROM_LIVE} AND btrim(coalesce(s.feed_sync->>'url', '')) <> ''
      ORDER BY s.feed_sync->>'lastSyncAt' ASC NULLS FIRST, s.id
      LIMIT $1`,
    [limit],
  )).map(toStore);
}

/** The stores behind a known set of ids, in one statement — for a caller that holds references
 *  (a message's `toStoreId`, a favourite) and needs the name/avatar beside each. The buyer
 *  dashboard read EVERY store on the platform to look up the handful its message threads point at
 *  (§3). Ids that name no live store simply have no entry. */
export async function getStoresByIds(storeIds: readonly string[]): Promise<Store[]> {
  const ids = [...new Set(storeIds.filter(isUuid))];
  if (!ids.length) return [];
  return selectStores('s.id = ANY($1::uuid[])', [ids]);
}


/**
 * The stores behind a list of slugs, in ONE statement, returned in the order the slugs were given.
 *
 * For a caller holding ranked slugs — search results — where looking each one up in a loop is 2N
 * round trips on a shopper-typed page. Order is preserved explicitly because the ranking IS the
 * answer there: a `WHERE slug = ANY(...)` returns rows in whatever order the plan produces, which
 * would silently re-sort the results by nothing.
 */
export async function getStoresBySlugs(slugs: readonly string[]): Promise<Store[]> {
  const wanted = [...new Set(slugs.filter(Boolean))];
  if (!wanted.length) return [];
  const found = await selectStores('s.slug = ANY($1::citext[])', [wanted]);
  const bySlug = new Map(found.map((store) => [store.slug.toLowerCase(), store]));
  return wanted.map((slug) => bySlug.get(slug.toLowerCase())).filter((s): s is Store => !!s);
}

/**
 * Every store that has registered a custom domain, longest-unchecked first, capped.
 *
 * Feeds the re-check job (jobs/registry.ts → custom-domain-check). Both statuses are returned, and
 * that is deliberate in both directions: an 'active' domain must be caught when it STOPS verifying
 * (the seller's store would otherwise 301 into a dead host forever), and a 'pending' one must be
 * caught when it STARTS (the seller pointed their DNS, walked away, and nothing was ever going to
 * tell them it worked — the dashboard's button only helps someone still sitting in front of it).
 *
 * No `canStoreSell` filter, unlike the feed job: a paused or blocked store still owns its hostname
 * and still needs it kept honest, or it comes back from a pause to a domain that quietly died while
 * nobody was looking. Deleted stores are excluded — their hostname is released with them.
 */
export async function getStoresWithCustomDomain(limit = 200): Promise<Store[]> {
  return (await rows<StoreRow>(
    `SELECT ${COLUMNS} ${FROM_LIVE} AND s.custom_domain_hostname IS NOT NULL
      ORDER BY s.custom_domain_checked_at ASC NULLS FIRST, s.id
      LIMIT $1`,
    [limit],
  )).map(toStore);
}

/** Resolves an inbound request Host to the store that owns it as an ACTIVE custom domain — the
 *  routing counterpart the middleware calls on every custom-host request. Only a verified
 *  (status 'active') hostname is served; a 'pending' one is ignored so an unverified domain can
 *  never hijack routing. Host is lowercased + port-stripped to match the stored normalized form. */
export async function getStoreByCustomDomain(hostname: string): Promise<Store | null> {
  const h = hostname.toLowerCase().replace(/:\d+$/, '').trim();
  if (!h) return null;
  return selectStore(`s.custom_domain_status = 'active' AND s.custom_domain_hostname = $1`, [h]);
}

/** How many old hostnames to remember per store. Same shape and same reason as MAX_PREVIOUS_SLUGS:
 *  the oldest 301 source falls off rather than the list growing without bound. */
export const MAX_PREVIOUS_DOMAINS = 5;

/**
 * Remember the hostname a store is moving OFF, so its old links keep working (migration 0015).
 *
 * Called before the record is cleared or overwritten — after that the hostname is gone and there is
 * nothing left to redirect from. Idempotent by primary key: re-remembering the same host just
 * refreshes its timestamp rather than failing the operation that called it.
 */
export async function rememberPreviousCustomDomain(storeId: string, hostname: string): Promise<void> {
  const h = hostname.toLowerCase().trim();
  if (!isUuid(storeId) || !h) return;
  await query(
    `INSERT INTO store_previous_domains (hostname, store_id, replaced_at) VALUES ($1, $2::uuid, now())
       ON CONFLICT (hostname) DO UPDATE SET store_id = EXCLUDED.store_id, replaced_at = now()`,
    [h, storeId],
  );
  // Trim to the newest N for this store. A `NOT IN (SELECT … LIMIT)` rather than a second round
  // trip, so the cap costs nothing on the ordinary path where there is nothing to trim.
  await query(
    `DELETE FROM store_previous_domains
      WHERE store_id = $1::uuid
        AND hostname NOT IN (
          SELECT hostname FROM store_previous_domains WHERE store_id = $1::uuid
           ORDER BY replaced_at DESC LIMIT $2)`,
    [storeId, MAX_PREVIOUS_DOMAINS],
  );
}

/**
 * A hostname has BECOME somebody's active domain — drop any memory of a previous owner.
 *
 * Without this, a store that once used `shop.example` would keep 301-ing it away from the store
 * that owns it today: the redirect below looks up previous owners only when no active store claims
 * the host, but a lapsed domain and a re-registered one are the same string.
 *
 * **Called on the pending→active transition, and NOT when the seller types the hostname in
 * (area audit row 5, 2026-08-16).** It used to run at registration, which made this one statement
 * reachable by any logged-in seller with any string: type a competitor's OLD hostname into your own
 * domain field and their row is deleted — every link, bookmark and indexed page that store earned
 * on that domain stops being a 301 and becomes a 404, permanently, with no error on either side and
 * nothing that restores the row. Typing a hostname is not evidence of owning it. Verification IS
 * (custom-domain-verify.ts), so that is where the row may be taken.
 *
 * Nothing is lost by waiting: while the new claim is still `pending`, `getStoreByCustomDomain`
 * matches only `'active'` and the middleware asks it FIRST, so the previous owner's 301 is both
 * correct and already shadowed the moment the new domain goes live.
 */
export async function claimCustomDomainHostname(hostname: string): Promise<void> {
  const h = hostname.toLowerCase().trim();
  if (!h) return;
  await query(`DELETE FROM store_previous_domains WHERE hostname = $1`, [h]);
}

/**
 * The store that USED to be served from this hostname, if any — the 301 source for an old link.
 *
 * Consulted only after `getStoreByCustomDomain` finds no active owner, so an active domain can
 * never be shadowed by a stale row.
 */
export async function getStoreByPreviousCustomDomain(hostname: string): Promise<Store | null> {
  const h = hostname.toLowerCase().replace(/:\d+$/, '').trim();
  if (!h) return null;
  return selectStore(
    `s.id = (SELECT store_id FROM store_previous_domains WHERE hostname = $1)`,
    [h],
  );
}

/**
 * True if another store is already **SERVED** on this hostname — the one conflict that is real.
 *
 * **`pending` deliberately does not block (area audit row 5, 2026-08-16, with migration 0029).** It
 * used to, because `custom_domain_hostname` was globally `UNIQUE`, and that made a squat free and
 * permanent: type a hostname you do not own, it stores as pending, it can never verify (you do not
 * control the DNS), and its real owner is answered `domain-taken` from then on with no way to see
 * why or by whom. A pending claim is an assertion — the field takes any string — so it may not
 * exclude anybody. 0029 narrows the constraint to `WHERE custom_domain_status = 'active'`, and this
 * is the readable 409 in front of it.
 *
 * Two pending claims on one hostname conflict over nothing: `getStoreByCustomDomain` matches
 * `'active'` only, so neither routes, and whichever verifies is the one that becomes real. The
 * promotion asks this again before writing `'active'` (`custom-domain-verify.ts`) — that is where
 * the answer stops being about intent and starts being about routing.
 */
export async function isCustomDomainTaken(hostname: string, exceptStoreId: string): Promise<boolean> {
  const h = hostname.toLowerCase().trim();
  if (!h) return false;
  const row = await firstRow<{ one: number }>(
    `SELECT 1 AS one FROM stores
      WHERE deleted_at IS NULL AND custom_domain_status = 'active'
        AND custom_domain_hostname = $1 AND id <> $2::uuid LIMIT 1`,
    [h, isUuid(exceptStoreId) ? exceptStoreId : NO_SUCH_UUID],
  );
  return Boolean(row);
}

/** True if a store CLAIMS this slug — either as its current slug OR in its previousSlugs. A previous
 *  slug stays reserved so it can never be reused by another store: otherwise the new owner's current
 *  slug would win resolution and silently break the original store's old 301 redirect. Pure. */
export function storeClaimsSlug(store: Pick<Store, 'slug' | 'previousSlugs'>, slug: string): boolean {
  return store.slug === slug || (store.previousSlugs?.includes(slug) ?? false);
}

/** True if `slug` is claimed (current OR previously) by some store OTHER than exceptStoreId — the
 *  cross-store uniqueness check for a rename/create. Reserving old slugs preserves everyone's 301s. A
 *  store's OWN previous slug is excluded (exceptStoreId), so it can freely rename back to it.
 *
 *  One statement over the two tables that can hold a claim. `citext` on both columns is what makes
 *  this the same answer for `Acme` and `acme` — the uniqueness side of the choice explained on
 *  getStoreBySlug. */
export async function isSlugTaken(slug: string, exceptStoreId: string): Promise<boolean> {
  if (!slug) return false;
  const except = isUuid(exceptStoreId) ? exceptStoreId : NO_SUCH_UUID;
  const row = await firstRow<{ one: number }>(
    `SELECT 1 AS one FROM stores WHERE slug = $1 AND id <> $2::uuid AND deleted_at IS NULL
     UNION ALL
     SELECT 1 AS one FROM store_previous_slugs WHERE slug = $1 AND store_id <> $2::uuid
     LIMIT 1`,
    [slug.normalize('NFKC'), except],
  );
  return Boolean(row);
}

/** Resolve a slug to its store by the CURRENT slug, falling back to a PREVIOUS slug (renamed since).
 *  Critical for checkout: a buyer's cart holds the slug from when the item was added, so a URL rename
 *  mid-purchase must NOT make the store "not found" and fail the order. Callers should key downstream
 *  work off the returned store.slug (the current one), not the slug they passed in. */
export async function getStoreBySlugOrPrevious(slug: string): Promise<Store | null> {
  return (await getStoreBySlug(slug)) ?? (await getStoreByPreviousSlug(slug));
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
export async function getStoreByPreviousSlug(slug: string): Promise<Store | null> {
  if (!slug) return null;
  return selectStore(
    `s.slug <> $1 AND EXISTS (SELECT 1 FROM store_previous_slugs p WHERE p.store_id = s.id AND p.slug = $1)`,
    [slug.normalize('NFKC')],
  );
}

/** The previousSlugs list after renaming oldSlug→newSlug: keep history + add oldSlug, drop newSlug
 *  (a revert), dedupe, cap to the most recent MAX_PREVIOUS_SLUGS. Pure — unit-tested. */
export function computeNextPreviousSlugs(current: string[] | undefined, oldSlug: string, newSlug: string): string[] {
  const list = [...(current ?? []), oldSlug].filter((s) => s && s !== newSlug);
  return Array.from(new Set(list)).slice(-MAX_PREVIOUS_SLUGS);
}

/**
 * Change a store's URL slug, remembering the old one for 301 redirects (getStoreByPreviousSlug).
 * The caller MUST have validated newSlug (normalized, non-empty, not reserved, not taken). The
 * slug-keyed side stores (page-views, favorites) are migrated by the caller, not here.
 *
 * One transaction, because a rename that renamed the store but failed to record the old slug would
 * 404 every link that ever pointed at it, with nothing to reconstruct them from.
 *
 * `computeNextPreviousSlugs` still decides the list — it holds the revert rule and the cap and it is
 * unit-tested — and the whole set is then rewritten, with `replaced_at` spread by a microsecond per
 * position so reading it back yields exactly the order the rule produced. Nothing reads `replaced_at`
 * as a date; it exists to give the set an order, and this is what makes that order the intended one
 * rather than alphabetical-by-accident.
 */
export async function renameStoreSlug(storeId: string, newSlug: string): Promise<Store | null> {
  if (!isUuid(storeId)) return null;
  return withTransaction(async (tx) => {
    const current = await selectStoreTx(tx, storeId);
    if (!current) return null;
    if (current.slug === newSlug) return current;

    const previousSlugs = computeNextPreviousSlugs(current.previousSlugs, current.slug, newSlug);
    await tx.query('DELETE FROM store_previous_slugs WHERE store_id = $1', [storeId]);
    // Also releases the incoming slug if ANOTHER store retired it — the caller has already
    // established it is free (isSlugTaken), and a stale row here would break the unique index.
    await tx.query('DELETE FROM store_previous_slugs WHERE slug = $1', [newSlug]);
    if (previousSlugs.length) {
      await tx.query(
        `INSERT INTO store_previous_slugs (slug, store_id, replaced_at)
         SELECT value, $1, now() + (ord::double precision * interval '1 microsecond')
           FROM unnest($2::text[]) WITH ORDINALITY AS t(value, ord)`,
        [storeId, previousSlugs],
      );
    }
    await tx.query('UPDATE stores SET slug = $2 WHERE id = $1', [storeId, newSlug]);
    return selectStoreTx(tx, storeId);
  });
}

/** The same read as `getStoreById`, on a specific connection — a transaction must not reach for a
 *  second pooled one, which would sit outside it and read pre-commit state. */
async function selectStoreTx(tx: Queryable, storeId: string): Promise<Store | null> {
  const { rows: found } = await tx.query<StoreRow>(
    `SELECT ${COLUMNS} ${FROM_LIVE} AND s.id = $1`, [storeId],
  );
  return found[0] ? toStore(found[0]) : null;
}

/** Does the store's own URL still serve a storefront? False for an admin block (404) and for a
 *  completed closure (410) — true for a seller's operational pause, which deliberately keeps the
 *  page up with a notice. Every public surface must gate through one of these three predicates —
 *  not repeat `!store.blocked` inline — so a future call site can't forget the check the way a
 *  few already did (found in review, 2026-07-14). The rules are one table: lib/store-status.ts.
 *
 *  Which one to reach for: `isStoreVisible` = may this URL render at all; `isStoreDiscoverable`
 *  = may a platform surface link to or index it; `canStoreSell` = may money move. */
export function isStoreVisible(store: Store): boolean {
  return isStoreReachable(store);
}

export { isStoreDiscoverable, canStoreSell, storeLifecycle, storeHttpStatus, showsPausedNotice, isStorePublished } from './store-status.js';
export type { StoreLifecycle } from './store-status.js';

/** getAllStores(), pre-filtered to what a platform surface may LIST — the version every public
 *  discovery surface (homepage, /stores, search, sitemap, feed) should call instead of
 *  getAllStores() + an inline filter. Excludes blocked, closed, closing and paused stores.
 *
 *  `NOT blocked` is pushed into SQL (it is half of the `stores_live_idx` partial predicate, so the
 *  blocked rows are not even in the index); the lifecycle half stays in `isStoreDiscoverable` so
 *  the status table remains the single definition of what each state means. */
export async function getVisibleStores(): Promise<Store[]> {
  return (await selectStores('NOT s.blocked')).filter(isStoreDiscoverable);
}

/** What a SHOPPER-facing discovery surface lists (homepage, /stores, site search):
 *  getVisibleStores() with the platform's own showcase stores dropped as soon as
 *  there are real stores to show instead. See lib/demo-stores.ts. */
export async function getShopperStores(): Promise<Store[]> {
  return filterShopperStores(await getVisibleStores());
}

/** What a SEARCH ENGINE or an outbound feed may see: getVisibleStores() minus every
 *  showcase store, always. Sitemap, llms.txt, the Merchant/Meta product feed and
 *  IndexNow all gate through this — fabricated catalog must never be advertised. */
export async function getIndexableStores(): Promise<Store[]> {
  return (await getVisibleStores()).filter((s) => !isDemoStore(s));
}

/** The platform's showcase stores, oldest first. Unlike the shopper surfaces this
 *  is NOT thresholded — the seller-facing "צפו בחנות לדוגמה" entry point stays
 *  live forever, which is why it reads its own list instead of getShopperStores().
 *  Empty list = the showcase seeder was never run; every call site must degrade to
 *  rendering nothing rather than to a dead link. */
export async function getDemoStores(): Promise<Store[]> {
  return (await getVisibleStores())
    .filter(isDemoStore)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Which field maps to which column, and how its value reaches SQL.
 *
 * `slug` and `previousSlugs` are deliberately absent: they are one thing (a URL plus the 301s that
 * keep pointing at it) and `renameStoreSlug` is their only writer. A `updateStore(id, { slug })`
 * would move the URL and abandon every old link in the same statement.
 *
 * Every flag casts through `Boolean` rather than passing the value along, because §7.12 is exactly
 * this column set: a `NULL` in a flag column answers neither `= true` nor `= false`, and the store
 * drops out of every filtered query with no error anywhere.
 */
const UPDATABLE: Record<string, { sql: string; value: (v: unknown) => unknown }> = {
  name:           { sql: 'name = $', value: (v) => String(v ?? '') },
  tagline:        { sql: 'tagline = $', value: (v) => String(v ?? '') },
  description:    { sql: 'description = $', value: (v) => String(v ?? '') },
  colors:         { sql: 'colors = $::jsonb', value: (v) => JSON.stringify(v ?? {}) },
  categories:     { sql: 'categories = $::text[]', value: (v) => (v as string[] | undefined) ?? [] },
  shipping:       { sql: 'shipping = $::jsonb', value: (v) => JSON.stringify(v ?? {}) },
  bannerImage:    { sql: 'banner_image = $', value: (v) => v ?? null },
  profileImage:   { sql: 'profile_image = $', value: (v) => v ?? null },
  bannerImageSource:  { sql: 'banner_image_source = $', value: (v) => v ?? null },
  profileImageSource: { sql: 'profile_image_source = $', value: (v) => v ?? null },
  headerLogo:  { sql: 'header_logo = $', value: (v) => v ?? null },
  // NOT NULL with a default in the schema, so an absent/unknown value writes the default rather
  // than null — a settings save that omitted it would otherwise violate the column.
  headerStyle: { sql: 'header_style = $', value: (v) => (v === 'logo' ? 'logo' : 'name') },
  sale:           { sql: 'sale = $::jsonb', value: (v) => (v == null ? null : JSON.stringify(v)) },
  address:        { sql: 'address = $', value: (v) => v ?? null },
  addressVisible: { sql: 'address_visible = $', value: (v) => Boolean(v) },
  hours:          { sql: 'hours = $::jsonb', value: (v) => (v == null ? null : JSON.stringify(v)) },
  hoursVisible:   { sql: 'hours_visible = $', value: (v) => Boolean(v) },
  blocked:        { sql: 'blocked = $', value: (v) => Boolean(v) },
  demo:           { sql: 'demo = $', value: (v) => Boolean(v) },
  promoWeight:    { sql: 'promo_weight = $', value: (v) => Number(v) || 0 },
  bgColors:       { sql: 'bg_colors = $::text[]', value: (v) => (v as string[] | undefined) ?? [] },
  feedSync:       { sql: 'feed_sync = $::jsonb', value: (v) => (v == null ? null : JSON.stringify(v)) },
  feedExportToken: { sql: 'feed_export_token = $', value: (v) => v ?? null },
  pausedAt:       { sql: 'paused_at = $::timestamptz', value: (v) => v ?? null },
  closePendingAt: { sql: 'close_pending_at = $::timestamptz', value: (v) => v ?? null },
  closedAt:       { sql: 'closed_at = $::timestamptz', value: (v) => v ?? null },
  // Set once, by lib/store-publication.ts, and never cleared through here — see the column comment
  // in migration 20260823_203823.
  publishedAt:    { sql: 'published_at = $::timestamptz', value: (v) => v ?? null },
};

export type StoreUpdate = Partial<Omit<Store, 'id' | 'sellerId' | 'createdAt' | 'slug' | 'previousSlugs'>>;

/**
 * Write the fields this call actually carries, and only those.
 *
 * **A key that is PRESENT with the value `undefined` means "clear it"; a key that is ABSENT means
 * "don't touch it".** That distinction is not a nicety — it is what the callers already rely on:
 * `resumeStore` passes `{ pausedAt: undefined, closePendingAt: undefined }` to clear two timestamps,
 * and the store settings form passes `bannerImage: undefined` when the seller removed the image.
 * The file version got this for free from object spread; here it means building the `SET` list from
 * `Object.keys`, never from the values. Reading the record and writing it back whole would be the
 * obvious alternative and is the bug it looks like a simplification of: a save carrying only the
 * opening hours, racing a rename in another tab, would put the old name back (lib/record-rev.ts).
 */
export async function updateStore(storeId: string, updates: StoreUpdate): Promise<Store | null> {
  if (!isUuid(storeId)) return null;

  const sets: string[] = [];
  const params: unknown[] = [storeId];
  for (const key of Object.keys(updates)) {
    // `Object.hasOwn`, not a truthy lookup: `UPDATABLE['toString']` resolves to the inherited
    // Function.prototype method, which is truthy and has no `.sql` — a crash the moment a call
    // site passes a parsed request body instead of a literal.
    if (!Object.hasOwn(UPDATABLE, key)) continue;
    const spec = UPDATABLE[key]!;
    params.push(spec.value((updates as Record<string, unknown>)[key]));
    sets.push(spec.sql.replace('$', `$${params.length}`));
  }

  // customDomain is four columns, so it cannot sit in the table above — and it is all-or-nothing:
  // clearing it must clear the status too, or a hostname-less 'active' row would be left behind.
  // Written WHOLE, which is why every caller that changes one field spreads the existing record
  // (`{ ...store.customDomain, status }`) — an object rebuilt from parts would silently drop
  // `checkedAt` and hand the re-check job a domain that looks like it has never been verified.
  if ('customDomain' in updates) {
    const cd = updates.customDomain;
    params.push(cd?.hostname ?? null, cd?.status ?? null, cd?.addedAt ?? null, cd?.checkedAt ?? null);
    sets.push(`custom_domain_hostname = $${params.length - 3}`);
    sets.push(`custom_domain_status = $${params.length - 2}`);
    sets.push(`custom_domain_added_at = $${params.length - 1}::timestamptz`);
    sets.push(`custom_domain_checked_at = $${params.length}::timestamptz`);
  }

  if (!sets.length) return getStoreById(storeId);

  const { rows: updated } = await query<{ id: string }>(
    `UPDATE stores SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    params,
  );
  return updated.length ? await getStoreById(storeId) : null;
}

/**
 * Prepends a background colour to the store's saved palette (deduped, newest-first, capped),
 * returning the resulting list — the caller must have already validated the hex + ownership.
 *
 * Read-modify-write inside a transaction with the row locked, rather than as two statements: the
 * dedupe is case-insensitive and the cap counts positions, neither of which an array operator
 * expresses without becoming unreadable. `FOR UPDATE` is what makes it safe anyway — two tabs
 * saving a colour at once serialise instead of one overwriting the other's list.
 */
export async function addStoreBgColor(storeId: string, hex: string): Promise<string[] | null> {
  if (!isUuid(storeId)) return null;
  return withTransaction(async (tx) => {
    const { rows: found } = await tx.query<{ bg_colors: string[] | null }>(
      'SELECT bg_colors FROM stores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [storeId],
    );
    if (!found[0]) return null;
    const current = found[0].bg_colors ?? [];
    const next = [hex, ...current.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, MAX_STORE_BG_COLORS);
    await tx.query('UPDATE stores SET bg_colors = $2::text[] WHERE id = $1', [storeId, next]);
    return next;
  });
}
