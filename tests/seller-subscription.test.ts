/**
 * The seller's monthly fee — money flowing TOWARDS us, and the thing that publishes his shop.
 *
 * Every case here is a way it could go wrong quietly:
 *
 *  · a second subscription opened for a seller who already has one — two monthly charges on one
 *    card, and PayMe have no idea the first exists;
 *  · a plan taken from the request instead of from the account, which is a client-sent price
 *    wearing a different hat;
 *  · a cancellation that our row records and PayMe never received, so the card keeps being billed;
 *  · a status nobody has met reading as "paying", which would publish a shop nobody is paying for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rig = vi.hoisted(() => ({
  seller: { id: 'seller-1', name: 'חנות הבדיקה', email: 's@example.com', tier: 'growth' } as Record<string, unknown> | null,
  /** The row currently in `seller_subscriptions`, or null. */
  row: null as Record<string, unknown> | null,
  /** What `store-plan.ts` says this seller has on the site — one shop on `growth` by default. The
   *  price of a standing order is the SUM of these since 2026-08-24, so this rig field is what a
   *  "he opened a second shop" case changes. */
  stores: [] as { storeId: string; storeName: string; tier: string; feeAgorot: number }[],
  generated: [] as Record<string, unknown>[],
  cancelled: [] as string[],
  events: [] as Record<string, unknown>[],
  errors: [] as Record<string, unknown>[],
  generateThrows: false,
  cancelThrows: false,
  /** Every `set-price` PATCH the module made, and whether PayMe should refuse it. */
  priced: [] as { subId: string; agorot: number }[],
  priceThrows: false,
  upstream: null as { subStatus: number; nextDate?: string; subUrl?: string } | null,
  /** What `generate-subscription` should answer with — `active` on the token route, `initial` on
   *  the hosted-page one, which is the case the double-charge guard is about. */
  generateStatus: 2,
  queries: [] as { sql: string; params: readonly unknown[] }[],
}));

vi.mock('../src/lib/db.js', () => ({
  isUuid: () => true,
  firstRow: async (sql: string, params: readonly unknown[]) => {
    rig.queries.push({ sql, params });
    if (sql.includes('INSERT INTO seller_subscriptions')) {
      rig.row = {
        seller_id: params[0], provider: 'payme', provider_ref: params[1], store_fees: params[2],
        price_agorot: params[3], status: params[4], started_at: '2026-08-23T00:00:00.000Z',
        next_charge: params[6], canceled_at: null, ends_at: null,
      };
      return rig.row;
    }
    return rig.row;
  },
  query: async (sql: string, params: readonly unknown[]) => {
    rig.queries.push({ sql, params });
    if (rig.row && sql.includes('UPDATE seller_subscriptions')) {
      rig.row.status = params[1];
      // The two writers stamp `canceled_at` differently and both have to be honoured here, or the
      // assertion below would be about this stub rather than about the module: `endSubscription`
      // sets it outright, `refreshSubscription` sets it only when PayMe report the cancelled status.
      if (sql.includes('canceled_at = now()')) rig.row.canceled_at = '2026-08-24T00:00:00.000Z';
      // `endSubscription` stamps both the press and the end of the paid month; the two are
      // different dates on purpose, and the second is what keeps his shops up until it passes.
      if (sql.includes('ends_at = $3')) {
        rig.row.canceled_at = '2026-08-24T00:00:00.000Z';
        rig.row.ends_at = params[2];
      } else if (sql.includes('COALESCE(canceled_at, now())') && params[1] === 5) {
        rig.row.canceled_at = '2026-08-24T00:00:00.000Z';
      }
      if (sql.includes('SET status = $2, next_charge = $3') && params.length > 2) rig.row.next_charge = params[2];
    }
  },
}));
vi.mock('../src/lib/seller-auth.js', () => ({ getSellerById: async () => rig.seller }));
// Only the database read is stubbed; the arithmetic that turns shops into a price is the real one,
// so a test can never agree with a sum this module would not actually charge.
vi.mock('../src/lib/store-plan.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/store-plan.js')>('../src/lib/store-plan.js');
  return { ...actual, billedStoresFor: async () => rig.stores };
});
vi.mock('../src/lib/money-events.js', () => ({
  recordMoneyEvent: async (e: Record<string, unknown>) => { rig.events.push(e); return e; },
}));
vi.mock('../src/lib/error-log.js', () => ({
  logError: async (e: Record<string, unknown>) => { rig.errors.push(e); },
}));

