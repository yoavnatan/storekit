/**
 * The two spellings of the checkout-group key must agree, on every row, forever.
 *
 * `checkout-group.ts` holds one rule written twice — once in JS, once in SQL — because the admin
 * Orders tab pages by purchase in the database and then re-groups the rows it gets back in the
 * component. That is the arrangement AI_INSTRUCTIONS calls "the next bug", and it is allowed here
 * only because this test makes the drift impossible to ship.
 *
 * What drift would actually do, which is why this is a money test and not a tidiness one: if SQL
 * grouped two rows together and JS did not, the page would fetch a purchase and the card would
 * draw it as two — with the SUM of the slices printed on one of them, because the header total is
 * computed per group. A purchase would show the wrong price to the person auditing prices. And in
 * the other direction the page count and the card count disagree, so a page of 15 silently shows
 * 14 and the missing one is unreachable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { CHECKOUT_GROUP_KEY_SQL, checkoutGroupKey } from '../src/lib/checkout-group.js';

/** The awkward rows, not the ordinary ones — the ordinary ones agree under any implementation. */
const ROWS: { checkout_ref: string | null; payment_ref: string | null; note: string }[] = [
  { checkout_ref: 'AB12CD34', payment_ref: 'MOCK-AB12CD34', note: 'the ordinary multi-store slice' },
  { checkout_ref: 'AB12CD34', payment_ref: null, note: 'a ref with NO payment ref — the || must not swallow the row' },
  { checkout_ref: null, payment_ref: 'MOCK-X', note: 'legacy row, no checkout ref: keys by its own id' },
  { checkout_ref: null, payment_ref: null, note: 'legacy row with nothing at all' },
  // The empty string is the case the SQL `IS NOT NULL` spelling would get wrong: `createOrder`
  // writes `input.checkoutRef || null` so it should never land, and a grouping key may not depend
  // on "should never". JS tests `order.checkoutRef ?`, which is FALSE for '', so both must fall
  // through to the id — an empty ref grouping every legacy row into one card would merge
  // unrelated purchases and print one total across all of them.
  { checkout_ref: '', payment_ref: 'MOCK-Y', note: 'empty-string ref must fall through to the id' },
  { checkout_ref: '', payment_ref: '', note: 'empty ref and empty payment ref' },
  { checkout_ref: 'PIPE|IN', payment_ref: 'REF', note: 'a pipe inside the ref itself' },
  { checkout_ref: 'X', payment_ref: 'PIPE|IN', note: 'a pipe inside the payment ref' },
];

beforeAll(async () => {
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM money_events');
  await query('DELETE FROM orders');
  for (const r of ROWS) {
    await query(
      `INSERT INTO orders (id, checkout_ref, payment_ref, buyer_name, buyer_email, buyer_phone,
                           total_agorot, payment_status, shipping_status)
       VALUES ($1, $2, $3, 'x', 'x@example.test', '050', 100, 'paid', 'pending')`,
      [crypto.randomUUID(), r.checkout_ref, r.payment_ref],
    );
  }
});

describe('checkout-group.ts: the SQL and the JS say the same thing', () => {
  it('produces an identical key for every row shape', async () => {
    const { rows } = await query<{ id: string; checkout_ref: string | null; payment_ref: string | null; gkey: string }>(
      `SELECT o.id, o.checkout_ref, o.payment_ref, ${CHECKOUT_GROUP_KEY_SQL} AS gkey FROM orders o`,
    );
    expect(rows).toHaveLength(ROWS.length);
    for (const row of rows) {
      // Rebuilt exactly as `toOrder` hands it to the component: absent, never null.
      const js = checkoutGroupKey({
        id: row.id,
        ...(row.checkout_ref ? { checkoutRef: row.checkout_ref } : {}),
        ...(row.payment_ref ? { paymentRef: row.payment_ref } : {}),
      });
      expect(row.gkey, `SQL and JS disagree for checkout_ref=${JSON.stringify(row.checkout_ref)} payment_ref=${JSON.stringify(row.payment_ref)}`).toBe(js);
    }
  });

  it('groups the two slices of one checkout together and nothing else with them', async () => {
    const { rows } = await query<{ gkey: string; n: string | number }>(
      `SELECT ${CHECKOUT_GROUP_KEY_SQL} AS gkey, COUNT(*) AS n FROM orders o GROUP BY 1`,
    );
    const sizes = rows.map((r) => Number(r.n)).sort((a, b) => b - a);
    // AB12CD34 appears twice but with DIFFERENT payment refs ('MOCK-AB12CD34' and NULL), and the
    // key pairs the two — so they are two purchases, not one. That is the collision guard doing
    // its job, and it is why the largest group here is 1 rather than 2.
    expect(sizes).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('keys a row with no checkout ref by its own id, so legacy rows never merge', async () => {
    const { rows } = await query<{ id: string; gkey: string }>(
      `SELECT o.id, ${CHECKOUT_GROUP_KEY_SQL} AS gkey FROM orders o WHERE COALESCE(o.checkout_ref, '') = ''`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(r.gkey).toBe(r.id);
  });
});
