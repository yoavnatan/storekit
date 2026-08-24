/**
 * The card a seller puts on file while PayMe are still reviewing his business — and the thing that
 * charges it, by itself, the moment they approve.
 *
 * ── The gap this closes (owner, 2026-08-24) ──
 * *"אם מוכר ממתין לאישור מפיימי והוא עוד לא בחר מסלול או שילם, אז יכול להיות שעד שהוא כבר יקבל את
 * האישור בדרך הוא מצא כבר חלופה אחרת ולא ימשיך איתנו."*
 *
 * Earlier the same day paying was moved to the END of the flow, so that nobody is charged through a
 * seven-day review for a shop that is not on the site. That was right about the charge and wrong
 * about the commitment: it left the longest wait in the flow as the one stretch where the seller has
 * decided nothing and owes nothing — a week whose only thing keeping him is that he has not yet
 * found somebody else.
 *
 * So the DECISION moves early and the MONEY stays late. He picks a plan and puts a card on file
 * during the review; the first charge fires when the shop actually goes up. Both of the owner's
 * concerns are answered by the same change, which is the sign it is the right one — he is not
 * paying for a dark shop, and he is not uncommitted through the only long wait we have.
 *
 * ── And he never has to come back ──
 * The charge is ours to make, not his to remember. That is the zero-touch rule
 * (AI_INSTRUCTIONS → Business model) and it is also the whole point: a flow that ends in "come back
 * in a week and press pay" has simply moved the abandonment to a different day.
 *
 * ── Why the card can be typed on our page at all ──
 * PayMe's Hosted Fields need a merchant's PUBLIC key, and the merchant here is OURS. The account in
 * §18 was opened without storing it and could never draw a field again; a second one was opened on
 * 2026-08-24 keeping what it hands back (`docs/payme-sandbox-notes.md` §24), which is what makes
 * this file possible. With no key configured the whole thing degrades to PayMe's own payment page —
 * `startSubscription`'s existing route — and nothing here is reached.
 */
import { firstRow, isUuid, query } from './db.js';
import { activePaymeCredentials, type PaymeCredentials } from './payment-payme.js';
import { billedStoresFor, totalFeeAgorot } from './store-plan.js';
import { merchantBlockFor } from './seller-merchant.js';
import { startSubscription, subscriptionArmed, subscriptionFor } from './seller-subscription.js';
import { syncStorePublication } from './store-publication.js';
import { logError } from './error-log.js';

export type ArmResult =
  /** The card is on file and what it will be charged is recorded. */
  | { status: 'armed'; priceAgorot: number }
  /** He is already being billed — there is nothing to arm, and re-arming would replace a working
   *  card with one that has not been proved. */
  | { status: 'already' }
  /** No shop of his is ready to go on the site, so there is no amount to name. */
  | { status: 'no-store-to-bill' }
  | { status: 'not-configured' };

/**
 * Record the seller's card and what it will be charged when the shop goes live.
 *
 * **It calls PayMe with nothing**, and that is the whole design: `generate-subscription` charges the
 * first iteration immediately when it is handed a card token (measured — `sub_paid: true`), so
 * creating the subscription here would charge for the review week this change exists to stop
 * charging for. Nothing is created at their end until `startArmedSubscription` runs.
 *
 * The price is stored beside the token so the seller can be SHOWN what he has agreed to before it
 * happens, rather than meeting the figure for the first time on a card statement.
 */
export async function armSubscriptionCard(
  sellerId: string,
  buyerKey: string,
  options: { including?: string } = {},
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<ArmResult> {
  if (!creds?.ownMerchantId) return { status: 'not-configured' };
  const existing = await subscriptionFor(sellerId);
  // A running subscription already has a card PayMe are successfully charging. Replacing it from
  // this path would swap a proven card for an unproven one on a seller who is paying us today.
  if (existing?.providerRef && existing.status !== null) return { status: 'already' };

  const storeFees = await billedStoresFor(sellerId, options.including);
  const priceAgorot = totalFeeAgorot(storeFees);
  if (!storeFees.length || priceAgorot <= 0) return { status: 'no-store-to-bill' };

  await query(
    `INSERT INTO seller_subscriptions (seller_id, provider, provider_ref, store_fees, price_agorot, status, buyer_key, card_saved_at)
     VALUES ($1, 'payme', NULL, $2::jsonb, $3, NULL, $4, now())
     ON CONFLICT (seller_id) DO UPDATE SET
       provider_ref = NULL, store_fees = EXCLUDED.store_fees, price_agorot = EXCLUDED.price_agorot,
       status = NULL, buyer_key = EXCLUDED.buyer_key, card_saved_at = now(),
       canceled_at = NULL, ends_at = NULL, next_charge = NULL, updated_at = now()`,
    [sellerId, JSON.stringify(storeFees), priceAgorot, buyerKey],
  );
  return { status: 'armed', priceAgorot };
}

/**
 * The token itself — **the one read in this codebase that selects `buyer_key`**.
 *
 * Everything else names its columns precisely to keep a chargeable token off any object a page
 * could render (`seller-subscription.ts`'s `SUB_COLUMNS`). This function exists so that rule has
 * exactly one documented exception instead of a second read growing quietly beside it: it returns
 * the bare string, to one caller, on the server, and nothing it returns is ever part of a response.
 */
async function armedBuyerKey(sellerId: string): Promise<string | null> {
  if (!isUuid(sellerId)) return null;
  const row = await firstRow<{ buyer_key: string | null }>(
    'SELECT buyer_key FROM seller_subscriptions WHERE seller_id = $1 AND provider_ref IS NULL AND card_saved_at IS NOT NULL',
    [sellerId],
  );
  return row?.buyer_key ?? null;
}

/**
 * Approval has landed and a card is waiting — charge it and put the shop up.
 *
 * Returns the slugs that went live, so a caller can say something true rather than "done". Never
 * throws: it runs inside a sweep over every waiting seller, and one refused card must not stop the
 * rest of the platform going live.
 *
 * **Ordering is not negotiable.** Clearing is re-asked from its own source first, because this is
 * the one function that spends a seller's money without him being present: charging a card on an
 * approval that has since been withdrawn is money taken for a shop that still cannot sell.
 */
export async function startArmedSubscription(
  sellerId: string,
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<string[]> {
  if (!creds?.ownMerchantId) return [];
  const sub = await subscriptionFor(sellerId);
  if (!subscriptionArmed(sub)) return [];

  // Asked of `merchantBlockFor` rather than of anything stored here, so this cannot disagree with
  // the gate that decides whether his shop may sell at all.
  if (await merchantBlockFor(sellerId, creds)) return [];

  const buyerKey = await armedBuyerKey(sellerId);
  if (!buyerKey) return [];

  const started = await startSubscription(sellerId, { buyerKey }, creds);
  if (started.status === 'failed') {
    // Loud, and written where a person will read it: the seller is waiting, he has done everything
    // asked of him, and the only visible symptom would be a shop that stays dark.
    await logError({
      source: 'server',
      route: 'payme:generate-subscription',
      message: `armed card refused for seller ${sellerId}: ${started.error}`,
      actorRole: 'seller',
      actorId: sellerId,
      resolutionHint: 'מוכר שם כרטיס מראש, חברת הסליקה אישרה אותו, והחיוב הראשון נדחה. החנות שלו לא תעלה עד שזה נפתר — הוא ממתין ולא עשה כלום רע.',
    }).catch(() => { /* nothing left to try */ });
    return [];
  }
  if (started.status !== 'ok') return [];

  return syncStorePublication(sellerId, creds);
}
