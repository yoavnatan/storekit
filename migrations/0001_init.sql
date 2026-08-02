-- 0001_init — the whole schema, indexes and constraints included.
--
-- DB_MIGRATION_PLAN.md §4/§5/§6/§7 is the reasoning; this file is the decision. Read them
-- together. Three rules govern everything below and each one exists because of a measured
-- failure, not a preference:
--
--  1. EVERY optional boolean is `NOT NULL DEFAULT false` (§7.12). In JS a missing flag is falsy,
--     so `!hidden` shows the product; in SQL `WHERE hidden = false` does NOT match a NULL row and
--     the product silently disappears from the storefront with no error and no failing test. This
--     is the single most likely way this migration ends up quietly wrong, and it is prevented
--     here — in the column definition — not in application code.
--  2. Money is INTEGER AGOROT (§7.7). No column holds a fractional currency amount anywhere.
--     `numeric`/`float` money is how a shekel goes missing and is only noticed by a complaint.
--  3. Indexes ship with the table (§6). Adding one to a loaded production table locks it; adding
--     one to an empty table is free. There is exactly one moment to get this right and it is now.
--
-- Ordering note (§7.13): Postgres has no natural row order. Every list query in application code
-- must break ties on a stable column (`created_at DESC, id`) — the indexes below are built to
-- support exactly that, so a store's grid stops reshuffling itself between page loads.

-- citext: case-insensitive text. Without it `Acme` and `acme` are two different stores and one
--   email registers two accounts (§7.11).
-- pg_trgm: substring indexing. The admin money-log searches free text inside a date window (§4);
--   without a trigram index that is a sequential scan over a table that only ever grows.
-- vector: pgvector, for the semantic search in CONTEXTUAL_SEARCH_STRATEGY.md. Created now, used
--   later — deliberately, because a provider that cannot run this line is the wrong provider and
--   that must fail on day one, not after a year of data has accumulated on it.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================================================
-- ACCOUNTS
-- ============================================================================

