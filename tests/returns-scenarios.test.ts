import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { APIContext, AstroCookies } from 'astro';
import { POST as checkout } from '../src/pages/api/checkout.js';
import { query } from '../src/lib/db.js';
import { getOrderById, updateOrder, countsAsRevenue } from '../src/lib/orders.js';
import {
  openReturnRequest, moveReturnRequest, getReturnRequest, hasOpenReturn,
  type ReturnRequest,
} from '../src/lib/return-requests.js';
import { runReturnsSweep } from '../src/lib/returns-run.js';
import { orderHold } from '../src/lib/payout-hold.js';
import {
  RETURN_TRANSITIONS, isOpen, canEscalate,
  HANDOVER_DAYS, IN_TRANSIT_PATIENCE_DAYS, OFFER_ANSWER_DAYS,
  type ReturnStatus,
} from '../src/lib/returns.js';
import { buyerReturnCta } from '../src/lib/return-buyer-cta.js';

/**
 * ═══ EVERY WAY A RETURN CAN END, DRIVEN END TO END AGAINST A REAL DATABASE ═══
 *
 * ── Why this file exists ──
 *
 * The owner asked for it in as many words: *"תריץ את כל התרחישים האפשריים של ביטול או החזרה, בכל
 * טוווח זזמן אפשרי, ותראה אם יש מענה תקין בלוגיקה שלנו"* — and then, when I answered with an analysis
 * instead: *"אני לא מבין אתה לא מריץ תרחישים מקצה לקצה ובודק בכל מקרה בכל מקום?"*. He was right, and
 * the reason it mattered is what the walk found. Five holes, every one of them in a path that was
 * individually covered by a passing unit test:
 *
 *   1. The buyer sends the product, the seller touches nothing → the case expired on day 7 and the
 *      seller kept the money AND the goods. Reachable in complete silence.
 *   2. The seller's "the buyer sent it" button returned 403.
 *   3. The same hole one step later: `in_transit` reached, receipt never marked.
 *   4. A refusal outside the statutory window had no route to a person.
 *   5. `offered` had no clock, so an unanswered offer froze the case and that payout forever.
 *
 * Every one is a JOIN between parts that were each correct. That is precisely what a per-function test
 * cannot see, so this file asserts differently: it walks whole timelines, and at every stop it asks the
 * only two questions that matter — **where is the product, and where is the money** — plus the question
 * the five holes were all really about: **is anybody still able to move this at all?**
 *
 * ── How time works here ──
 *
 * Not by backdating rows. `runReturnsSweep(todayISO)` takes the day as an argument (so the job, this
 * test and a screen all read one clock), so a scenario simply asks for a later day. `at(n)` is n days
 * after the case opened. That is the whole time-travel mechanism, and it means these tests exercise the
 * REAL predicates against the REAL stored timestamps rather than a fixture's idea of them.
 */