const payme = await vi.importActual<typeof import('../src/lib/payment-payme.js')>('../src/lib/payment-payme.js');
vi.mock('../src/lib/payment-payme.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/payment-payme.js')>('../src/lib/payment-payme.js');
  return {
    ...actual,
    activePaymeCredentials: () => CREDS,
    generateSubscription: async (input: Record<string, unknown>) => {
      if (rig.generateThrows) throw new actual.PaymeError('generate-subscription', 101, 'ת.ז לא תקינה');
      rig.generated.push(input);
      return { subPaymeId: 'SUB1', subStatus: rig.generateStatus, nextDate: '2026-09-23 10:00:00' };
    },
    cancelSubscription: async (_own: string, id: string) => {
      if (rig.cancelThrows) throw new Error('PayMe refused');
      rig.cancelled.push(id);
    },
    setSubscriptionPrice: async (_own: string, subId: string, agorot: number) => {
      if (rig.priceThrows) throw new actual.PaymeError('set-price', 172, 'subscription not active');
      rig.priced.push({ subId, agorot });
    },
    getSubscriptionStatus: async () => rig.upstream,
  };
});

const CREDS = { clientKey: 'k', ownMerchantId: 'MPL-OURS', baseUrl: 'https://sandbox.payme.io/api/' };

const { startSubscription, endSubscription, refreshSubscription, sellerIsSubscribed, subscriptionFor, syncSubscriptionPrice } =
  await import('../src/lib/seller-subscription.js');

beforeEach(() => {
  rig.seller = { id: 'seller-1', name: 'חנות הבדיקה', email: 's@example.com' };
  rig.stores = [{ storeId: 'store-1', storeName: 'חנות הבדיקה', tier: 'growth', feeAgorot: 12500 }];
  rig.row = null;
  rig.generated = [];
  rig.cancelled = [];
  rig.events = [];
  rig.errors = [];
  rig.generateThrows = false;
  rig.cancelThrows = false;
  rig.priced = [];
  rig.priceThrows = false;
  rig.upstream = null;
  rig.generateStatus = payme.PAYME_SUB_STATUS.active;
  rig.queries = [];
});

