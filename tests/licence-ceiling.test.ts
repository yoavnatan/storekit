/**
 * **The one figure on this platform whose error direction is not symmetric.**
 *
 * Everything else here is checked because a wrong number misleads somebody. This one is checked
 * because understating it means operating an unlicensed payment service without knowing: the tile
 * says there is headroom, so nobody applies, and the exemption has already lapsed by the time
 * anyone looks. So each case below is a way of accidentally reporting LESS than really moved.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { query } from '../src/lib/db.js';
import {
  getLicenceCeiling,
  LICENCE_CEILING_AGOROT,
  CEILING_WATCH_PERCENT,
  CEILING_ACT_PERCENT,
} from '../src/lib/licence-ceiling.js';

const TODAY = '2026-08-16';

/** One charged order. `shippingAgorot` is carried inside `total_agorot`, as checkout writes it. */
async function seedCharged(opts: {
  totalAgorot: number;
  paidDaysAgo: number;
  shippingStatus?: string;
  paymentStatus?: string;
  /** Charged, but the capture never stamped the column — a real shape, see the test that uses it. */
  paidAtNull?: boolean;
}): Promise<void> {
  const id = crypto.randomUUID();
  // Dated from TODAY rather than `now()`, so a run at 23:50 Israel time cannot shift an order into
  // the neighbouring month and make the month-count assertions flap. 09:00Z is mid-morning locally
  // whatever the DST offset, which is the same noon-ish guard `payout-run.ts#weekdayOf` uses.
  const paidAt = new Date(Date.parse(`${TODAY}T09:00:00Z`) - opts.paidDaysAgo * 86_400_000).toISOString();
  await query(
    `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status,
                         paid_at, created_at)
     VALUES ($1, 'B', 'b@example.com', $2, $3, $4, $6::timestamptz, $5::timestamptz)`,
    [id, opts.totalAgorot, opts.paymentStatus ?? 'paid', opts.shippingStatus ?? 'delivered', paidAt,
      opts.paidAtNull ? null : paidAt],
  );
}

beforeEach(async () => {
  // Children first: `order_items` holds the order down with a RESTRICT foreign key, deliberately —
  // an order is not something the platform is allowed to make disappear out from under its lines.
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM orders');
  await query('DELETE FROM seller_payouts');
});

/**
 * The exemption is not only a threshold — it is conditional on SAYING so. The regulations oblige an
 * exempt body to disclose, on its site and in its marketing, that it is exempt from licensing and
 * therefore unsupervised. A disclosure that quietly stops rendering does not fail any screen, any
 * type-check or any other test: the site simply looks tidier, and the condition the platform relies
 * on is no longer met. So it is pinned here, beside the number it belongs to.
 */
describe('the disclosure the exemption is conditional on', () => {
  const footer = readFileSync('src/components/Footer.astro', 'utf8');
  const dict = readFileSync('src/i18n/translations.ts', 'utf8');

  it('the footer renders it, on every page', () => {
    expect(footer).toContain('t.footer.licenceExemption');
  });

  it.each([
    ['the regulator', 'רשות ניירות ערך'],
    ['the law it is exempt from', 'שירותי תשלום'],
    ['that it is not supervised', 'אינה מפוקחת'],
  ])('the Hebrew wording names %s', (_what, phrase) => {
    expect(dict).toContain(phrase);
  });

  /** Naming the platform through `{name}` rather than typing it: a rename must not leave a legal
   *  clause attributing the statement to a business that no longer exists under that name. */
  it('names the platform by interpolation, not by literal', () => {
    expect(dict).toContain('licenceExemption');
    expect(footer).toContain("replace('{name}', store.name)");
  });
});

describe('funds received are measured as money, not as revenue', () => {
  /**
   * The defect this exists to prevent, and the reason `FUNDS_RECEIVED_PAYMENT_STATUSES` has no
   * shipping half: every other money query on the platform ANDs in the revenue shipping statuses,
   * which drop `cancelled`. A cancelled paid order is money that arrived and then had to be sent
   * back — two movements, both real, and the regulator counts the first.
   */
  it('counts an order that was charged and later cancelled', async () => {
    await seedCharged({ totalAgorot: 400_00, paidDaysAgo: 10, shippingStatus: 'cancelled' });
    const c = await getLicenceCeiling(TODAY);
    expect(c.received.totalAgorot).toBe(400_00);
  });

  /** Shipping was charged to the buyer's card too. Summing the goods subtotal instead — the figure
   *  every seller-facing report uses — silently drops it from a compliance measurement. */
  it('counts the whole charge, shipping included', async () => {
    await seedCharged({ totalAgorot: 130_00, paidDaysAgo: 5 }); // 100₪ goods + 30₪ shipping
    const c = await getLicenceCeiling(TODAY);
    expect(c.received.totalAgorot).toBe(130_00);
  });

  /** Nothing was taken, so nothing passed through. Both directions matter: counting these would
   *  raise a false alarm, which trains the owner to ignore the tile. */
  it('ignores pending and failed payments', async () => {
    await seedCharged({ totalAgorot: 900_00, paidDaysAgo: 3, paymentStatus: 'pending' });
    await seedCharged({ totalAgorot: 900_00, paidDaysAgo: 3, paymentStatus: 'failed' });
    const c = await getLicenceCeiling(TODAY);
    expect(c.received.totalAgorot).toBe(0);
  });

  /**
   * Found by the containment invariant in `reporting-invariants` §9, not by writing this file: the
   * query required `paid_at`, and an order can be genuinely charged with that column NULL —
   * `payout-hold.ts` carries a branch for exactly that shape. Every such order was invisible here.
   *
   * The two modules take OPPOSITE fallbacks from the same fact, and both are right. The hold
   * refuses to date the order and keeps holding, because holding is its safe direction. This one
   * dates it from `created_at` and counts it, because dropping it understates the ceiling, which is
   * the failure that ends with an unlicensed payment service.
   */
  it('counts a charged order whose paid_at was never written', async () => {
    await seedCharged({ totalAgorot: 250_00, paidDaysAgo: 4, paidAtNull: true });
    const c = await getLicenceCeiling(TODAY);
    expect(c.received.totalAgorot).toBe(250_00);
  });

  it('leaves out anything older than the window', async () => {
    await seedCharged({ totalAgorot: 500_00, paidDaysAgo: 20 });
    await seedCharged({ totalAgorot: 700_00, paidDaysAgo: 800 });
    const c = await getLicenceCeiling(TODAY);
    expect(c.received.totalAgorot).toBe(500_00);
  });
});

