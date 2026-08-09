/**
 * Coupon storage and the one write that has a race in it.
 *
 * The pure decision lives in `coupons.ts`; this is only the database side of it, kept apart for
 * the same reason `discount-input.ts` is kept out of `discounts.ts` — so the calculation stays
 * runnable in a browser.
 *
 * **`claimCoupon` is the reason this file matters.** A "first 50 customers" code that is read,
 * checked and then written back is a code that goes to 60 under the exact concurrency a good
 * promotion produces. It is one conditional UPDATE whose affected-row count IS the answer, the
 * same shape as `store-products.ts#decrementStock` and `rate-limit.ts#countAuthAttempt`: no lock,
 * correct on any number of servers, and the limit means what it says.
 */

import { query, rows, firstRow, isUuid } from './db.js';
import { normalizeCouponCode, type StoreCoupon, type CouponKind } from './coupons.js';
import { toAgorot } from './money.js';

interface CouponRow {
  id: string;
  store_id: string;
  code: string;
  kind: CouponKind;
  percent: number | null;
  amount_agorot: string | number | null;
  min_subtotal_agorot: string | number;
  max_uses: number | null;
  used_count: number;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
}

/** `bigint` arrives from `pg` as a string. Same conversion `orders.ts` does, for the same columns. */
function big(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toCoupon(row: CouponRow): StoreCoupon {
  const c: StoreCoupon = {
    id: row.id,
    storeId: row.store_id,
    code: row.code,
    kind: row.kind,
    // `value` is the seller's own unit — percent points, or ILS off. Rebuilt from whichever column
    // `kind` owns, exactly as `orders.ts#toStoreSubtotal` rebuilds an order discount.
    value: row.kind === 'percent' ? (row.percent ?? 0) : big(row.amount_agorot) / 100,
    minSubtotalAgorot: big(row.min_subtotal_agorot),
    usedCount: row.used_count,
    active: row.active,
  };
  if (row.max_uses !== null) c.maxUses = row.max_uses;
  if (row.starts_at) c.startsAt = row.starts_at;
  if (row.ends_at) c.endsAt = row.ends_at;
  return c;
}

const COLUMNS = `id, store_id, code, kind, percent, amount_agorot, min_subtotal_agorot,
                 max_uses, used_count, starts_at, ends_at, active`;

export async function getCouponsByStore(storeId: string): Promise<StoreCoupon[]> {
  if (!storeId) return [];
  const found = await rows<CouponRow>(
    `SELECT ${COLUMNS} FROM store_coupons WHERE store_id = $1 ORDER BY created_at DESC`,
    [storeId],
  );
  return found.map(toCoupon);
}

/** The checkout path's lookup. Normalizes here too rather than trusting the caller: this is the
 *  function an attacker-supplied string reaches, and the stored form is the only one the unique
 *  index knows. */
export async function getCouponByCode(storeId: string, code: unknown): Promise<StoreCoupon | null> {
  const normalized = normalizeCouponCode(code);
  if (!storeId || !normalized) return null;
  const row = await firstRow<CouponRow>(
    `SELECT ${COLUMNS} FROM store_coupons WHERE store_id = $1 AND code = $2`,
    [storeId, normalized],
  );
  return row ? toCoupon(row) : null;
}

/**
 * Which of these stores has at least one code a buyer could use right now.
 *
 * ONE query for every store in the cart, not one per store: this is asked on the checkout page's
 * price refresh, which runs on load and on every return to the tab, so a per-store loop would be
 * a round trip per store on a path that already has a budget (Hard rules → Scalability).
 *
 * The date window is evaluated in SQL against the same `YYYY-MM-DD` strings `isScheduleOpen` uses,
 * so a text comparison is the correct one — the format sorts lexicographically. Timezone: these
 * are local dates by definition (the seller typed a day, not an instant), which is what
 * `to_char(now(), 'YYYY-MM-DD')` gives against a server in Israel — the same assumption
 * `dayKey()` makes on the client, and `business-day.ts` owns the cases where that is not enough.
 */
export async function storesWithLiveCoupons(storeIds: readonly string[]): Promise<Set<string>> {
  // `isUuid` before the query, not `::text` inside it: `stores.id` is a uuid column, so an id that
  // is not one cannot name a real store — and Postgres answers a malformed uuid with a THROWN
  // `invalid input syntax`, not with zero rows. On a public checkout path that turns a bad cart
  // line into a 500 for the whole re-price, which is the same class db.ts's `NO_SUCH_UUID` exists
  // for.
  const ids = [...new Set(storeIds.filter((id) => id && isUuid(id)))];
  if (!ids.length) return new Set();
  const found = await rows<{ store_id: string }>(
    `SELECT DISTINCT store_id FROM store_coupons
      WHERE store_id = ANY($1::uuid[])
        AND active
        AND (starts_at IS NULL OR starts_at <= to_char(now(), 'YYYY-MM-DD'))
        AND (ends_at   IS NULL OR ends_at   >= to_char(now(), 'YYYY-MM-DD'))
        AND (max_uses  IS NULL OR used_count < max_uses)`,
    [ids],
  );
  return new Set(found.map((r) => r.store_id));
}

export interface CouponWrite {
  code: string;
  kind: CouponKind;
  value: number;
  minSubtotalAgorot: number;
  maxUses?: number;
  startsAt?: string;
  endsAt?: string;
  active: boolean;
}

function writeParams(storeId: string, input: CouponWrite): unknown[] {
  return [
    storeId,
    input.code,
    input.kind,
    input.kind === 'percent' ? Math.round(input.value) : null,
    input.kind === 'amount' ? toAgorot(input.value) : null,
    Math.max(0, Math.round(input.minSubtotalAgorot)),
    input.maxUses ?? null,
    input.startsAt ?? null,
    input.endsAt ?? null,
    input.active,
  ];
}

/** Create, or `null` when the code already exists on this store — the unique index decides that,
 *  not a read-then-write, so two saves of the same code race safely into one row and one refusal. */
export async function createCoupon(storeId: string, input: CouponWrite): Promise<StoreCoupon | null> {
  const row = await firstRow<CouponRow>(
    `INSERT INTO store_coupons (store_id, code, kind, percent, amount_agorot, min_subtotal_agorot,
                                max_uses, starts_at, ends_at, active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (store_id, code) DO NOTHING
       RETURNING ${COLUMNS}`,
    writeParams(storeId, input),
  );
  return row ? toCoupon(row) : null;
}

/**
 * Update in place, scoped to the store in the WHERE clause — an id is not a permission
 * (`store-ownership.ts`), and the route's ownership check plus this scope are two independent
 * reasons a foreign id changes nothing.
 *
 * `used_count` is untouched on purpose: it is history, and lowering a "first 50" cap after 30 have
 * been redeemed must close the code, not hand 20 more away.
 */
export async function updateCoupon(storeId: string, couponId: string, input: CouponWrite): Promise<StoreCoupon | null> {
  const row = await firstRow<CouponRow>(
    `UPDATE store_coupons
        SET code = $2, kind = $3, percent = $4, amount_agorot = $5, min_subtotal_agorot = $6,
            max_uses = $7, starts_at = $8, ends_at = $9, active = $10
      WHERE store_id = $1 AND id = $11
    RETURNING ${COLUMNS}`,
    [...writeParams(storeId, input), couponId],
  );
  return row ? toCoupon(row) : null;
}

export async function deleteCoupon(storeId: string, couponId: string): Promise<boolean> {
  const res = await query(`DELETE FROM store_coupons WHERE store_id = $1 AND id = $2`, [storeId, couponId]);
  return res.rowCount > 0;
}

/**
 * Consume one use, or refuse.
 *
 * The condition and the increment are one statement, so two buyers reaching the last unit of a
 * capped code cannot both read `used_count = 49` and both write `50`. `rowCount === 0` is the
 * refusal and it is the only correct one — a separate "is there room" read would be answering
 * about a moment that has already passed.
 *
 * An UNCAPPED code still counts, because the count is what the seller's dashboard reports as
 * redemptions and what tells them the code was worth running.
 */
export async function claimCoupon(couponId: string): Promise<boolean> {
  const res = await query(
    `UPDATE store_coupons SET used_count = used_count + 1
      WHERE id = $1 AND (max_uses IS NULL OR used_count < max_uses)`,
    [couponId],
  );
  return res.rowCount > 0;
}

/** Give a claimed use back when the purchase it was claimed for did not happen — the coupon twin
 *  of `restockProduct`, and needed for the same reason: a checkout that authorizes and then fails
 *  must leave nothing consumed behind it. Floored at zero so a double release cannot mint uses. */
export async function releaseCoupon(couponId: string): Promise<void> {
  await query(
    `UPDATE store_coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1`,
    [couponId],
  );
}