describe('starting one', () => {
  it("bills OUR merchant account at the price of the shops he is putting on the site", async () => {
    const res = await startSubscription('seller-1', {}, CREDS);
    expect(res.status).toBe('ok');
    // One shop on `growth` — 125₪, read from the store row, never from the caller. A plan id
    // arriving in a request would be a client-sent price by another name.
    expect(rig.generated[0]).toMatchObject({ ownMerchantId: 'MPL-OURS', priceAgorot: 12500, correlationId: 'seller-1' });
  });

  // **The ruling of 2026-08-24, as arithmetic**: *"כל חנות צריכה לעלות כסף בנפרד"*. Before it, a
  // seller with three shops paid for one — and it would have been invisible, because every screen
  // showed the plan he had chosen and every screen was right.
  it('charges the SUM of his shops, each on its own plan', async () => {
    rig.stores = [
      { storeId: 'store-1', storeName: 'א', tier: 'growth', feeAgorot: 12500 },
      { storeId: 'store-2', storeName: 'ב', tier: 'starter', feeAgorot: 9900 },
    ];
    await startSubscription('seller-1', {}, CREDS);
    expect(rig.generated[0]).toMatchObject({ priceAgorot: 22400 });
  });

  // A ₪0 standing order is not a thing PayMe would accept, and it would mean nothing if they did.
  // The seller has built a shop and has not asked for it to go on the site.
  it('refuses to open a subscription for a seller with nothing on the site', async () => {
    rig.stores = [];
    const res = await startSubscription('seller-1', {}, CREDS);
    expect(res.status).toBe('no-store-to-bill');
    expect(rig.generated).toEqual([]);
  });

  // Two subscriptions on one card is a seller billed twice with PayMe unaware of the first, and it
  // is the single worst outcome available on this path.
  it('never opens a second one for a seller who is already paying', async () => {
    await startSubscription('seller-1', {}, CREDS);
    rig.generated = [];
    const again = await startSubscription('seller-1', {}, CREDS);
    expect(again.status).toBe('already');
    expect(rig.generated).toEqual([]);
  });

  // A subscription that FAILED or was cancelled is not a subscription. The seller is starting again,
  // and refusing him would leave him unable to pay at all.
  it('lets a seller whose subscription was cancelled start a new one', async () => {
    await startSubscription('seller-1', {}, CREDS);
    await endSubscription('seller-1', CREDS);
    rig.generated = [];
    expect((await startSubscription('seller-1', {}, CREDS)).status).toBe('ok');
    expect(rig.generated).toHaveLength(1);
  });

  // **The hole this suite was written without.** On the hosted-page route the subscription is
  // created BEFORE anybody pays, so it sits `initial` and `subscriptionIsPaying` is correctly false
  // for it. Reading that as "he has none" is how a seller who pressed the button, closed PayMe's
  // tab and pressed it again ends up with TWO standing arrangements against one card.
  it('sends a seller back to the SAME unpaid subscription instead of creating a second', async () => {
    rig.generateStatus = payme.PAYME_SUB_STATUS.initial;
    await startSubscription('seller-1', {}, CREDS);
    rig.generated = [];
    rig.upstream = { subStatus: payme.PAYME_SUB_STATUS.initial, subUrl: 'https://pay.me/SUB1' };

    const again = await startSubscription('seller-1', {}, CREDS);
    expect(again.status).toBe('pending');
    expect(again.status === 'pending' && again.payUrl).toBe('https://pay.me/SUB1');
    expect(rig.generated).toEqual([]);
  });

  // He paid on their page and came back. Their callback needs a public URL we do not have, so the
  // stored status is stale — asking PayMe is what stops a second subscription here too.
  it('recognises an unpaid one that has since been paid, and opens nothing', async () => {
    rig.generateStatus = payme.PAYME_SUB_STATUS.initial;
    await startSubscription('seller-1', {}, CREDS);
    rig.generated = [];
    rig.upstream = { subStatus: payme.PAYME_SUB_STATUS.active };

    expect((await startSubscription('seller-1', {}, CREDS)).status).toBe('already');
    expect(rig.generated).toEqual([]);
    expect(await sellerIsSubscribed('seller-1', CREDS)).toBe(true);
  });

  // A cancelled or failed one is nothing standing, so a new one IS correct — the guard above must
  // not become "never let a seller subscribe again".
  it('does create a new one when the unpaid attempt was cancelled at their end', async () => {
    rig.generateStatus = payme.PAYME_SUB_STATUS.initial;
    await startSubscription('seller-1', {}, CREDS);
    rig.generated = [];
    rig.upstream = { subStatus: payme.PAYME_SUB_STATUS.canceled };

    expect((await startSubscription('seller-1', {}, CREDS)).status).toBe('ok');
    expect(rig.generated).toHaveLength(1);
  });

  it('journals the charge, so a subscription is comparable with PayMe\'s own record', async () => {
    await startSubscription('seller-1', {}, CREDS);
    expect(rig.events[0]).toMatchObject({ type: 'payment_attempted', amountAgorot: 12500 });
  });

  // Never throws — it runs behind a button, and an unhandled gateway error there is an error page in
  // front of the one person on the platform who is trying to start paying.
  it('reports a refusal instead of throwing, and says so where a person will read it', async () => {
    rig.generateThrows = true;
    const res = await startSubscription('seller-1', {}, CREDS);
    expect(res.status).toBe('failed');
    expect(rig.errors).toHaveLength(1);
  });

  it('refuses when we hold no merchant account of our own to collect into', async () => {
    const res = await startSubscription('seller-1', {}, { clientKey: 'k', baseUrl: 'https://sandbox.payme.io/api/' });
    expect(res.status).toBe('no-collection-account');
    expect(rig.generated).toEqual([]);
  });
});

