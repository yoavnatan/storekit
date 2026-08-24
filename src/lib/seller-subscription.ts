/**
 * The seller's monthly subscription — money flowing TOWARDS us, which is the whole reason this file
 * is separate from every other payment module here.
 *
 * `payment-split.ts` moves a buyer's money to a seller. This moves a seller's money to us, and the
 * two share nothing but a gateway: the card is the SELLER's, the merchant account is OURS
 * (`PaymeCredentials.ownMerchantId`), and the amount comes from his tier rather than from a cart.
 * Reading it as "another sale" is the mistake this paragraph exists to prevent.
 *
 * ── Why it exists at all ──
 * GO_LIVE §3.0.1: under the split model PayMe pay each seller directly, so we never hold a balance
 * of his and nothing he owes us can be deducted from anything. PayMe's own recurring billing is the
 * collection path — his card on file, charged monthly, with the dunning (a daily retry, cancelled on
 * the seventh failure) handled at their end. It costs us nothing (agreement appendix ב׳).
 *
 * ── And what it GATES ──
 * A seller builds a whole shop before he is ever asked for a card (owner, 2026-08-23). Starting the
 * subscription is what turns that shop public — `lib/store-publication.ts` is the gate, and this is
 * one of its two holds. So the failure that matters here is not a lost charge, it is a seller who
 * paid and whose shop stayed dark; every write below therefore ends by asking the gate to re-run.
 *
 * ── The rule about status, stated once ──
 * PayMe's `sub_status` is stored as their integer and interpreted in exactly one place
 * (`payment-payme.ts#PAYME_SUB_STATUS` / `subscriptionIsPaying`). A callback's claim about it is
 * never believed: `sub_callback_url` is a public address, so a notification is a hint that something
 * changed and the answer is fetched over a call we make with our own key.
 */
import { firstRow, isUuid, query } from './db.js';
import { getSellerById } from './seller-auth.js';
import { billedStoresFor, totalFeeAgorot, type StoreFeeLine } from './store-plan.js';
import {
  activePaymeCredentials, cancelSubscription as cancelAtPayme, generateSubscription,
  getSubscriptionStatus, PaymeError, PAYME_SUB_STATUS, setSubscriptionPrice, subscriptionIsPaying,
  type PaymeCredentials,
} from './payment-payme.js';
import { logError } from './error-log.js';
import { recordMoneyEvent } from './money-events.js';
import { formatAgorot } from './money.js';
import { businessDayISO } from './business-day.js';

/** What a caller may see. **No `buyer_key`** — it is a chargeable token, and the reason it is absent
 *  from this shape is the same one that keeps `callback_secret` off `MerchantAccount`: a secret on
 *  an object a dashboard renders is one `JSON.stringify` from a page. */
export interface SellerSubscription {
  sellerId: string;
  provider: string;
  /** PayMe's `sub_payme_id`, absent only while one has been asked for and not yet created. */
  providerRef?: string;
  /** What `priceAgorot` is made of — one line per store on the site (`store-plan.ts`). Since
   *  2026-08-24 a standing order bills a SET of stores, so there is no single tier that describes
   *  it; this is what a seller is shown when he asks why the figure is what it is. */
  storeFees: StoreFeeLine[];
  priceAgorot: number;
  /** PayMe's own number. Ask `subscriptionIsPaying`, never compare it to a literal. */
  status: number;
  startedAt?: string;
  /** PayMe's string for the next iteration, passed through unparsed. Display only. */
  nextCharge?: string;
  canceledAt?: string;
  /** Cancelled subscriptions only: the end of the period already paid for. Until it passes the
   *  seller keeps everything he bought — `sellerIsSubscribed` is still true and his shops stay on
   *  the site. `lib/subscription-lapse.ts` is what acts when it passes. */
  endsAt?: string;
}

interface SubRow {
  seller_id: string;
  provider: string;
  provider_ref: string | null;
  price_agorot: number;
  status: number;
  started_at: Date | string | null;
  next_charge: string | null;
  canceled_at: Date | string | null;
  ends_at: Date | string | null;
  store_fees: StoreFeeLine[] | string | null;
}

