-- Coupon codes: a discount the buyer has to KNOW, as opposed to the two levers that are published.
--
-- Deliberately NOT a third lever inside `lib/discounts.ts`. That module derives the price a product
-- SHOWS, and everything downstream of it is public: the product page, the store catalog, the
-- sitemap, and — the one that actually forces the decision — the Google/Meta product feed. A price
-- fed to Merchant Center must match the landing page's, and a coupon by definition does not change
-- the landing page's price, so folding one into the resolver would put a figure in the feed that
-- the storefront never shows. Price mismatch is one of only two documented suspension classes
-- there (see 0019's header), and we run ONE Merchant Center for every seller.
--
-- So a coupon is an ORDER-level lever, and it reuses the order-level discount slot that
-- `order_stores` already has (`discount_type`/`discount_percent`/`discount_amount_agorot`/
-- `discount_applied_agorot`, until now written only by a seller editing an order afterwards).
-- That reuse is the whole point: every money surface in the app — `order-totals.ts`,
-- `admin-stats.ts#orderNetForStore`, `order-reporting.ts`'s NET, `reconcile.ts`'s bounds, the
-- seller balance and the commission basis — already subtracts that column, so a coupon is correct
-- in all of them on the day it ships instead of being a new number six places have to learn.
-- The one thing the slot could not say is WHICH code did it, which is the column below.

ALTER TABLE order_stores ADD COLUMN IF NOT EXISTS coupon_code text;

-- Money the seller gives away, so it is the seller's record and scoped to the store, never global.
CREATE TABLE IF NOT EXISTS store_coupons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- Stored already normalized (upper-case, A–Z/0–9/dash only — lib/coupons.ts#normalizeCouponCode),
  -- because the unique index below IS the case-insensitivity guarantee: `citext` would make
  -- SUMMER10 and summer10 one row but would still let `summer 10` and `SUMMER-10` be three
  -- different codes a buyer cannot tell apart on a printed flyer.
  code                text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('percent', 'amount')),
  -- Exactly one of these is set, per `kind` — the same split `order_stores` uses, and for the same
  -- reason: `percent` is what the seller typed and must round-trip into their edit form unchanged.
  percent             integer CHECK (percent IS NULL OR (percent >= 1 AND percent <= 95)),
  amount_agorot       bigint  CHECK (amount_agorot IS NULL OR amount_agorot > 0),
  -- "Only above ₪N" — the single most-used coupon condition and the only one that changes whether
  -- the code is worth running at all. 0 = no threshold.
  min_subtotal_agorot bigint NOT NULL DEFAULT 0 CHECK (min_subtotal_agorot >= 0),
  -- NULL = unlimited. `used_count` is incremented by a conditional UPDATE whose affected-row count
  -- IS the answer (lib/store-coupons.ts#claimCoupon), the same shape as `decrementStock` — no lock,
  -- correct on any number of servers, and the only way a "first 50 customers" code means 50.
  max_uses            integer CHECK (max_uses IS NULL OR max_uses > 0),
  used_count          integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  -- Date-only `YYYY-MM-DD` in local time, `ends_at` inclusive — the same schedule shape and the
  -- same `isScheduleOpen` as a product discount and a store sale, so a seller learns one rule.
  starts_at           text,
  ends_at             text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Two codes that differ only in case are ONE code to the buyer typing it off a flyer, and the
-- lookup is by (store, code) on every checkout, so this index is both the uniqueness rule and the
-- read path.
CREATE UNIQUE INDEX IF NOT EXISTS store_coupons_store_code_idx ON store_coupons (store_id, code);