describe('stopping one', () => {
  it('cancels at PayMe and records it here', async () => {
    await startSubscription('seller-1', {}, CREDS);
    expect(await endSubscription('seller-1', CREDS)).toBe(true);
    expect(rig.cancelled).toEqual(['SUB1']);
  });

  /**
   * **The two dates, which are the whole ruling of 2026-08-24** — cancellation takes effect
   * *"בסוף התקופה ששולמה"*. The charging stops now, because there is no way to tell PayMe "one more
   * month then stop"; what he BOUGHT runs to the end of the month he paid for. Reading the
   * cancellation as the end would take back days he paid for, from the seller most worth keeping.
   */
  it('keeps him subscribed until the end of the month he already paid for', async () => {
    await startSubscription('seller-1', {}, CREDS);  // next charge 2026-09-23, per the PayMe stub
    await endSubscription('seller-1', CREDS);
    expect(await sellerIsSubscribed('seller-1', CREDS)).toBe(true);
    expect((await subscriptionFor('seller-1'))?.endsAt).toContain('2026-09-23');
  });

  it('stops being subscribed once that date has passed', async () => {
    await startSubscription('seller-1', {}, CREDS);
    await endSubscription('seller-1', CREDS);
    // The one thing the sweep keys off (`lib/subscription-lapse.ts`): the date, not the click.
    rig.row!.ends_at = '2020-01-01T00:00:00.000Z';
    expect(await sellerIsSubscribed('seller-1', CREDS)).toBe(false);
  });

  // The alternative is a seller who pressed cancel, was told it failed, and has no other way to stop
  // a recurring charge on his card. So the local row is marked either way — and the failure is
  // loud, because a subscription cancelled here and still live there keeps billing him.
  it('still records the cancellation when PayMe refuse, and says so loudly', async () => {
    await startSubscription('seller-1', {}, CREDS);
    rig.cancelThrows = true;
    expect(await endSubscription('seller-1', CREDS)).toBe(true);
    expect((await subscriptionFor('seller-1'))?.canceledAt).toBeTruthy();
    expect(rig.errors).toHaveLength(1);
  });

  it('answers false rather than pretending, when there is nothing to cancel', async () => {
    expect(await endSubscription('seller-1', CREDS)).toBe(false);
  });
});

describe('what "paying" means', () => {
  // A card that expired between iterations is not a seller refusing to pay: PayMe retry daily and
  // cancel on the seventh failure. Taking his shop off the site on the first decline would punish
  // the two identically, a week before the answer is in.
  it('counts a subscription mid-dunning as paying', async () => {
    await startSubscription('seller-1', {}, CREDS);
    rig.upstream = { subStatus: payme.PAYME_SUB_STATUS.retrying };
    await refreshSubscription('seller-1', CREDS);
    expect(await sellerIsSubscribed('seller-1', CREDS)).toBe(true);
  });

  it('stops counting one PayMe have cancelled', async () => {
    await startSubscription('seller-1', {}, CREDS);
    rig.upstream = { subStatus: payme.PAYME_SUB_STATUS.canceled };
    await refreshSubscription('seller-1', CREDS);
    expect(await sellerIsSubscribed('seller-1', CREDS)).toBe(false);
    expect((await subscriptionFor('seller-1'))?.canceledAt).toBeTruthy();
  });

  // A lookup that found nothing is not a verdict. Writing one from a failed lookup is how a paying
  // seller's shop goes dark on a bad afternoon at the gateway.
  it('leaves the stored status alone when PayMe do not answer', async () => {
    await startSubscription('seller-1', {}, CREDS);
    rig.upstream = null;
    expect(await refreshSubscription('seller-1', CREDS)).toBe(payme.PAYME_SUB_STATUS.active);
    expect(await sellerIsSubscribed('seller-1', CREDS)).toBe(true);
  });

  // With no gateway nobody can subscribe, so gating on one would hold every store on the platform
  // dark in development. `site-mode.ts` is what stops a production server selling without a provider.
  it('answers "paying" when no clearing provider is configured at all', async () => {
    expect(await sellerIsSubscribed('seller-1', null)).toBe(true);
  });
});