/** Every read names its columns, and `buyer_key` is not among them — see the interface above.
 *  `tier` is not among them either, and deliberately: it is the legacy one-plan-per-account column
 *  (see the migration), and a read that still selected it would invite a caller to trust it. */
const SUB_COLUMNS = 'seller_id, provider, provider_ref, price_agorot, status, started_at, next_charge, canceled_at, ends_at, store_fees';

const iso = (v: Date | string | null): string | undefined =>
  v === null ? undefined : v instanceof Date ? v.toISOString() : String(v);

/** `jsonb` arrives already parsed from `pg`, but a column that defaulted to a string literal in one
 *  migration and to real json in another is exactly the drift this guard is cheap insurance
 *  against — and a breakdown that throws would take down a page whose real subject is the price
 *  beside it. */
function toFeeLines(value: SubRow['store_fees']): StoreFeeLine[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as StoreFeeLine[]) : [];
  } catch { return []; }
}

function toSubscription(row: SubRow): SellerSubscription {
  const startedAt = iso(row.started_at);
  const canceledAt = iso(row.canceled_at);
  const endsAt = iso(row.ends_at);
  return {
    sellerId: row.seller_id,
    provider: row.provider,
    ...(row.provider_ref ? { providerRef: row.provider_ref } : {}),
    storeFees: toFeeLines(row.store_fees),
    priceAgorot: row.price_agorot,
    status: row.status,
    ...(startedAt ? { startedAt } : {}),
    ...(row.next_charge ? { nextCharge: row.next_charge } : {}),
    ...(canceledAt ? { canceledAt } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
}

/** What a cancelled seller is given when PayMe's next-charge date cannot be read — one month.
 *  Never zero: a string this platform failed to parse is our problem, and resolving it against the
 *  person who just paid us is the wrong direction. Thirty days rather than a calendar month because
 *  it is a fallback, not a billing rule, and it must not need a calendar to be correct. */
const PAID_PERIOD_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * PayMe's `sub_next_date` as a real moment.
 *
 * They return `'YYYY-MM-DD HH:MM:SS'` — measured 2026-08-24, `scripts/payme-probe.mjs
 * subscription`. That is not an ISO string (no `T`, no zone), and `new Date()` on it is
 * implementation-defined in exactly the way that produces an hours-off answer nobody notices; the
 * `T` and the local-time reading are explicit for that reason.
 *
 * Returns null for anything that does not parse, and the caller decides what that means.
 */
export function parsePaymeDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.trim().replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function subscriptionFor(sellerId: string): Promise<SellerSubscription | null> {
  if (!isUuid(sellerId)) return null;
  const row = await firstRow<SubRow>(`SELECT ${SUB_COLUMNS} FROM seller_subscriptions WHERE seller_id = $1`, [sellerId]);
  return row ? toSubscription(row) : null;
}

/**
 * Is this seller paying right now — the question the publication gate asks.
 *
 * **True when PayMe are not configured**, and that is the same shape `merchantBlockFor` uses: with
 * no gateway wired nobody can subscribe, so gating on a subscription would hold every store on the
 * platform dark in development and through the pre-gateway window GO_LIVE §7 plans. What guards THAT
 * window is `site-mode.ts`, which refuses to sell at all on a production server whose provider
 * cannot take money.
 */
export async function sellerIsSubscribed(
  sellerId: string,
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<boolean> {
  if (!creds) return true;
  const sub = await subscriptionFor(sellerId);
  if (!sub) return false;
  if (subscriptionIsPaying(sub.status)) return true;
  // **A cancelled subscription is still a paid one until the period he bought runs out**
  // (owner, 2026-08-24: cancellation takes effect *"בסוף התקופה ששולמה"*). Asking PayMe would
  // answer 'canceled' and take his shops down the same afternoon, for days he has already paid
  // for. `lib/subscription-lapse.ts` is what ends it when the date arrives.
  return !!sub.endsAt && new Date(sub.endsAt).getTime() > Date.now();
}

export type StartSubscriptionResult =
  /** Billing has begun. `subscription.status` says whether the first charge already went through,
   *  and `payUrl` is present when it has not — the page PayMe want the seller to enter a card on. */
  | { status: 'ok'; subscription: SellerSubscription; payUrl?: string }
  /** He already had one that is being paid — asking again must never open a second. */
  | { status: 'already'; subscription: SellerSubscription }
  /**
   * One was created for him and nobody has paid it yet.
   *
   * **This is the case that makes a second `generate-subscription` a real charge.** On the hosted
   * page route the subscription is created BEFORE anybody pays, so it sits `initial` — and
   * `subscriptionIsPaying` is correctly false for it. Treating that as "he has none" is how a seller
   * who pressed the button, closed PayMe's tab, and pressed it again ends up with two standing
   * arrangements against one card, only one of which we know about.
   */
  | { status: 'pending'; subscription: SellerSubscription; payUrl?: string }
  /** No gateway on this deployment. Dev, and the pre-gateway window. */
  | { status: 'not-configured' }
  /** We hold no merchant account of our own to collect into — `PAYME_DELIVERY_MERCHANT_ID`. An
   *  owner-side configuration gap, not anything the seller can fix. */
  | { status: 'no-collection-account' }
  /** Nothing to charge for: he has no shop on the site and named none to put there. Since the price
   *  is the sum of his stores' plans (`store-plan.ts`), a subscription with no store would be a
   *  ₪0 standing order — which PayMe refuse, and which would mean nothing anyway. */
  | { status: 'no-store-to-bill' }
  /** PayMe refused. The message is theirs, written for a merchant — never shown to a shopper. */
  | { status: 'failed'; error: string };

/**
 * Begin billing this seller.
 *
 * ── Two routes, and today only one of them is available to us ──
 * **With a `buyerKey`** — his card tokenised in the browser by Hosted Fields, exactly as in the
 * checkout — PayMe charge the first iteration immediately and server-to-server (measured:
 * `sub_paid: true`), so nobody is sent anywhere and the shop can go live in the same request.
 *
 * **Without one** PayMe return `sub_url`: their own page, where the seller types a card
 * (measured 2026-08-23: `sub_status: 1`, `sub_paid: false`, a real URL). ⚠️ **This is the route in
 * use, and not by choice.** Hosted Fields need the merchant's `seller_public_key`, and the merchant
 * here is OURS — `create-seller` returns that key exactly once and the account in §18 was opened
 * without storing it, so for this one account it is gone. The repair is to store it when the
 * production merchant is opened; `seller-merchant.ts`'s header carries the class.
 *
 * **Never throws**, for the same reason `ensureMerchantAccount` does not: it runs behind a button a
 * seller pressed, and an unhandled gateway error there is an error page in front of the one person
 * on this platform who is trying to start paying.
 */
export async function startSubscription(
  sellerId: string,
  input: { buyerKey?: string; callbackUrl?: string; returnUrl?: string; including?: string },
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<StartSubscriptionResult> {
  const existing = await subscriptionFor(sellerId);
  if (existing && subscriptionIsPaying(existing.status)) return { status: 'already', subscription: existing };
  if (!creds) return { status: 'not-configured' };
  if (!creds.ownMerchantId) return { status: 'no-collection-account' };

  // A subscription created and not yet paid is NOT "no subscription" — see the `pending` branch of
  // the result type. Asked of PayMe rather than of our stored status, because the seller may have
  // paid on their page since (their callback needs a public URL we do not have yet), and because it
  // is where the page's own URL comes from.
  if (existing?.providerRef && existing.status === PAYME_SUB_STATUS.initial) {
    const upstream = await getSubscriptionStatus(creds.ownMerchantId, existing.providerRef, creds).catch(() => null);
    if (upstream && subscriptionIsPaying(upstream.subStatus)) {
      await refreshSubscription(sellerId, creds);
      return { status: 'already', subscription: (await subscriptionFor(sellerId))! };
    }
    // Still unpaid — send him back to the same page. A cancelled or failed one falls through and a
    // new subscription is created, which is right: he has nothing standing.
    if (upstream && upstream.subStatus === PAYME_SUB_STATUS.initial) {
      return { status: 'pending', subscription: existing, ...(upstream.subUrl ? { payUrl: upstream.subUrl } : {}) };
    }
  }

  const seller = await getSellerById(sellerId);
  if (!seller) return { status: 'failed', error: 'seller not found' };

  /**
   * **The price is the sum of the stores he is putting on the site**, not one account-wide plan
   * (owner, 2026-08-24 — `store-plan.ts`). `including` is the shop being published in this very
   * request: it is not `published_at` yet, because being published is exactly what is being paid
   * for, so nothing can derive it and the caller says which one.
   *
   * An empty set is a real state and not an error — a seller with no shop ready has nothing to be
   * billed for, and creating a ₪0 standing order would be refused by PayMe anyway
   * (`PAYME_MIN_SALE_AGOROT`). It is answered before a single call goes out.
   */
  const storeFees = await billedStoresFor(sellerId, input.including);
  const priceAgorot = totalFeeAgorot(storeFees);
  if (!storeFees.length || priceAgorot <= 0) return { status: 'no-store-to-bill' };

  try {
    const created = await generateSubscription({
      ownMerchantId: creds.ownMerchantId,
      priceAgorot,
      description: `מנוי חודשי — ${seller.name}`.slice(0, 120),
      ...(input.buyerKey ? { buyerKey: input.buyerKey } : {}),
      // Our own id, echoed on every callback. The seller id itself rather than a random one: a
      // notification then names the seller it is about without our having to trust anything else in
      // a body anyone on the internet can POST.
      correlationId: sellerId,
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      buyerEmail: seller.email,
    }, creds);

    // Upsert, not insert: a seller whose previous subscription failed or was cancelled is starting a
    // new one, and the row is the standing arrangement rather than a history (see the migration).
    const row = await firstRow<SubRow>(
      `INSERT INTO seller_subscriptions (seller_id, provider, provider_ref, store_fees, price_agorot, status, buyer_key, started_at, next_charge)
       VALUES ($1, 'payme', $2, $3::jsonb, $4, $5, $6, now(), $7)
       ON CONFLICT (seller_id) DO UPDATE SET
         provider_ref = EXCLUDED.provider_ref, store_fees = EXCLUDED.store_fees, price_agorot = EXCLUDED.price_agorot,
         status = EXCLUDED.status, buyer_key = EXCLUDED.buyer_key, started_at = EXCLUDED.started_at,
         next_charge = EXCLUDED.next_charge, canceled_at = NULL, ends_at = NULL, updated_at = now()
       RETURNING ${SUB_COLUMNS}`,
      // `ends_at = NULL` on the conflict path with the same force as `canceled_at`: this row is the
      // standing arrangement, and a seller restarting after a cancellation must not inherit the
      // expiry date of the arrangement he replaced — that date would take his new shop down.
      [sellerId, created.subPaymeId, JSON.stringify(storeFees), priceAgorot, created.subStatus, input.buyerKey ?? null, created.nextDate ?? null],
    );
    if (!row) return { status: 'failed', error: 'subscription row not written' };

    // The journal is where every money fact of this platform lives, so a subscription charge is
    // comparable with PayMe's own record by `lib/reconcile.ts` rather than being the one stream
    // nobody wrote down.
    if (subscriptionIsPaying(created.subStatus)) {
      await recordMoneyEvent({
        type: 'payment_attempted',
        amountAgorot: priceAgorot,
        actor: 'system',
        detail: `מנוי חודשי · מוכר ${sellerId} · אסמכתה ${created.subPaymeId}`,
      }).catch(() => { /* a lost journal row must not undo a started subscription */ });
    }
    // The row exists either way — a subscription PayMe are waiting to be paid is a real standing
    // arrangement, and it is what `refreshSubscription` and the publication sweep look at when the
    // seller finishes on their page. `payUrl` is where he has to go; its absence means the first
    // charge already went through.
    return { status: 'ok', subscription: toSubscription(row), ...(created.subUrl ? { payUrl: created.subUrl } : {}) };
  } catch (err) {
    const message = err instanceof PaymeError ? err.message : err instanceof Error ? err.message : String(err);
    await logError({
      source: 'server',
      route: 'payme:generate-subscription',
      message: `could not start a subscription for seller ${sellerId}: ${message}`,
      actorRole: 'seller',
      actorId: sellerId,
      resolutionHint: 'מוכר ניסה להתחיל מנוי ו-PayMe סירבו. החנות שלו לא תעלה לאוויר עד שזה נפתר — הוא ממתין ולא עשה כלום רע.',
    }).catch(() => { /* nothing left to try */ });
    return { status: 'failed', error: message };
  }
}

/**
 * The seller's monthly charge changed — carry it to the standing order.
 *
 * ── What makes it change ──
 * Since 2026-08-24 the charge is the SUM of the plans of the stores he has on the site
 * (`store-plan.ts`), so three different acts land here: he moved one shop to another plan, he put
 * another shop on the site, or he closed one. All three are the same operation — recompute the sum
 * and patch it — which is why there is one function rather than three.
 *
 * ── The shape, ruled by the owner on 2026-08-24 ──
 * *"למה לבטל את המנוי? זה רק להחליף את ההוראת קבע שלו מפעם הבאה"*. So the subscription is PATCHED,
 * never cancelled and recreated: the card stays, the arrangement stays, only the amount moves, and
 * the seller is told it applies from the next charge. `payment-payme.ts#setSubscriptionPrice`
 * carries the measurement that says this works.
 *
 * ── The order is the point ──
 * **PayMe first, our row second.** If the patch fails there is nothing to undo and the seller is
 * still on the arrangement he is actually paying for — which is the honest state. Written the other
 * way round, a refusal from the gateway would leave our row promising one figure while the card is
 * charged another, with neither side reporting the gap. That was a real bug, found 2026-08-24: the
 * tier was written and PayMe were never told.
 *
 * Returns what the caller has to tell the seller:
 *   'not-paying'  — nothing standing at PayMe. Whatever the caller is about to write IS the whole
 *                   change, because the next subscription is generated from the stores at the time.
 *   'updated'     — the standing order now carries the new amount, from the next charge.
 *   'reset'       — an unpaid subscription was discarded; the next attempt creates one at the new
 *                   price.
 *   'failed'      — PayMe refused. **The caller must NOT write**, and must say so.
 */
export type PriceSync =
  | { status: 'not-paying' }
  | { status: 'updated'; priceAgorot: number; storeFees: StoreFeeLine[]; nextCharge?: string }
  /** An unpaid subscription was thrown away, so the next attempt creates one at the new price. */
  | { status: 'reset' }
  | { status: 'failed'; error: string };

export async function syncSubscriptionPrice(
  sellerId: string,
  /** The store being published in this request, if any — see `startSubscription`'s header. Absent
   *  for a plan change or a closure, where the billed set is fully derivable. */
  options: { including?: string } = {},
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<PriceSync> {
  const sub = await subscriptionFor(sellerId);
  // Nothing standing, or a cancelled one: the next subscription is generated from the stores at the
  // time (`startSubscription` reads them fresh), so there is nothing here to carry.
  if (!sub || !sub.providerRef) return { status: 'not-paying' };
  // No gateway configured is not a failure to report: nobody can be charged, so nothing can
  // diverge. It is the same shape `sellerIsSubscribed` takes for the same window.
  if (!creds?.ownMerchantId) return { status: 'not-paying' };

  /**
   * ── The unpaid subscription, which is the OTHER way the two sides drift apart ──
   *
   * A subscription PayMe created and nobody has paid (`initial`) carries the price it was created
   * with, and `startSubscription` deliberately sends a seller who closed the tab back to that SAME
   * page rather than opening a second one. So changing the charge in between would have him pay the
   * old amount on a page that outlived his decision, and land on a standing order whose price
   * disagrees with his shops from its very first charge.
   *
   * **It cannot be patched** — measured 2026-08-24 (`payme-probe.mjs set-price`): `set-price` on a
   * subscription in status `initial` is refused with *"עדכון מנוי נכשל"*, which matches their
   * documentation saying it applies to `active` (or to a TEMPLATE in initial, which ours never is).
   *
   * So it is thrown away, and that costs nothing: no card was charged and there is no standing
   * order yet. Cancelling an unpaid subscription was measured in the same run and accepted. The
   * next press of "start subscription" then creates a fresh one at the new price, because
   * `startSubscription` treats a cancelled row as nothing standing.
   */
  if (sub.status === PAYME_SUB_STATUS.initial) {
    try {
      await cancelAtPayme(creds.ownMerchantId, sub.providerRef, creds);
    } catch (err) {
      // Reported as a failure, so the caller does not write. The alternative is worse than it looks:
      // our row would say the new arrangement while PayMe's page — still live, still reachable from
      // the link he was sent — charges the old one, which is the same divergence one door along.
      const message = err instanceof PaymeError ? err.message : err instanceof Error ? err.message : String(err);
      await logError({
        source: 'server',
        route: 'payme:cancel-subscription',
        message: `could not discard seller ${sellerId}'s unpaid subscription ${sub.providerRef} on a price change: ${message}`,
        actorRole: 'seller',
        actorId: sellerId,
        resolutionHint: 'מוכר שינה מסלול או הוסיף חנות לפני ששילם, ו-PayMe סירבו לבטל את המנוי הישן שטרם שולם. השינוי לא נשמר — צריך לבטל אצלם ידנית ואז לתת לו לנסות שוב.',
      }).catch(() => { /* nothing left to try */ });
      return { status: 'failed', error: message };
    }
    await query(
      'UPDATE seller_subscriptions SET status = $2, canceled_at = now(), buyer_key = NULL, updated_at = now() WHERE seller_id = $1',
      [sellerId, PAYME_SUB_STATUS.canceled],
    );
    return { status: 'reset' };
  }

  // Anything that is neither paying nor waiting to be paid — cancelled, failed, completed — is
  // nothing standing, and there is nothing to carry.
  if (!subscriptionIsPaying(sub.status)) return { status: 'not-paying' };

  const storeFees = await billedStoresFor(sellerId, options.including);
  const priceAgorot = totalFeeAgorot(storeFees);

  /**
   * **A seller who closed his last shop is not "charged ₪0" — he is not charged.** PayMe have a
   * minimum and a ₪0 iteration is not a thing, so the standing order is cancelled outright rather
   * than patched to nothing. `endSubscription` is the whole of that act, including the paid period
   * he keeps; calling it here rather than reimplementing it is what stops the two paths disagreeing
   * about when his access ends.
   */
  if (priceAgorot <= 0) {
    const stopped = await endSubscription(sellerId, creds);
    return stopped ? { status: 'not-paying' } : { status: 'failed', error: 'could not stop an empty subscription' };
  }

  if (priceAgorot === sub.priceAgorot) {
    // Same money, and PayMe are already carrying it. Re-sending would be a request that cannot
    // change anything and can still fail. The BREAKDOWN is still written: the figure can be
    // unchanged while what makes it up is not — one shop moved up a plan and another down by the
    // same amount — and a breakdown that disagrees with the shops is what the seller reads.
    await query(
      'UPDATE seller_subscriptions SET store_fees = $2::jsonb, updated_at = now() WHERE seller_id = $1',
      [sellerId, JSON.stringify(storeFees)],
    );
    return { status: 'updated', priceAgorot, storeFees, ...(sub.nextCharge ? { nextCharge: sub.nextCharge } : {}) };
  }

  try {
    await setSubscriptionPrice(creds.ownMerchantId, sub.providerRef, priceAgorot, creds);
  } catch (err) {
    const message = err instanceof PaymeError ? err.message : err instanceof Error ? err.message : String(err);
    await logError({
      source: 'server',
      route: 'payme:set-price',
      message: `could not move seller ${sellerId} to ${priceAgorot} agorot: ${message}`,
      actorRole: 'seller',
      actorId: sellerId,
      resolutionHint: 'מוכר משלם ניסה לשנות מסלול או להעלות חנות נוספת ו-PayMe סירבו לעדכן את הסכום. השינוי לא נשמר — הוא ממשיך לשלם את הסכום הישן, ואין פער בין מה שרשום למה שנגבה.',
    }).catch(() => { /* nothing left to try */ });
    return { status: 'failed', error: message };
  }

  // Our copy of the arrangement, brought level with theirs in the same breath.
  await query(
    'UPDATE seller_subscriptions SET store_fees = $2::jsonb, price_agorot = $3, updated_at = now() WHERE seller_id = $1',
    [sellerId, JSON.stringify(storeFees), priceAgorot],
  );

  // The journal carries every money fact of this platform, and a monthly charge that silently
  // changed size is exactly the kind `lib/reconcile.ts` is later asked to explain.
  await recordMoneyEvent({
    type: 'payment_attempted',
    amountAgorot: priceAgorot,
    actor: 'seller',
    // Shekels, not agorot: this line is read by a person in the admin journal, and
    // `tests/money-guards.test.ts` refuses a raw agorot integer inside Hebrew copy — "12500" beside
    // a ₪125 plan is exactly the misreading that guard exists to stop.
    detail: `שינוי מנוי · מוכר ${sellerId} · ${formatAgorot(sub.priceAgorot)} → ${formatAgorot(priceAgorot)} · ${storeFees.length} חנויות · אסמכתה ${sub.providerRef}`,
  }).catch(() => { /* a lost journal row must not undo a change PayMe already accepted */ });

  return { status: 'updated', priceAgorot, storeFees, ...(sub.nextCharge ? { nextCharge: sub.nextCharge } : {}) };
}

/**
 * Stop billing — **at the end of the period he already paid for** (owner, 2026-08-24).
 *
 * ── The two dates, and why they are not one ──
 * `canceled_at` is when he pressed the button; `ends_at` is when the thing he bought runs out.
 * Collapsing them costs somebody real money in one direction or the other. Ending it on the press
 * takes back days he paid for — and takes them from the seller who is most worth keeping, the one
 * who is still paying. Having no end date at all is what this platform did until today: the card
 * stopped and the shop stayed on the site for ever, selling, with our commission still being taken
 * off sales nobody was subscribed for.
 *
 * `ends_at` comes from PayMe's `sub_next_date` — the iteration that would have been charged IS the
 * end of the paid month. A value that will not parse gives him a month rather than nothing: the
 * failure of a string format is not a reason to shorten what someone bought.
 *
 * ── The cancellation at PayMe is immediate, and that is not a contradiction ──
 * What he asked to stop is the CHARGING, and there is no way to say "one more month then stop" at
 * their end. So the standing order goes now — he will never be charged again, which is the
 * guarantee he actually pressed the button for — and `ends_at` is what keeps his side of it.
 *
 * ── It deliberately does NOT take the stores down ──
 * Neither now nor at `ends_at`: that is `lib/subscription-lapse.ts`, which runs on a timer and goes
 * through the lifecycle module. Un-publishing a live shop has a shopper mid-cart on the other side
 * of it and belongs to the module that owns the whole lifecycle, not to the one that happens to
 * have just cancelled a card.
 */
export async function endSubscription(
  sellerId: string,
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<boolean> {
  const sub = await subscriptionFor(sellerId);
  if (!sub) return false;
  if (creds?.ownMerchantId && sub.providerRef) {
    try {
      await cancelAtPayme(creds.ownMerchantId, sub.providerRef, creds);
    } catch (err) {
      // Their refusal is logged and the local row is still marked cancelled: the alternative is a
      // seller who pressed cancel, was told it failed, and has no other way to stop a recurring
      // charge. A subscription cancelled here and still live there is visible to the sweep below.
      await logError({
        source: 'server',
        route: 'payme:cancel-subscription',
        message: `PayMe refused to cancel subscription ${sub.providerRef} for seller ${sellerId}: ${err instanceof Error ? err.message : String(err)}`,
        actorRole: 'seller',
        actorId: sellerId,
        resolutionHint: 'מוכר ביטל מנוי ואצל PayMe הביטול לא עבר. ייתכן שימשיכו לחייב את הכרטיס שלו — צריך לבטל אצלם ידנית.',
      }).catch(() => { /* nothing left to try */ });
    }
  }
  // A month from now when PayMe's date will not parse — see the header. `endsAt` is also kept when
  // one is already recorded: pressing cancel twice must not move the date, in either direction.
  const paidUntil = sub.endsAt
    ? new Date(sub.endsAt)
    : parsePaymeDate(sub.nextCharge) ?? new Date(Date.now() + PAID_PERIOD_FALLBACK_MS);

  await query(
    `UPDATE seller_subscriptions
        SET status = $2, canceled_at = COALESCE(canceled_at, now()), ends_at = $3,
            buyer_key = NULL, updated_at = now()
      WHERE seller_id = $1`,
    [sellerId, PAYME_SUB_STATUS.canceled, paidUntil.toISOString()],
  );

  // The journal, because a subscription ending is a money fact: it is the last charge this seller
  // will ever make, and `reconcile.ts` comparing our record against PayMe's needs to know we meant
  // it rather than that a charge went missing.
  await recordMoneyEvent({
    type: 'payment_attempted',
    amountAgorot: 0,
    actor: 'seller',
    // The Israeli business calendar, not a UTC slice: this line is read by a person, and a paid-
    // until date that says the 31st to us and the 1st to him is the class `business-day.ts` exists
    // for (and `tests/money-guards.test.ts` refuses the slice outright).
    detail: `ביטול מנוי · מוכר ${sellerId} · שולם עד ${businessDayISO(paidUntil)} · אסמכתה ${sub.providerRef ?? '—'}`,
  }).catch(() => { /* a lost journal row must not undo a cancellation PayMe already accepted */ });
  return true;
}

/**
 * Re-read one subscription from PayMe and store what they say.
 *
 * The answer to every notification and the whole of the catch-up sweep. Returns the stored status
 * afterwards so a caller can act on it without a second read; `null` means there was nothing to
 * refresh, which is not the same as "cancelled" and must never be treated as one.
 */
export async function refreshSubscription(
  sellerId: string,
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<number | null> {
  const sub = await subscriptionFor(sellerId);
  if (!sub?.providerRef || !creds?.ownMerchantId) return sub?.status ?? null;
  let upstream: { subStatus: number; nextDate?: string } | null;
  try {
    upstream = await getSubscriptionStatus(creds.ownMerchantId, sub.providerRef, creds);
  } catch {
    // A lookup that failed is not a verdict. The stored status stands.
    return sub.status;
  }
  if (!upstream) return sub.status;
  if (upstream.subStatus === sub.status && (upstream.nextDate ?? null) === (sub.nextCharge ?? null)) return sub.status;
  await query(
    `UPDATE seller_subscriptions SET status = $2, next_charge = $3,
       canceled_at = CASE WHEN $2 = ${PAYME_SUB_STATUS.canceled} THEN COALESCE(canceled_at, now()) ELSE canceled_at END,
       updated_at = now()
     WHERE seller_id = $1`,
    [sellerId, upstream.subStatus, upstream.nextDate ?? null],
  );
  return upstream.subStatus;
}