describe('the average divides by months that really elapsed', () => {
  /**
   * The overstatement-of-headroom bug in its purest form. A platform two months old, dividing a
   * two-month total by a fixed twelve, reports a sixth of its true monthly rate — so the tile would
   * read 8% at the moment the platform is actually running at 50% of the ceiling.
   */
  it('a young platform is not divided by the full window', async () => {
    await seedCharged({ totalAgorot: 600_00, paidDaysAgo: 10 });
    const c = await getLicenceCeiling(TODAY);
    // TODAY is the 16th of a 31-day month, so half a month has elapsed — 600₪ in 16 days is a rate
    // of ~1,163₪/month, and reporting it as 600 is the sawtooth this divisor exists to remove.
    expect(c.months).toBeCloseTo(16 / 31, 5);
    expect(c.received.monthlyAverageAgorot).toBe(Math.round(600_00 / (16 / 31)));
  });

  it('spans the months between the first receipt and today', async () => {
    await seedCharged({ totalAgorot: 300_00, paidDaysAgo: 70 });  // 2026-06-07
    await seedCharged({ totalAgorot: 300_00, paidDaysAgo: 1 });
    const c = await getLicenceCeiling(TODAY);
    expect(c.months).toBeCloseTo(2 + 16 / 31, 5);       // June, July, and half of August
    expect(c.received.monthlyAverageAgorot).toBe(Math.round(600_00 / (2 + 16 / 31)));
  });

  /**
   * The bias this replaced, stated as a property rather than a number: a partial month may never
   * make the reported rate DROP. Before the fractional divisor, every 1st of the month divided a
   * few days of receipts by a whole month and the gauge fell off a cliff it then climbed all month.
   */
  it('does not read lower simply because the month is young', async () => {
    // `paidDaysAgo` counts back from TODAY, so 15 lands the receipt on 2026-08-01 — the same day
    // the reading is taken, i.e. the first day of a fresh month with one day elapsed.
    await seedCharged({ totalAgorot: 600_00, paidDaysAgo: 15 });
    const onDayOne = await getLicenceCeiling('2026-08-01');
    expect(onDayOne.received.totalAgorot).toBe(600_00);
    expect(onDayOne.received.monthlyAverageAgorot).toBeGreaterThanOrEqual(600_00);
  });

  it('never divides by zero on an empty platform', async () => {
    const c = await getLicenceCeiling(TODAY);
    expect(c.months).toBeGreaterThanOrEqual(1);
    expect(c.received.monthlyAverageAgorot).toBe(0);
    expect(c.percent).toBe(0);
    expect(c.level).toBe('ok');
  });
});

describe('the level escalates on whichever leg is closer', () => {
  /** The exemption is breached by EITHER leg, so the headline may never be an average of the two
   *  or the quieter one would mask the other. */
  it('reports the higher of received and transferred', async () => {
    // Sized against the elapsed fraction so the monthly RATE is 80% of the ceiling.
    await seedCharged({ totalAgorot: Math.round(LICENCE_CEILING_AGOROT * 0.8 * (16 / 31)), paidDaysAgo: 10 });
    const c = await getLicenceCeiling(TODAY);
    expect(c.transferred.percent).toBe(0);
    expect(c.percent).toBe(c.received.percent);
    expect(c.percent).toBeCloseTo(80, 0);
    expect(c.level).toBe('act');
  });

  it.each([
    [0.2, 'ok'],
    [CEILING_WATCH_PERCENT / 100, 'watch'],
    [CEILING_ACT_PERCENT / 100, 'act'],
  ])('at %s of the ceiling the level is %s', async (share, level) => {
    await seedCharged({ totalAgorot: Math.round(LICENCE_CEILING_AGOROT * share * (16 / 31)), paidDaysAgo: 10 });
    const c = await getLicenceCeiling(TODAY);
    expect(c.level).toBe(level);
  });
});