describe('the card token never reaches a caller', () => {
  // It is not a card number, but it CAN be charged: anyone holding it can bill this seller through
  // our merchant account. Same defence `seller_merchant_accounts` gives `callback_secret`.
  it('is absent from the shape every read returns', async () => {
    await startSubscription('seller-1', { buyerKey: 'BUYER-TOKEN' }, CREDS);
    const sub = await subscriptionFor('seller-1');
    expect(JSON.stringify(sub)).not.toContain('BUYER-TOKEN');
    // And no read even SELECTs it — a `SELECT *` here is how it would reach a caller that never
    // asked.
    for (const q of rig.queries.filter((x) => x.sql.includes('SELECT'))) {
      expect(q.sql).not.toContain('buyer_key');
      expect(q.sql).not.toContain('SELECT *');
    }
  });
});

/**
 * Changing plan while the card is already being charged.
 *
 * The defect this replaced was silent by construction: `POST /api/seller/tier` wrote `sellers.tier`
 * and nothing else, so every report and commission line moved to the new plan while PayMe went on
 * charging the old amount. Nothing errors, nothing reconciles, and the first person to notice is a
 * seller reading a bank statement.
 *
 * The fix patches the standing order rather than replacing it (owner, 2026-08-24), so these tests
 * are as much about what must NOT happen — no cancellation, no second subscription — as about the
 * new call.
 */
