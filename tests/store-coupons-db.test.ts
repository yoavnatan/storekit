/**
 * Coupon storage against a real Postgres, and one thing in particular: **a capped code means its
 * cap under concurrency.**
 *
 * "First 50 customers" is the most common shape a coupon takes and the easiest one to get wrong.
 * Read the count, check it, write it back, and fifty becomes sixty under exactly the traffic a
 * good promotion produces — every one of those extra redemptions is money the seller did not agree
 * to give away, and none of it is recoverable afterwards. So `claimCoupon` is one conditional
 * UPDATE whose affected-row count IS the answer, the same shape `decrementStock` uses, and the
 * test that matters here is the racing one — the rest of the file is the ordinary CRUD around it.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import {
  createCoupon, updateCoupon, deleteCoupon, getCouponByCode, getCouponsByStore,
  claimCoupon, releaseCoupon, storesWithLiveCoupons, type CouponWrite,
} from '../src/lib/store-coupons.js';

let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `coupon-test-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

function write(extra: Partial<CouponWrite> = {}): CouponWrite {
  return { code: 'SAVE10', kind: 'percent', value: 10, minSubtotalAgorot: 0, active: true, ...extra };
}

describe('claimCoupon — the cap is the cap', () => {
  it('lets exactly `maxUses` claims through when 50 arrive at once', async () => {
    const storeId = await freshStore();
    const coupon = await createCoupon(storeId, write({ code: 'FIRST10', maxUses: 10 }));
    // Fired together rather than in sequence: sequential claims would pass against a read-then-write
    // implementation too, so a serial loop here would prove nothing about the thing being claimed.
    const results = await Promise.all(Array.from({ length: 50 }, () => claimCoupon(coupon!.id)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await getCouponByCode(storeId, 'FIRST10'))!.usedCount).toBe(10);
  });

  it('counts an uncapped code too — that number is what tells the seller it was worth running', async () => {
    const storeId = await freshStore();
    const coupon = await createCoupon(storeId, write({ code: 'OPEN' }));
    expect(await claimCoupon(coupon!.id)).toBe(true);
    expect(await claimCoupon(coupon!.id)).toBe(true);
    expect((await getCouponByCode(storeId, 'OPEN'))!.usedCount).toBe(2);
  });

  it('gives a use back when the purchase did not happen, and cannot mint one', async () => {
    // The coupon twin of `restockProduct`: a declined card must not burn a use of a capped code.
    // Floored at zero so a double release (two failure paths firing) cannot create redemptions.
    const storeId = await freshStore();
    const coupon = await createCoupon(storeId, write({ code: 'REL', maxUses: 1 }));
    expect(await claimCoupon(coupon!.id)).toBe(true);
    expect(await claimCoupon(coupon!.id)).toBe(false);
    await releaseCoupon(coupon!.id);
    expect(await claimCoupon(coupon!.id)).toBe(true);
    await releaseCoupon(coupon!.id);
    await releaseCoupon(coupon!.id);
    expect((await getCouponByCode(storeId, 'REL'))!.usedCount).toBe(0);
  });
});

describe('one code per store, and it is the store\'s own', () => {
  it('refuses a second row for the same code instead of shadowing the first', async () => {
    const storeId = await freshStore();
    expect(await createCoupon(storeId, write({ code: 'DUP' }))).not.toBeNull();
    // Decided by the unique index, not by a read-then-write, so two saves racing produce one row
    // and one refusal rather than two rows a lookup would then pick between arbitrarily.
    expect(await createCoupon(storeId, write({ code: 'DUP', value: 50 }))).toBeNull();
    expect((await getCouponByCode(storeId, 'DUP'))!.value).toBe(10);
  });

  it('lets two different stores run the same code', async () => {
    const a = await freshStore();
    const b = await freshStore();
    expect(await createCoupon(a, write({ code: 'SHARED' }))).not.toBeNull();
    expect(await createCoupon(b, write({ code: 'SHARED', value: 20 }))).not.toBeNull();
    expect((await getCouponByCode(a, 'SHARED'))!.value).toBe(10);
    expect((await getCouponByCode(b, 'SHARED'))!.value).toBe(20);
  });

  it('never reaches another store\'s row through an id', async () => {
    // An id is not a permission (lib/store-ownership.ts). The route checks ownership AND every
    // statement is scoped by store_id, so a foreign id fails twice — this pins the second one.
    const a = await freshStore();
    const b = await freshStore();
    const mine = await createCoupon(a, write({ code: 'MINE' }));
    expect(await updateCoupon(b, mine!.id, write({ code: 'MINE', value: 90 }))).toBeNull();
    expect(await deleteCoupon(b, mine!.id)).toBe(false);
    expect((await getCouponByCode(a, 'MINE'))!.value).toBe(10);
  });

  it('matches however the buyer typed it', async () => {
    const storeId = await freshStore();
    await createCoupon(storeId, write({ code: 'SUMMER10' }));
    expect(await getCouponByCode(storeId, 'summer 10')).not.toBeNull();
    expect(await getCouponByCode(storeId, ' Summer10 ')).not.toBeNull();
    expect(await getCouponByCode(storeId, 'SUMMER11')).toBeNull();
  });
});

describe('round-tripping what the seller typed', () => {
  it('keeps a ₪ amount as the seller\'s own number and an integer in the column', async () => {
    const storeId = await freshStore();
    await createCoupon(storeId, write({ code: 'FLAT', kind: 'amount', value: 25.5, minSubtotalAgorot: 15_000 }));
    const back = (await getCouponByCode(storeId, 'FLAT'))!;
    expect(back.value).toBe(25.5);              // what their edit form must show back
    expect(back.minSubtotalAgorot).toBe(15_000);
    const [row] = await query<{ amount_agorot: string }>(
      `SELECT amount_agorot FROM store_coupons WHERE store_id = $1 AND code = 'FLAT'`, [storeId]).then((r) => r.rows);
    expect(Number(row!.amount_agorot)).toBe(2550);
  });

  it('leaves the redemption count alone when the seller edits the code', async () => {
    // History, not a setting. Lowering a "first 50" cap after 30 redemptions must CLOSE the code,
    // never hand 20 more away.
    const storeId = await freshStore();
    const coupon = await createCoupon(storeId, write({ code: 'EDIT', maxUses: 50 }));
    await claimCoupon(coupon!.id);
    await claimCoupon(coupon!.id);
    await updateCoupon(storeId, coupon!.id, write({ code: 'EDIT', maxUses: 2 }));
    const back = (await getCouponByCode(storeId, 'EDIT'))!;
    expect(back.usedCount).toBe(2);
    expect(await claimCoupon(coupon!.id)).toBe(false);
  });

  it('lists a store\'s codes and nobody else\'s', async () => {
    const a = await freshStore();
    const b = await freshStore();
    await createCoupon(a, write({ code: 'A1' }));
    await createCoupon(b, write({ code: 'B1' }));
    expect((await getCouponsByStore(a)).map((c) => c.code)).toEqual(['A1']);
  });
});

describe('storesWithLiveCoupons — what decides whether the buyer sees a field at all', () => {
  it('names only the stores actually offering something right now', async () => {
    const live = await freshStore();
    const off = await freshStore();
    const ended = await freshStore();
    const usedUp = await freshStore();
    await createCoupon(live, write({ code: 'L' }));
    await createCoupon(off, write({ code: 'O', active: false }));
    await createCoupon(ended, write({ code: 'E', endsAt: '2020-01-01' }));
    const spent = await createCoupon(usedUp, write({ code: 'U', maxUses: 1 }));
    await claimCoupon(spent!.id);

    const found = await storesWithLiveCoupons([live, off, ended, usedUp]);
    expect(found.has(live)).toBe(true);
    expect(found.has(off)).toBe(false);
    expect(found.has(ended)).toBe(false);
    // The SQL window and `isCouponLive` have to agree on this one, or a buyer is shown a field for
    // a code the checkout will refuse.
    expect(found.has(usedUp)).toBe(false);
  });

  it('answers an id that is not a uuid as "no coupons" rather than raising', async () => {
    // Postgres THROWS on a malformed uuid instead of matching nothing, and this runs on the public
    // cart re-price — so an odd cart line would 500 the whole price refresh, not just its own row.
    expect(await storesWithLiveCoupons(['store-1', ''])).toEqual(new Set());
  });
});