const ctx = (body: unknown): APIContext => ({
  request: new Request('http://localhost/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  cookies: { get: () => undefined, set: () => {}, delete: () => {}, has: () => false } as unknown as AstroCookies,
  clientAddress: '127.0.0.1',
} as unknown as APIContext);

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const STORE = { slug: 'keramika', name: 'קרמיקה', sellerId: '11111111-1111-4111-8111-000000000001' };
const BUYER = 'buyer-under-test';

/** The day n days from now, as the sweep wants it. Generous margins beat business-day arithmetic in a
 *  test: a scenario that means "well past the deadline" should not fail because a Saturday moved. */
const at = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const stockOf = async (): Promise<number> => {
  const { rows } = await query<{ stock: number }>(
    `SELECT stock FROM store_products WHERE store_id = $1 AND slug = 'agartal'`, [KERAMIKA]);
  return Number(rows[0]?.stock ?? -1);
};

/** One paid, delivered order — the only shape a RETURN can start from. */
async function deliveredOrder(deliveredDaysAgo = 0) {
  const res = await checkout(ctx({
    buyerName: 'דנה', buyerEmail: 'scenarios@example.test', buyerPhone: '0501234567',
    buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
    items: [{ storeSlug: 'keramika', productSlug: 'agartal', qty: 1, selectedVariants: { צבע: 'כחול' } }],
    idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
  }));
  const body = await res.json() as { orderIds?: string[] };
  const id = body.orderIds![0]!;
  await updateOrder(id, { shippingStatus: 'delivered' });
  // `delivered_at` is written by the STATUS change as `now()` and a passed value is ignored
  // (orders.ts, the `delivered_at = CASE WHEN ... THEN now()` line), so an OLD delivery — the only way
  // to reach a request the seller may actually refuse — has to be written to the column directly.
  if (deliveredDaysAgo > 0) {
    await query(`UPDATE orders SET delivered_at = now() - ($2 || ' days')::interval WHERE id = $1`,
      [id, String(deliveredDaysAgo)]);
  }
  return (await getOrderById(id))!;
}

/** Open a case and hand back the row, failing loudly rather than returning a union nobody unwraps. */
async function open(order: Awaited<ReturnType<typeof deliveredOrder>>, reason: 'changed_mind' | 'damaged' = 'changed_mind'): Promise<ReturnRequest> {
  const opened = await openReturnRequest({ order, storeSlug: 'keramika', reason });
  if ('error' in opened) throw new Error(`could not open a case: ${opened.error}`);
  return opened;
}

const move = async (id: string, to: ReturnStatus, actor = STORE.sellerId, extra: Record<string, unknown> = {}): Promise<ReturnRequest> => {
  const moved = await moveReturnRequest({ id, to, actor, store: STORE, ...extra });
  if ('error' in moved) throw new Error(`refused ${to}: ${moved.error}`);
  return moved.request;
};

/**
 * The question every one of the five holes was really an answer to: **can this case still move?**
 *
 * An open case must have at least one of two things — a person with a button, or a clock that will fire
 * without one. A state with neither is not a slow case; it is a case that never ends, with somebody's
 * money held against it forever, and nobody late enough to chase. That is exactly what `offered` was.
 */
async function somebodyCanStillAct(r: ReturnRequest): Promise<boolean> {
  if (!isOpen(r.status)) return true;
  // A person: the buyer's own card, or the seller/admin having a legal move that is not the sweep's.
  if (buyerReturnCta(r).buttons.length > 0) return true;
  if (r.status === 'received' || r.status === 'requested' || r.status === 'disputed') return true;
  // A clock: run the sweep far enough into the future that any real deadline must have passed.
  const before = r.status;
  await runReturnsSweep(at(400));
  const after = (await getReturnRequest(r.id))!.status;
  return after !== before;
}

beforeEach(async () => {
  await query(`UPDATE store_products SET stock = 7 WHERE store_id = $1 AND slug = 'agartal'`, [KERAMIKA]);
  await query(`DELETE FROM seller_ledger_adjustments`);
  await query(`DELETE FROM return_requests`);
  await query(`DELETE FROM money_events`);
  await query(`DELETE FROM checkout_idempotency`);
  await query(`DELETE FROM order_items`);
  await query(`DELETE FROM order_stores`);
  await query(`DELETE FROM orders`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('the product goes back — every route it can take', () => {
  it('POSTED, seller confirms receipt, then says nothing → the buyer is refunded by the clock', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    expect(req.status).toBe('approved');           // inside the statutory window, nobody may refuse
    const stockAfterSale = await stockOf();

    // The buyer's own declaration — the correction at the heart of this whole change.
    const sent = await move(req.id, 'in_transit', BUYER);
    expect(sent.sentAt).not.toBe(null);

    const got = await move(req.id, 'received');
    expect(got.deliveredBackAt).not.toBe(null);

    // He answers neither way. Two business days later the buyer is paid without anyone asking us.
    await runReturnsSweep(at(6));
    const done = (await getReturnRequest(req.id))!;
    expect(done.status).toBe('refunded');
    expect(await stockOf()).toBe(stockAfterSale + 1);       // the units really come back
    expect(countsAsRevenue((await getOrderById(order.id))!)).toBe(false);
  });

  it('IN STORE — a shop offering collection takes it over the counter, with no parcel at all', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    const stockAfterSale = await stockOf();

    // `approved → received`, skipping the post entirely. The owner's rule: a shop that offers
    // self-pickup must accept in-store returns, and this is the strongest proof in the mechanism —
    // the seller marks it with the buyer standing in front of him.
    const got = await move(req.id, 'received');
    expect(got.status).toBe('received');
    expect(got.sentAt).toBe(null);                          // nothing was ever posted

    await move(req.id, 'refunded');
    expect(await stockOf()).toBe(stockAfterSale + 1);
  });

  it('POSTED but never confirmed → after a fortnight a PERSON decides, and the clock never pays either side', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    await move(req.id, 'in_transit', BUYER);

    // ⚠️ THE HOLE HE FOUND. This used to expire on day 7 in the seller's favour — money and goods
    // both — because `in_transit` shared the handover clock and `expired` was reachable from it.
    await runReturnsSweep(at(HANDOVER_DAYS + 1));
    expect((await getReturnRequest(req.id))!.status).toBe('in_transit');

    // And the day it does move, it moves to a human — not to a refund (the buyer's word is not proof)
    // and not to an expiry (the seller's silence is not a defence).
    await runReturnsSweep(at(IN_TRANSIT_PATIENCE_DAYS + 2));
    const stuck = (await getReturnRequest(req.id))!;
    expect(stuck.status).toBe('disputed');
    expect(orderHold({ ...(await getOrderById(order.id))!, hasOpenReturn: true }).basis).toBe('return_open');

    // The admin can end it either way, and both ways really end it.
    await move(req.id, 'refunded', 'admin');
    expect(await hasOpenReturn(order.id)).toBe(false);
  });

  it('NEVER POSTED and never even claimed → day 7 closes it, and the seller keeps the money he was paid', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    const stockAfterSale = await stockOf();

    // Nothing was said and nothing was sent. This expiry is the one that IS justified — and it is the
    // only one left, which is the whole difference from the version that had the hole.
    await runReturnsSweep(at(HANDOVER_DAYS + 2));
    const closed = (await getReturnRequest(req.id))!;
    expect(closed.status).toBe('expired');
    expect(await stockOf()).toBe(stockAfterSale);            // no goods came back, so none go on the shelf
    expect(countsAsRevenue((await getOrderById(order.id))!)).toBe(true);
    expect(await hasOpenReturn(order.id)).toBe(false);       // and the seller's payout is released
  });

  it('warns the buyer the day BEFORE the handover window closes on him', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    // The day before is a warning and not a closure — the case must still be exactly where it was.
    const r = await runReturnsSweep(at(HANDOVER_DAYS));
    expect(r.warned).toBeGreaterThan(0);
    expect((await getReturnRequest(req.id))!.status).toBe('approved');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('the seller refuses — and what the buyer can do about it', () => {
  it('cannot refuse inside the statutory window at all', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    expect(req.status).toBe('approved');   // never `requested`, so there is nothing to refuse
  });

  it('refuses outside the window, and the buyer can bring it to US — inside the appeal window', async () => {
    const order = await deliveredOrder(30);      // well past the statutory window
    const req = await open(order);
    expect(req.status).toBe('requested');        // now it really is his decision

    const refused = await move(req.id, 'rejected');
    expect(refused.settledAt).not.toBe(null);
    // Closed, and staying closed: the payout is released and neither queue counts it.
    expect(isOpen(refused.status)).toBe(false);
    expect(await hasOpenReturn(order.id)).toBe(false);

    // ⚠️ The fourth hole: this route was decided and never built, so a refusal was the end of the road.
    expect(canEscalate(refused.status, refused.settledAt)).toBe(true);
    expect(buyerReturnCta(refused).buttons.map((b) => b.to)).toEqual(['disputed']);

    const escalated = await move(req.id, 'disputed', BUYER, { buyerNote: 'המוצר הגיע שבור ויש לי תמונות' });
    expect(escalated.status).toBe('disputed');
    expect(escalated.buyerNote).toContain('שבור');           // his words survive to the person deciding
    expect(await hasOpenReturn(order.id)).toBe(true);         // and the money freezes again
  });

  it('shuts the appeal window after two weeks, so a finished case cannot reopen against paid-out money', async () => {
    const order = await deliveredOrder(30);
    const req = await open(order);
    const refused = await move(req.id, 'rejected');
    const longAgo = new Date();
    longAgo.setUTCDate(longAgo.getUTCDate() - 40);
    expect(canEscalate('rejected', longAgo.toISOString())).toBe(false);
    expect(buyerReturnCta({ ...refused, settledAt: longAgo.toISOString() }).buttons).toEqual([]);
  });

  it('closes a request the seller simply ignores, and warns him first', async () => {
    const order = await deliveredOrder(30);
    const req = await open(order);
    expect(req.status).toBe('requested');

    // Two business days, and silence costs him nothing — which is why he gets the one warning.
    await runReturnsSweep(at(5));
    const closed = (await getReturnRequest(req.id))!;
    expect(closed.status).toBe('rejected');
    expect(closed.sellerNote).toContain('לא התקבלה תשובה');
    // Still appealable: an auto-refusal is a refusal, and the buyer never got a decision on the merits.
    expect(canEscalate(closed.status, closed.settledAt)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('money instead of a return — the offer, and every way it can end', () => {
  it('ACCEPTED → the agreed amount is paid and the goods stay with the buyer', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    const stockAfterSale = await stockOf();

    await move(req.id, 'offered', STORE.sellerId, { partialOfferAgorot: 4_000 });
    const paid = await move(req.id, 'refunded', BUYER);
    expect(paid.status).toBe('refunded');
    // Nothing came back, so nothing is restocked, and the order is still a delivered sale.
    expect(await stockOf()).toBe(stockAfterSale);
    expect(countsAsRevenue((await getOrderById(order.id))!)).toBe(true);
  });

  it('DECLINED → the ordinary return resumes exactly where it stopped, at no cost to the buyer', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    await move(req.id, 'offered', STORE.sellerId, { partialOfferAgorot: 4_000 });

    const back = await move(req.id, 'approved', BUYER);
    expect(back.status).toBe('approved');
    // And the handover clock is the one from the ORIGINAL approval, not a new one: declining an offer
    // must not quietly buy the buyer another week, nor cost him the days he already spent.
    expect(back.approvedAt).toBe(req.approvedAt);
    expect(buyerReturnCta(back).buttons.map((b) => b.to)).toEqual(['in_transit']);
  });

  it('UNANSWERED → it lapses instead of freezing the case and the payout forever', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    const offered = await move(req.id, 'offered', STORE.sellerId, { partialOfferAgorot: 4_000 });
    expect(offered.offeredAt).not.toBe(null);

    // ⚠️ The fifth hole: `offered` had no clock at all. Nobody was late, nothing was chasing it, and
    // that order's payout was held indefinitely.
    await runReturnsSweep(at(OFFER_ANSWER_DAYS + 3));
    const lapsed = (await getReturnRequest(req.id))!;
    expect(lapsed.status).toBe('expired');
    expect(await hasOpenReturn(order.id)).toBe(false);
  });

  it('is the BUYER\'s answer to give — a seller cannot accept his own offer', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    await move(req.id, 'offered', STORE.sellerId, { partialOfferAgorot: 4_000 });
    // The machine allows `offered → refunded`; only the ROLE forbids it, which is why the API test
    // for this lives beside the route. Here the point is that the buyer's card is the only place the
    // question is asked at all.
    expect(buyerReturnCta((await getReturnRequest(req.id))!).buttons.map((b) => b.to))
      .toEqual(['refunded', 'approved']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('the parcel came back wrong — the one claim nothing can verify', () => {
  it('an empty-parcel claim freezes the money and reaches a person, either way it ends', async () => {
    const order = await deliveredOrder();
    const req = await open(order);
    await move(req.id, 'in_transit', BUYER);
    await move(req.id, 'received');

    const claimed = await move(req.id, 'disputed', STORE.sellerId, { sellerNote: 'החבילה הגיעה ריקה' });
    expect(claimed.status).toBe('disputed');
    expect(await hasOpenReturn(order.id)).toBe(true);

    // A clock must NOT resolve this one — it is the single state in the mechanism that only a person
    // can close, and the daily sweep's alert exists precisely because of that.
    await runReturnsSweep(at(400));
    expect((await getReturnRequest(req.id))!.status).toBe('disputed');

    await move(req.id, 'rejected', 'admin', { adminNote: 'הוכרע לטובת המוכר' });
    expect((await getReturnRequest(req.id))!.status).toBe('rejected');
    expect(await hasOpenReturn(order.id)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('no case can be left with nobody able to move it', () => {
  /**
   * The generic form of all five holes, and the reason this block is worth more than the scenarios
   * above it: they each pin one timeline, and this pins the PROPERTY those timelines were violating.
   * A state added later with no owner and no clock fails here, on the day it is added.
   */
  it('every open state has either a person who can act or a clock that fires', async () => {
    const reachable: ReturnStatus[] = (Object.keys(RETURN_TRANSITIONS) as ReturnStatus[]).filter(isOpen);
    expect(reachable.length).toBeGreaterThan(4);

    for (const status of reachable) {
      const order = await deliveredOrder(status === 'requested' ? 30 : 0);
      const req = await open(order);
      // Walk to the state under test by the shortest legal route, so the row's timestamps are the
      // real ones the clocks read — a hand-written fixture would prove nothing about them.
      const route: Partial<Record<ReturnStatus, ReturnStatus[]>> = {
        requested: [], approved: [], offered: ['offered'], in_transit: ['in_transit'],
        received: ['in_transit', 'received'], disputed: ['in_transit', 'received', 'disputed'],
      };
      for (const step of route[status] ?? []) {
        await move(req.id, step, step === 'in_transit' ? BUYER : STORE.sellerId,
          step === 'offered' ? { partialOfferAgorot: 4_000 } : {});
      }
      const now = (await getReturnRequest(req.id))!;
      expect(now.status, `could not reach ${status}`).toBe(status);
      expect(await somebodyCanStillAct(now), `${status} can be left with nobody able to move it`).toBe(true);
    }
  });

  it('every terminal state releases the seller\'s payout — a closed case never holds money', async () => {
    // Each route carries the delivery age it NEEDS, and that is the point rather than a detail: a
    // refusal only exists outside the statutory window, and a return the buyer may simply post only
    // exists inside it. Running both off one fixture is how a test silently walks a path it did not
    // mean to — which it did here, refusing `in_transit` from a `requested` case.
    const routes: { age: number; from: ReturnStatus; reach: (id: string) => Promise<void>; expected: ReturnStatus }[] = [
      { age: 30, from: 'requested', expected: 'rejected', reach: async (id) => { await move(id, 'rejected'); } },
      { age: 0, from: 'approved', expected: 'refunded', reach: async (id) => {
        await move(id, 'in_transit', BUYER); await move(id, 'received'); await move(id, 'refunded');
      } },
      // The two closures nobody presses a button for. A terminal state the SWEEP produced must release
      // the payout exactly like one a person produced — the same assertion, a different author.
      { age: 0, from: 'approved', expected: 'expired', reach: async () => { await runReturnsSweep(at(HANDOVER_DAYS + 2)); } },
      { age: 30, from: 'requested', expected: 'rejected', reach: async () => { await runReturnsSweep(at(5)); } },
    ];
    for (const { age, from, reach, expected } of routes) {
      const order = await deliveredOrder(age);
      const req = await open(order);
      // Named rather than assumed: if the statutory rule ever changes, this fails on the line that
      // says what the fixture was FOR, instead of somewhere downstream in a route that cannot run.
      expect(req.status, `a case opened ${age} days after delivery`).toBe(from);
      await reach(req.id);
      expect((await getReturnRequest(req.id))!.status).toBe(expected);
      expect(await hasOpenReturn(order.id)).toBe(false);
      expect(orderHold({ ...(await getOrderById(order.id))!, hasOpenReturn: false }).basis).not.toBe('return_open');
    }
  });
});