describe('changing what a paying seller is charged', () => {
  async function startPaying(): Promise<void> {
    await startSubscription('seller-1', {}, CREDS);
    // The setup call is not the subject: only what the PROPAGATION does afterwards is.
    rig.queries = [];
    rig.events = [];
    rig.generated = [];
  }

  it("patches the standing order to the new price, and never cancels it", async () => {
    await startPaying();                                  // growth, 12,500 agorot
    // The shop moved to `enterprise`; the price is re-derived from the shops, never passed in.
    rig.stores = [{ storeId: 'store-1', storeName: 'חנות הבדיקה', tier: 'enterprise', feeAgorot: 19900 }];
    const res = await syncSubscriptionPrice('seller-1', {}, CREDS);

    expect(res.status).toBe('updated');
    // 199₪ — read from `pricing.ts` through the tier, exactly as `startSubscription` reads it.
    expect(rig.priced).toEqual([{ subId: 'SUB1', agorot: 19900 }]);
    // The card the seller already gave us stays where it is. A cancel-and-recreate would ask him to
    // authorise it again for a change he made in one click.
    expect(rig.cancelled).toEqual([]);
    expect(rig.generated).toEqual([]);
  });

  it('brings our own row level with what PayMe now charge', async () => {
    await startPaying();
    rig.stores = [{ storeId: 'store-1', storeName: 'חנות הבדיקה', tier: 'enterprise', feeAgorot: 19900 }];
    await syncSubscriptionPrice('seller-1', {}, CREDS);

    const update = rig.queries.find((q) => q.sql.includes('UPDATE seller_subscriptions'));
    // The breakdown travels with the figure: a price with no explanation is what made "why am I
    // charged ₪224" unanswerable on the seller's own screen.
    expect(update?.params).toEqual(['seller-1', JSON.stringify(rig.stores), 19900]);
    // And the journal carries it, because a monthly charge that changed size is exactly what
    // reconciliation is later asked to explain.
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]).toMatchObject({ amountAgorot: 19900, actor: 'seller' });
  });

  it('reports failure and writes NOTHING when PayMe refuse', async () => {
    await startPaying();
    rig.stores = [{ storeId: 'store-1', storeName: 'חנות הבדיקה', tier: 'enterprise', feeAgorot: 19900 }];
    rig.priceThrows = true;

    const res = await syncSubscriptionPrice('seller-1', {}, CREDS);

    expect(res.status).toBe('failed');
    // The whole point of the order the route uses: a refusal leaves the seller on the plan he is
    // actually being charged for, so there is no divergence to discover later.
    expect(rig.queries.some((q) => q.sql.includes('UPDATE seller_subscriptions'))).toBe(false);
    expect(rig.events).toEqual([]);
    // Loud, because nobody else will notice: the seller was told it failed and we now know why.
    expect(rig.errors[0]).toMatchObject({ route: 'payme:set-price' });
  });

  it('throws away an UNPAID subscription so the next one is created at the new price', async () => {
    // The hosted-page route: PayMe created it, nobody has paid, and `startSubscription` would send
    // him back to that same page — priced at the plan he has just left.
    rig.generateStatus = payme.PAYME_SUB_STATUS.initial;
    await startSubscription('seller-1', {}, CREDS);
    rig.queries = [];
    rig.generated = [];
    rig.stores = [{ storeId: 'store-1', storeName: 'חנות הבדיקה', tier: 'enterprise', feeAgorot: 19900 }];

    const res = await syncSubscriptionPrice('seller-1', {}, CREDS);

    expect(res.status).toBe('reset');
    // Not patched: measured 2026-08-24, `set-price` on a subscription in `initial` is refused.
    expect(rig.priced).toEqual([]);
    expect(rig.cancelled).toEqual(['SUB1']);
    // And our row says cancelled, which is what makes `startSubscription` open a fresh one rather
    // than hand him the old page again.
    const update = rig.queries.find((q) => q.sql.includes('UPDATE seller_subscriptions'));
    expect(update?.params).toEqual(['seller-1', payme.PAYME_SUB_STATUS.canceled]);
  });

  it('writes no tier when PayMe refuse to discard the unpaid one', async () => {
    rig.generateStatus = payme.PAYME_SUB_STATUS.initial;
    await startSubscription('seller-1', {}, CREDS);
    rig.queries = [];
    rig.cancelThrows = true;

    const res = await syncSubscriptionPrice('seller-1', {}, CREDS);

    // Their payment page is still live and still charges the old plan. Saying the change succeeded
    // would put the divergence one door along instead of removing it.
    expect(res.status).toBe('failed');
    expect(rig.queries.some((q) => q.sql.includes('UPDATE seller_subscriptions'))).toBe(false);
  });

  it('calls nobody when the seller is not paying — the store rows ARE the change then', async () => {
    // No subscription at all: `startSubscription` re-reads his shops when one is created, so the
    // choice reaches PayMe the first time he pays.
    const res = await syncSubscriptionPrice('seller-1', {}, CREDS);
    expect(res.status).toBe('not-paying');
    expect(rig.priced).toEqual([]);
  });

  it('does not re-send a price PayMe are already charging', async () => {
    await startPaying();
    // The shops did not move — same plan, same sum.
    const res = await syncSubscriptionPrice('seller-1', {}, CREDS);
    expect(res.status).toBe('updated');
    // Same money. A request that cannot change anything can still fail, and a failure here would be
    // reported to a seller who changed nothing.
    expect(rig.priced).toEqual([]);
  });
});