-- One row per person with a login. A buyer account and a seller account are the same record —
-- the table is named `sellers` to match `lib/seller-auth.ts`, whose exported signatures do not
-- change in this migration (§3). Owning a store is what makes an account a seller.
CREATE TABLE sellers (
  id             uuid PRIMARY KEY,
  name           text NOT NULL DEFAULT '',
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL DEFAULT '',   -- empty for OAuth-only accounts
  google_id      text UNIQUE,
  tier           text,                        -- SellerTierId; NULL = default tier (lib/pricing.ts)
  created_at     timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- STORES
-- ============================================================================

CREATE TABLE stores (
  id               uuid PRIMARY KEY,
  seller_id        uuid NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
  slug             citext NOT NULL UNIQUE,
  name             text NOT NULL,
  tagline          text NOT NULL DEFAULT '',
  description      text NOT NULL DEFAULT '',
  colors           jsonb NOT NULL DEFAULT '{}'::jsonb,
  categories       text[] NOT NULL DEFAULT '{}',
  shipping         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { selfPickup? } — platform sets prices
  banner_image     text,
  profile_image    text,
  -- Store-wide sale: announcement + optional percent + scope. Stays JSONB because it holds no
  -- money (a percent and category/product id lists), is read whole and never filtered on.
  sale             jsonb,
  address          text,
  address_visible  boolean NOT NULL DEFAULT false,
  hours            jsonb,
  hours_visible    boolean NOT NULL DEFAULT false,
  blocked          boolean NOT NULL DEFAULT false,
  demo             boolean NOT NULL DEFAULT false,
  promo_weight     integer NOT NULL DEFAULT 0,
  bg_colors        text[] NOT NULL DEFAULT '{}',
  feed_sync        jsonb,
  feed_export_token text UNIQUE,
  -- customDomain is split OUT of JSONB into columns: `hostname` is the hottest lookup in the
  -- application (middleware runs it on EVERY request, including ones that are not a store at
  -- all), and a JSONB field cannot be indexed for that as well as a plain unique column (§4).
  custom_domain_hostname citext UNIQUE,
  custom_domain_status   text CHECK (custom_domain_status IN ('pending', 'active')),
  custom_domain_added_at timestamptz,
  -- Seller-owned lifecycle (lib/store-lifecycle.ts). All nullable timestamps; none of them
  -- deletes anything, because the history happened.
  paused_at        timestamptz,
  close_pending_at timestamptz,
  closed_at        timestamptz,
  -- §7.9: a store with orders is never deleted, it is marked. Orders are financial records.
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stores_seller_idx ON stores (seller_id);
-- The discovery surfaces list live stores newest-first; the partial predicate keeps blocked and
-- deleted rows out of the index entirely rather than filtering them after the fact.
CREATE INDEX stores_live_idx ON stores (created_at DESC, id) WHERE NOT blocked AND deleted_at IS NULL;

-- previousSlugs leaves the array for its own table (§4): resolving a 301 becomes an ordinary
-- indexed lookup instead of a GIN scan over an array, and `isSlugTaken` becomes one query
-- against two tables.
CREATE TABLE store_previous_slugs (
  slug        citext PRIMARY KEY,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_previous_slugs_store_idx ON store_previous_slugs (store_id);


-- ============================================================================
-- CATALOG
-- ============================================================================

CREATE TABLE store_categories (
  id         uuid PRIMARY KEY,
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES store_categories(id) ON DELETE CASCADE,
  name       text NOT NULL,
  position   integer NOT NULL DEFAULT 0,   -- `order` in the JSON; ORDER is a reserved word
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_categories_tree_idx ON store_categories (store_id, parent_id, position);

CREATE TABLE store_products (
  id           uuid PRIMARY KEY,
  store_id     uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  slug         citext NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  price_agorot bigint NOT NULL CHECK (price_agorot >= 0),
  stock        integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sku          text,
  category_id  uuid REFERENCES store_categories(id) ON DELETE SET NULL,
  hidden       boolean NOT NULL DEFAULT false,
  blocked      boolean NOT NULL DEFAULT false,
  tags         text[] NOT NULL DEFAULT '{}',
  -- specs is a display-only label/value list and variants is the dimension DEFINITION; neither is
  -- ever filtered on, so normalising them would buy nothing and cost a join per product page.
  specs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  variants     jsonb NOT NULL DEFAULT '[]'::jsonb,
  seller_note  text,
  -- Discount broken out of its JSON object so the ₪ variant is integer agorot like every other
  -- amount (rule 2). `type` says which of the two value columns is meaningful.
  discount_type          text CHECK (discount_type IN ('percent', 'amount')),
  discount_percent       integer CHECK (discount_percent BETWEEN 1 AND 95),
  discount_amount_agorot bigint CHECK (discount_amount_agorot > 0),
  discount_show_badge    boolean NOT NULL DEFAULT true,
  discount_starts_at     date,
  discount_ends_at       date,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- §7.1, measured: 47 product slugs repeat ACROSS stores and none repeats within one. A global
  -- UNIQUE(slug) fails on the first import run.
  CONSTRAINT store_products_slug_unique UNIQUE (store_id, slug)
);

-- §7.2: only 2 of 924 products carry a SKU, so the uniqueness must be partial — otherwise the
-- NULLs are the constraint's whole workload and some engines treat them as colliding.
CREATE UNIQUE INDEX store_products_sku_unique ON store_products (store_id, sku) WHERE sku IS NOT NULL;
-- The storefront grid: every product page, every store page, every search. Partial on the
-- visibility predicate (`isProductVisible` = NOT blocked AND NOT hidden), ordered the way the
-- listing orders, so the index answers the query without a sort.
CREATE INDEX store_products_visible_idx ON store_products (store_id, created_at DESC, id)
  WHERE NOT hidden AND NOT blocked;
CREATE INDEX store_products_category_idx ON store_products (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX store_products_name_trgm_idx ON store_products USING gin (name gin_trgm_ops);

-- Images move out of the array so position is explicit and a Cloudinary public_id can sit beside
-- the URL (§7.10) — without it an orphaned image cannot be deleted from Cloudinary later.
CREATE TABLE product_images (
  product_id           uuid NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  position             integer NOT NULL,
  url                  text NOT NULL,
  cloudinary_public_id text,
  PRIMARY KEY (product_id, position)
);

-- §7.5 — the table that kills `lib/mutex.ts`. Stock lives here per purchasable combination, and
-- `UPDATE ... SET stock = stock - $qty WHERE ... AND stock >= $qty` is atomic on any number of
-- servers: the affected-row count IS the answer, 0 means reject. The per-combo SKU shares the
-- row because it shares the key (variant-combo.ts#comboKey).
CREATE TABLE product_variant_stock (
  product_id uuid NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  combo_key  text NOT NULL,
  stock      integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sku        text,
  PRIMARY KEY (product_id, combo_key)
);

-- Keyed by a raw option VALUE ("אדום"), not a comboKey — a colour implies the photo whatever the
-- size is. Different key space, so a different table.
CREATE TABLE product_variant_images (
  product_id   uuid NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  option_value text NOT NULL,
  url          text NOT NULL,
  PRIMARY KEY (product_id, option_value)
);


-- ============================================================================
-- MONEY
-- ============================================================================

CREATE TABLE orders (
  id               uuid PRIMARY KEY,
  checkout_ref     text,                    -- ties the per-store orders of one checkout together
  buyer_id         uuid REFERENCES sellers(id) ON DELETE SET NULL,  -- NULL for a guest checkout
  buyer_name       text NOT NULL,
  buyer_email      citext NOT NULL,
  buyer_phone      text NOT NULL DEFAULT '',
  buyer_city       text NOT NULL DEFAULT '',
  buyer_street     text NOT NULL DEFAULT '',
  buyer_zip        text,
  shipping_agorot  bigint NOT NULL DEFAULT 0 CHECK (shipping_agorot >= 0),
  total_agorot     bigint NOT NULL CHECK (total_agorot >= 0),
  -- §7.6: a payment webhook that fires twice (and it does) must fail on this constraint instead
  -- of creating a second order. This is the foundation of /api/payment/confirm (CURRENT_TASK #2).
  payment_ref      text UNIQUE,
  payment_status   text NOT NULL CHECK (payment_status IN ('pending', 'paid', 'failed')),
  shipping_status  text NOT NULL CHECK (shipping_status IN ('pending', 'processing', 'ready', 'shipped', 'delivered', 'cancelled')),
  tracking_number  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- A status CHECK is deliberate: a new status must arrive as a migration, so it cannot be written
-- by one deploy and misread by another. See AI_INSTRUCTIONS → "new state → sweep every consumer".

CREATE INDEX orders_recent_idx ON orders (created_at DESC, id);
CREATE INDEX orders_buyer_email_idx ON orders (buyer_email, created_at DESC);
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC) WHERE buyer_id IS NOT NULL;
CREATE INDEX orders_checkout_ref_idx ON orders (checkout_ref) WHERE checkout_ref IS NOT NULL;

-- §4, and it is a rule not an oversight: order_items holds a SNAPSHOT and has NO foreign key to
-- store_products. Pointing a line at the live product would let a price edit rewrite financial
-- history. `product_id` is a plain reference for reporting, deliberately unenforced so deleting a
-- product cannot delete or block the record of it having been sold.
CREATE TABLE order_items (
  id                uuid PRIMARY KEY,
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_id        uuid,
  product_name      text NOT NULL,
  product_slug      text NOT NULL DEFAULT '',
  store_slug        text NOT NULL,
  store_name        text NOT NULL DEFAULT '',
  price_agorot      bigint NOT NULL CHECK (price_agorot >= 0),
  qty               integer NOT NULL CHECK (qty > 0),
  image             text,
  selected_variants jsonb
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id) WHERE product_id IS NOT NULL;

-- One row per store inside an order — what the seller dashboard reads, and where the per-store
-- subtotal, shipping, delivery method and private seller notes live.
CREATE TABLE order_stores (
  order_id               uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  store_slug             text NOT NULL,
  store_name             text NOT NULL DEFAULT '',
  subtotal_agorot        bigint NOT NULL DEFAULT 0 CHECK (subtotal_agorot >= 0),
  shipping_agorot        bigint NOT NULL DEFAULT 0 CHECK (shipping_agorot >= 0),
  delivery_method        text,
  discount_type          text CHECK (discount_type IN ('percent', 'amount')),
  discount_percent       integer,
  discount_amount_agorot bigint,
  discount_applied_agorot bigint NOT NULL DEFAULT 0,
  -- A LIST of private notes per store, so one seller never sees another's notes on a shared order.
  seller_notes           text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (order_id, store_slug)
);
-- The seller dashboard's own query: "my store's orders, newest first". The store_slug lead column
-- is what makes it an index scan instead of a scan of every order ever placed.
CREATE INDEX order_stores_store_idx ON order_stores (store_slug);

-- Append-only journal (lib/money-events.ts). Corrections are new rows, never edits.
-- ENFORCE THIS AT THE ROLE LEVEL IN PRODUCTION, not only in code:
--   REVOKE UPDATE, DELETE ON money_events FROM <app_role>;
-- A ledger that can be rewritten proves nothing. (Left out of the migration itself because the
-- role name is environment-specific — it is a GO_LIVE step, not a schema fact.)
CREATE TABLE money_events (
  id            uuid PRIMARY KEY,
  at            timestamptz NOT NULL,
  type          text NOT NULL,
  -- text, not uuid, and unenforced by design: an attempt can fail before any order row exists,
  -- and the journal also carries synthetic ids from seeded/legacy rows (232 of 233 measured rows
  -- read `order-1`, §7.3). A uuid column would fail the import on the first one of those.
  order_id      text,
  checkout_ref  text,
  store_slug    text,
  amount_agorot bigint,
  from_value    text,
  to_value      text,
  actor         text NOT NULL DEFAULT 'system',
  detail        text
);
CREATE INDEX money_events_at_idx ON money_events (at DESC, id);
CREATE INDEX money_events_order_idx ON money_events (order_id, at) WHERE order_id IS NOT NULL;
-- The admin journal searches free text within a date window. Without these the search degrades to
-- a sequential scan over a table nothing is ever deleted from.
CREATE INDEX money_events_detail_trgm_idx ON money_events USING gin (detail gin_trgm_ops);
CREATE INDEX money_events_store_trgm_idx ON money_events USING gin (store_slug gin_trgm_ops);

-- §4, and the gate on running more than one instance. Today `checkout-idempotency.ts` relies on an
-- in-process Mutex: two instances = two mutexes = two charges for one purchase. The primary key
-- plus `INSERT ... ON CONFLICT DO NOTHING` makes the second request receive zero rows and replay
-- the first result instead of charging.
CREATE TABLE checkout_idempotency (
  key          text PRIMARY KEY,
  status       text NOT NULL CHECK (status IN ('pending', 'complete')),
  owner        text,           -- sha256 of the buyer email — a record replays only to its buyer
  checkout_ref text,
  order_ids    text[] NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkout_idempotency_at_idx ON checkout_idempotency (at);


-- ============================================================================
-- MESSAGING & NOTIFICATIONS
-- ============================================================================

CREATE TABLE messages (
  id             uuid PRIMARY KEY,
  from_user_id   text NOT NULL,          -- a guest id is not an account id, so no FK
  from_name      text NOT NULL DEFAULT '',
  from_email     citext NOT NULL DEFAULT '',
  to_store_id    uuid REFERENCES stores(id) ON DELETE CASCADE,
  to_seller_id   uuid REFERENCES sellers(id) ON DELETE CASCADE,
  to_store_name  text NOT NULL DEFAULT '',
  subject        text NOT NULL DEFAULT '',
  content        text NOT NULL DEFAULT '',
  product_ref    jsonb,
  reply_to_id    uuid,
  read_by_seller boolean NOT NULL DEFAULT false,
  read_by_buyer  boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_seller_unread_idx ON messages (to_seller_id, read_by_seller, created_at DESC);
CREATE INDEX messages_thread_idx ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX messages_buyer_idx ON messages (from_user_id, created_at DESC);

CREATE TABLE admin_messages (
  id             uuid PRIMARY KEY,
  seller_id      uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  from_role      text NOT NULL CHECK (from_role IN ('admin', 'seller')),
  subject        text,                    -- root message only
  content        text NOT NULL DEFAULT '',
  reply_to_id    uuid,
  read_by_admin  boolean NOT NULL DEFAULT false,
  read_by_seller boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_messages_seller_idx ON admin_messages (seller_id, created_at);
CREATE INDEX admin_messages_thread_idx ON admin_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;

CREATE TABLE notifications (
  id         uuid PRIMARY KEY,
  user_id    text NOT NULL,
  role       text NOT NULL CHECK (role IN ('buyer', 'seller')),
  type       text NOT NULL,
  title      text NOT NULL DEFAULT '',
  body       text NOT NULL DEFAULT '',
  read       boolean NOT NULL DEFAULT false,
  related_id text,
  store_slug text,
  store_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The header renders an unread badge on every page a logged-in user loads. This index is what
-- turns that from a scan into a lookup (AI_INSTRUCTIONS → Scalability).
CREATE INDEX notifications_user_idx ON notifications (user_id, role, read, created_at DESC);


-- ============================================================================
-- ADVERTISING
-- ============================================================================

CREATE TABLE ad_campaigns (
  id                     uuid PRIMARY KEY,
  store_id               uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  store_slug             text NOT NULL,
  scope                  text NOT NULL,
  -- Snapshots of what the campaign advertises, deliberately unenforced text: a campaign is a
  -- financial record that must survive the product or category it named being deleted.
  product_id             text,
  product_name           text,
  product_ids            text[] NOT NULL DEFAULT '{}',
  product_names          text[] NOT NULL DEFAULT '{}',
  category_ids           text[] NOT NULL DEFAULT '{}',
  category_names         text[] NOT NULL DEFAULT '{}',
  platform               text NOT NULL CHECK (platform IN ('google', 'meta', 'both')),
  monthly_budget_agorot  bigint NOT NULL CHECK (monthly_budget_agorot >= 0),
  duration_days          integer CHECK (duration_days IN (7, 14, 30)),
  audience_gender        text,
  audience_age           text,
  status                 text NOT NULL CHECK (status IN ('active', 'paused')),
  paused_at              timestamptz,
  paused_reason          text CHECK (paused_reason IN ('unavailable', 'out-of-stock')),
  -- A cancelled campaign is closed, never deleted: the money it spent is a fact, and every
  -- reported ad figure is derived from this table.
  archived_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_campaigns_store_idx ON ad_campaigns (store_id, created_at DESC);
CREATE INDEX ad_campaigns_live_idx ON ad_campaigns (status) WHERE archived_at IS NULL;

CREATE TABLE brand_campaigns (
  id                    uuid PRIMARY KEY,
  objective             text NOT NULL CHECK (objective IN ('buyers', 'sellers')),
  headline              text NOT NULL DEFAULT '',
  body                  text NOT NULL DEFAULT '',
  image_url             text,
  destination_url       text NOT NULL DEFAULT '',
  platform              text NOT NULL CHECK (platform IN ('google', 'meta')),
  monthly_budget_agorot bigint NOT NULL CHECK (monthly_budget_agorot >= 0),
  duration_days         integer CHECK (duration_days IN (7, 14, 30)),
  status                text NOT NULL CHECK (status IN ('active', 'paused')),
  paused_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_campaigns_status_idx ON brand_campaigns (status, created_at DESC);


-- ============================================================================
-- ANALYTICS — the buckets (§5)
-- ============================================================================
--
-- Every one of these replaces a JSON object that held an unbounded ARRAY of visitor ids, read and
-- rewritten in full on every page load. Measured: one busy day already held 359 ids. At 10,000
-- visitors a day that is a 10,000-element array rewritten on every request. Here a view is one
-- INSERT of one row and a counter bump, and "unique visitors" is COUNT(*) — nothing is ever read
-- back in order to write.
--
-- `day` is a DATE in Asia/Jerusalem (§7.8), written by the application. The server runs in UTC, so
-- deriving the day here would move every day boundary by three hours and quietly reshape every
-- report.

CREATE TABLE store_page_views (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  day      date NOT NULL,
  total    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, day)
);
CREATE TABLE store_page_view_visitors (
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  day        date NOT NULL,
  visitor_id text NOT NULL,
  PRIMARY KEY (store_id, day, visitor_id)
);

CREATE TABLE product_page_views (
  product_id uuid NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  day        date NOT NULL,
  total      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, day)
);
CREATE TABLE product_page_view_visitors (
  product_id uuid NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  day        date NOT NULL,
  visitor_id text NOT NULL,
  PRIMARY KEY (product_id, day, visitor_id)
);

-- The platform funnel (lib/analytics.ts): raw volume, distinct sessions, and per-product tallies
-- for the product-scoped events.
CREATE TABLE analytics_daily (
  day   date NOT NULL,
  event text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
);
CREATE TABLE analytics_visitors (
  day        date NOT NULL,
  event      text NOT NULL,
  visitor_id text NOT NULL,
  PRIMARY KEY (day, event, visitor_id)
);
-- product_id is text and unenforced on purpose: this is a historical tally, and a product that
-- has since been deleted still viewed as many times as it did. A uuid column with a foreign key
-- would delete the past every time a seller tidies their catalogue — and would have dropped 25
-- rows of the existing data on import, whose ids predate uuids entirely (§7.3).
CREATE TABLE analytics_products (
  day        date NOT NULL,
  event      text NOT NULL,
  product_id text NOT NULL,
  count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, product_id)
);
CREATE INDEX analytics_products_top_idx ON analytics_products (event, day, count DESC);


-- ============================================================================
-- BUYER STATE — cart, wishlist, favourites (§5)
-- ============================================================================
--
-- A cart stored as one nested object per user rewrites the entire cart on every quantity change.
-- One row per line means a quantity change is one UPDATE of one row.

CREATE TABLE cart_items (
  user_id       text NOT NULL,
  store_slug    text NOT NULL,
  cart_key      text NOT NULL,     -- slug, or slug__variant-combo (cart.ts#makeCartKey)
  store_name    text NOT NULL DEFAULT '',
  product_slug  text NOT NULL,
  product_name  text NOT NULL DEFAULT '',
  price_agorot  bigint NOT NULL DEFAULT 0,
  base_price_agorot bigint,
  image         text,
  qty           integer NOT NULL CHECK (qty > 0),
  selected_variants jsonb,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, store_slug, cart_key)
);
CREATE INDEX cart_items_user_idx ON cart_items (user_id);

-- The wishlist count on a card is COUNT(*) here, not a stored counter (§5): a stored counter
-- always drifts from the truth eventually. It also fixes a real defect the JSON version has —
-- `wishlist-counts.json` is keyed by bare product SLUG, and §7.1 measured 47 slugs shared across
-- different stores, so two unrelated products have been sharing one count. A product_id key
-- cannot do that.
CREATE TABLE wishlist_items (
  user_id    text NOT NULL,
  product_id uuid NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX wishlist_items_product_idx ON wishlist_items (product_id);

CREATE TABLE favorite_stores (
  user_id  text NOT NULL,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, store_id)
);
CREATE INDEX favorite_stores_store_idx ON favorite_stores (store_id);

CREATE TABLE recent_stores (
  user_id    text NOT NULL,
  store_slug text NOT NULL,
  position   integer NOT NULL,     -- 0 = most recently visited
  PRIMARY KEY (user_id, store_slug)
);


-- ============================================================================
-- OPERATIONS
-- ============================================================================

CREATE TABLE error_log (
  id              uuid PRIMARY KEY,
  source          text NOT NULL CHECK (source IN ('server', 'client')),
  route           text,
  message         text NOT NULL DEFAULT '',
  stack           text,
  status_code     integer,
  store_slug      text,
  store_name      text,
  actor_role      text CHECK (actor_role IN ('buyer', 'seller')),
  actor_id        text,
  actor_label     text,
  resolution_hint text,
  resolved        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX error_log_recent_idx ON error_log (created_at DESC, id);
CREATE INDEX error_log_open_idx ON error_log (created_at DESC) WHERE NOT resolved;

-- Small singleton settings that were a whole JSON file each (platform-ads, admin-tab-views).
-- A table per two-field object buys nothing; a keyed store keeps them together and additive.
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
