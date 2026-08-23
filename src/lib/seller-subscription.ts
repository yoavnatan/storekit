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
import { DEFAULT_TIER, monthlyFeeForTier, type SellerTierId } from './pricing.js';
import {
  activePaymeCredentials, cancelSubscription as cancelAtPayme, generateSubscription,
  getSubscriptionStatus, PaymeError, PAYME_SUB_STATUS, subscriptionIsPaying,
  type PaymeCredentials,
} from './payment-payme.js';
import { logError } from './error-log.js';
import { recordMoneyEvent } from './money-events.js';
import { toAgorot } from './money.js';

/** What a caller may see. **No `buyer_key`** — it is a chargeable token, and the reason it is absent
 *  from this shape is the same one that keeps `callback_secret` off `MerchantAccount`: a secret on
 *  an object a dashboard renders is one `JSON.stringify` from a page. */
export interface SellerSubscription {
  sellerId: string;
  provider: string;
  /** PayMe's `sub_payme_id`, absent only while one has been asked for and not yet created. */
  providerRef?: string;
  tier: SellerTierId;
  priceAgorot: number;
  /** PayMe's own number. Ask `subscriptionIsPaying`, never compare it to a literal. */
  status: number;
  startedAt?: string;
  /** PayMe's string for the next iteration, passed through unparsed. Display only. */
  nextCharge?: string;
  canceledAt?: string;
}

interface SubRow {
  seller_id: string;
  provider: string;
  provider_ref: string | null;
  tier: string;
  price_agorot: number;
  status: number;
  started_at: Date | string | null;
  next_charge: string | null;
  canceled_at: Date | string | null;
}

/** Every read names its columns, and `buyer_key` is not among them — see the interface above. */
const SUB_COLUMNS = 'seller_id, provider, provider_ref, tier, price_agorot, status, started_at, next_charge, canceled_at';

const iso = (v: Date | string | null): string | undefined =>
  v === null ? undefined : v instanceof Date ? v.toISOString() : String(v);

function toSubscription(row: SubRow): SellerSubscription {
  const startedAt = iso(row.started_at);
  const canceledAt = iso(row.canceled_at);
  return {
    sellerId: row.seller_id,
    provider: row.provider,
    ...(row.provider_ref ? { providerRef: row.provider_ref } : {}),
    tier: row.tier as SellerTierId,
    priceAgorot: row.price_agorot,
    status: row.status,
    ...(startedAt ? { startedAt } : {}),
    ...(row.next_charge ? { nextCharge: row.next_charge } : {}),
    ...(canceledAt ? { canceledAt } : {}),
  };
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
  return !!sub && subscriptionIsPaying(sub.status);
}

export type StartSubscriptionResult =
  /** Billing has begun. `subscription.status` says whether the first charge already went through. */
  | { status: 'ok'; subscription: SellerSubscription }
  /** He already had one that is being paid — asking again must never open a second. */
  | { status: 'already'; subscription: SellerSubscription }
  /** No gateway on this deployment. Dev, and the pre-gateway window. */
  | { status: 'not-configured' }
  /** We hold no merchant account of our own to collect into — `PAYME_DELIVERY_MERCHANT_ID`. An
   *  owner-side configuration gap, not anything the seller can fix. */
  | { status: 'no-collection-account' }
  /** PayMe refused. The message is theirs, written for a merchant — never shown to a shopper. */
  | { status: 'failed'; error: string };

/**
 * Begin billing this seller.
 *
 * `buyerKey` is his card, already tokenised in the browser by Hosted Fields — **no card number
 * reaches this process**, exactly as in the checkout. With a token PayMe charge the first iteration
 * immediately and server-to-server (measured: the response comes back `sub_paid: true`), so there is
 * no page to send anyone to and the seller's shop can go live in the same request.
 *
 * **Never throws**, for the same reason `ensureMerchantAccount` does not: it runs behind a button a
 * seller pressed, and an unhandled gateway error there is an error page in front of the one person
 * on this platform who is trying to start paying.
 */
export async function startSubscription(
  sellerId: string,
  input: { buyerKey: string; callbackUrl?: string },
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<StartSubscriptionResult> {
  const existing = await subscriptionFor(sellerId);
  if (existing && subscriptionIsPaying(existing.status)) return { status: 'already', subscription: existing };
  if (!creds) return { status: 'not-configured' };
  if (!creds.ownMerchantId) return { status: 'no-collection-account' };

  const seller = await getSellerById(sellerId);
  if (!seller) return { status: 'failed', error: 'seller not found' };

  const tier = seller.tier ?? DEFAULT_TIER;
  const priceAgorot = toAgorot(monthlyFeeForTier(tier));

  try {
    const created = await generateSubscription({
      ownMerchantId: creds.ownMerchantId,
      priceAgorot,
      description: `מנוי חודשי — ${seller.name}`.slice(0, 120),
      buyerKey: input.buyerKey,
      // Our own id, echoed on every callback. The seller id itself rather than a random one: a
      // notification then names the seller it is about without our having to trust anything else in
      // a body anyone on the internet can POST.
      correlationId: sellerId,
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
      buyerEmail: seller.email,
    }, creds);

    // Upsert, not insert: a seller whose previous subscription failed or was cancelled is starting a
    // new one, and the row is the standing arrangement rather than a history (see the migration).
    const row = await firstRow<SubRow>(
      `INSERT INTO seller_subscriptions (seller_id, provider, provider_ref, tier, price_agorot, status, buyer_key, started_at, next_charge)
       VALUES ($1, 'payme', $2, $3, $4, $5, $6, now(), $7)
       ON CONFLICT (seller_id) DO UPDATE SET
         provider_ref = EXCLUDED.provider_ref, tier = EXCLUDED.tier, price_agorot = EXCLUDED.price_agorot,
         status = EXCLUDED.status, buyer_key = EXCLUDED.buyer_key, started_at = EXCLUDED.started_at,
         next_charge = EXCLUDED.next_charge, canceled_at = NULL, updated_at = now()
       RETURNING ${SUB_COLUMNS}`,
      [sellerId, created.subPaymeId, tier, priceAgorot, created.subStatus, input.buyerKey, created.nextDate ?? null],
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
    return { status: 'ok', subscription: toSubscription(row) };
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
 * Stop billing.
 *
 * Deliberately does NOT take the stores down. Publication is re-derived by
 * `store-publication.ts#syncStorePublication`, which the caller runs — un-publishing a live shop is
 * a decision with consequences for a shopper mid-cart, and it belongs to the module that owns the
 * whole lifecycle rather than to the one that happens to have just cancelled a card.
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
  await query(
    'UPDATE seller_subscriptions SET status = $2, canceled_at = now(), buyer_key = NULL, updated_at = now() WHERE seller_id = $1',
    [sellerId, PAYME_SUB_STATUS.canceled],
  );
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
