export const prerender = false;
import type { APIContext } from 'astro';
import { activePaymeCredentials, getSellerStatus, verifyCallbackSignature } from '../../../lib/payment-payme.js';
import { merchantAccountByProviderRef, merchantCallbackSecret, setMerchantApproval } from '../../../lib/seller-merchant.js';
import { syncStorePublication } from '../../../lib/store-publication.js';
import { recordMoneyEvent } from '../../../lib/money-events.js';
import { recordChargeback } from '../../../lib/payme-chargeback.js';
import { logError } from '../../../lib/error-log.js';
import { readFormBody, BODY_LIMIT } from '../../../lib/request-body.js';

/**
 * PayMe's server-to-server notifications.
 *
 * **Everything that arrives here is a claim by whoever sent the request.** The URL is public — it
 * has to be, PayMe reject a localhost callback URL — so this endpoint is reachable by anyone who
 * finds it, and every field in the body including `sale_status: completed` and
 * `seller_approved: 1` is worth exactly nothing until it is checked. That is the same rule as
 * `checkout-idempotency.ts#checkoutOwner` and `payment-hosted.ts#readReturn`, and the version of
 * this bug that ships is the handler that reads the status first.
 *
 * The two notification families are checked in DIFFERENT ways, and that difference is the whole
 * design of this file:
 *
 * · **Sale callbacks carry `payme_signature`** — MD5 over our client key, the seller's own callback
 *   secret and the two ids. So they can be verified from the body alone, and are.
 *
 * · **Seller callbacks carry no signature at all.** Their spec's attribute table for "Callback upon
 *   Seller creation or update" has no signature field, and there is no `payme_sale_id` to build one
 *   over. A handler that believed the body would let anyone on the internet flip `approved` to true
 *   and unblock any store on this platform. So the notification is treated as a HINT — "something
 *   about this merchant changed" — and the answer is fetched with `get-sellers`, over a call WE
 *   make with our own client key.
 *
 * ⚠️ **Signature verification is documented, not measured.** `docs/payme-sandbox-notes.md` says so
 * explicitly: no callback has been received end to end, because that needs a public URL. Everything
 * else in the adapter was verified against their live sandbox; this was not. So a mismatch is
 * logged loudly rather than shrugged off — if the formula turns out to be wrong, the symptom must
 * be an alert someone reads, never a quietly-accepted forgery.
 *
 * **This endpoint changes nothing about money.** A split charge completes synchronously inside
 * `generate-sale` (`lib/payment-split.ts`), so the order is already paid or already unwound by the
 * time a sale callback arrives. It is journalled as corroboration — an independent second record of
 * what PayMe think happened — and deliberately does not write an order status. Making it able to
 * would give a public URL the power to mark orders paid, which is the exact hole the signature is
 * the only thing standing in.
 */

/** PayMe always answer their own callbacks with a 200. Anything else and they retry, which for an
 *  unverifiable body means retrying something we deliberately refused. So a rejection is a 200 with
 *  a body that says so, and the LOG is where a refusal is visible. */
function ack(status: string): Response {
  return new Response(JSON.stringify({ received: status }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST({ request }: APIContext): Promise<Response> {
  const creds = activePaymeCredentials();
  // Nothing is configured, so nothing here can be genuine. Not an error — this is dev, where the
  // route exists and answers politely rather than 404-ing and looking like a deploy problem.
  if (!creds) return ack('not-configured');

  // `x-www-form-urlencoded`, their format, not JSON. Through `readFormBody`, which counts the bytes
  // off the stream rather than trusting `Content-Length` — this was written as
  // `await request.text()` with a length check afterwards, which is the exact shape that module's
  // header exists to name: the body is fully buffered BEFORE the check, so on a public endpoint the
  // cap protects against a large body sent honestly and against nothing else.
  const read = await readFormBody(request, BODY_LIMIT.form);
  if (!read.ok) return ack('too-large');
  const body = read.value;
  const notifyType = body.get('notify_type') ?? '';

  if (notifyType.startsWith('seller-')) return handleSellerNotification(body);
  if (notifyType.startsWith('sale-') || notifyType === 'refund') return handleSaleNotification(body);
  // An unrecognised type is LOUD, not clean. The same reasoning as
  // `project_merchant_status_monitor`: an answer nobody has met means either PayMe added something
  // or somebody is probing the endpoint, and both are worth a person seeing.
  await logError({
    source: 'server',
    route: '/api/payme/callback',
    message: `unrecognised PayMe notify_type '${notifyType.slice(0, 60)}'`,
    resolutionHint: 'PayMe שלחו סוג התראה שהקוד לא מכיר — או שהוסיפו סוג חדש, או שמישהו מגשש בכתובת. שווה לקרוא את היומן.',
  }).catch(() => { /* the ack below is the only thing PayMe need */ });
  return ack('ignored');
}

/**
 * A merchant was created or updated — so go and ask what is actually true.
 *
 * Nothing from the body is written. `seller_payme_id` is used only to find WHICH merchant to
 * re-read, which is an identifier doing an identifier's job; the approval that gets stored comes
 * from `get-sellers`, over our own authenticated call.
 */
async function handleSellerNotification(body: URLSearchParams): Promise<Response> {
  const creds = activePaymeCredentials()!;
  const providerRef = body.get('seller_payme_id') ?? '';
  if (!providerRef) return ack('no-seller-id');

  const account = await merchantAccountByProviderRef(providerRef);
  // A merchant we have never heard of. The sandbox is shared with PayMe's other partners
  // (`§3.1.1`), so this is an ordinary occurrence there and not evidence of anything.
  if (!account) return ack('unknown-seller');

  try {
    const status = await getSellerStatus(providerRef, creds);
    // Null means PayMe do not know him, which is NOT "not approved" — writing `false` here would
    // turn a failed lookup into a verdict that closes a working seller's shop.
    if (!status) return ack('seller-not-found-upstream');
    if (status.approved !== account.approved) {
      // `active` is folded in: an approved-but-deactivated merchant cannot take money either, and
      // treating that as "may sell" would produce a refused charge mid-checkout instead of a store
      // that says why.
      await setMerchantApproval(providerRef, status.approved && status.active);
    }
    // **This is what puts the shop on the site.** A seller who built his store and started paying
    // has been waiting on PayMe's examination — up to seven business days he can do nothing about —
    // and this notification is the moment it ends. Publishing is derived from both holds rather than
    // from this one fact (`store-publication.ts`), so an approval arriving before the subscription
    // correctly changes nothing, and it is idempotent because PayMe may deliver the same
    // notification twice.
    //
    // Awaited but never allowed to fail the acknowledgement: PayMe retry anything that is not a 200,
    // and a retry would re-run a publication that already happened rather than fixing anything.
    const published = await syncStorePublication(account.sellerId).catch(() => [] as string[]);
    return ack(published.length ? 'seller-updated-published' : 'seller-updated');
  } catch (err) {
    await logError({
      source: 'server',
      route: '/api/payme/callback',
      message: `could not re-read PayMe merchant ${providerRef}: ${err instanceof Error ? err.message : String(err)}`,
      actorRole: 'seller',
      actorId: account.sellerId,
      resolutionHint: 'PayMe הודיעו על שינוי בחשבון הסליקה של מוכר ולא הצלחנו לאמת מולם מה השתנה. הסטטוס אצלנו נשאר כפי שהיה — אם המוכר טוען שאושר והחנות עדיין חסומה, זו הסיבה.',
    }).catch(() => { /* nothing left to try */ });
    return ack('lookup-failed');
  }
}

/**
 * A sale completed, failed, was refunded or was charged back.
 *
 * Verified against the signature and then JOURNALLED — never applied to an order. See the module
 * header: the charge already completed synchronously, so this is corroboration, and letting a
 * public URL move an order's payment status would make the signature the only thing between a
 * stranger and a free purchase.
 */
async function handleSaleNotification(body: URLSearchParams): Promise<Response> {
  const creds = activePaymeCredentials()!;
  const paymeSaleId = body.get('payme_sale_id') ?? '';
  const paymeTransactionId = body.get('payme_transaction_id') ?? '';
  const signature = body.get('payme_signature') ?? '';
  // The seller whose account the sale ran on. Their spec does not put `seller_payme_id` on the sale
  // callback's attribute table, so `transaction_id` — our own reference, `<checkoutRef>-<slug>` or
  // `<checkoutRef>-shipping` — is what we have. It is not enough to find the SECRET, which is
  // per-seller, so the seller is resolved the only reliable way there is: by asking which of our
  // merchants the callback names.
  const providerRef = body.get('seller_payme_id') ?? '';
  const account = providerRef ? await merchantAccountByProviderRef(providerRef) : null;
  const secret = account ? await merchantCallbackSecret(account.sellerId) : null;

  if (!secret || !verifyCallbackSignature({
    clientKey: creds.clientKey,
    sellerSecret: secret,
    paymeTransactionId,
    paymeSaleId,
    signature,
  })) {
    // Loud, and this is the case the ⚠️ in the module header is about. Two very different things
    // land here — a forged callback, and a correct callback whose signature we compute wrongly
    // because the formula was read and never measured — and only a person looking at the log can
    // tell them apart. Refusing is right either way: accepting an unverifiable money notification
    // is the one mistake that cannot be walked back.
    await logError({
      source: 'server',
      route: '/api/payme/callback',
      message: `PayMe sale callback failed signature verification (sale=${paymeSaleId.slice(0, 40)} seller=${providerRef.slice(0, 40)} secret=${secret ? 'present' : 'MISSING'})`,
      statusCode: 401,
      resolutionHint: 'התראת מכירה מ-PayMe נדחתה כי החתימה לא תואמת. שתי אפשרויות: מישהו זר שולח לכתובת הזאת, או שנוסחת החתימה שלנו שגויה — היא נקראה בתיעוד ומעולם לא נמדדה מול קולבק אמיתי (docs/payme-sandbox-notes.md). אם זה קורה לכל הקולבקים, זו הנוסחה.',
    }).catch(() => { /* nothing left to try */ });
    return ack('bad-signature');
  }

  const price = Number(body.get('price') ?? 0);
  const saleStatus = body.get('sale_status') ?? '';
  const notifyType = body.get('notify_type') ?? '';
  const amountAgorot = Number.isFinite(price) && price > 0 ? Math.round(price) : 0;

  // ── A dispute is not corroboration, and it was being filed as some ──────────────────────────
  // `sale-chargeback` matched `startsWith('sale-')` and fell through to the journal line below,
  // which writes `payment_attempted`: a row whose TYPE said a payment had been attempted, for an
  // event that is a payment being TAKEN BACK. The order went on counting, the seller was never
  // told, and the only trace contradicted what had happened (owner, 2026-08-25: *"מה קורה בעת
  // הכחשת עסקה?"* — and the honest answer was "almost nothing").
  //
  // Handled BEFORE the generic journal write and returning, so a dispute produces exactly one row,
  // of the right type. `payme-chargeback.ts` owns what happens and, more importantly, what
  // deliberately does not: it never moves the order's status, because a chargeback is not a
  // cancellation and that decision has a person in it.
  if (notifyType === 'sale-chargeback' || notifyType === 'sale-chargeback-refund') {
    const { orderId } = await recordChargeback({
      transactionId: body.get('transaction_id') ?? '',
      paymeSaleId,
      amountAgorot,
      kind: notifyType === 'sale-chargeback' ? 'chargeback' : 'chargeback_reverted',
    }).catch(() => ({ orderId: null }));
    return ack(orderId ? 'chargeback-recorded' : 'chargeback-unmatched');
  }
  // The journal is the independent record a reconciliation compares against the order tables
  // (`lib/reconcile.ts`), which is exactly what a second source is for — so a corroboration that
  // disagrees with our own rows becomes visible instead of being the thing nobody wrote down.
  await recordMoneyEvent({
    type: notifyType === 'refund' ? 'refund_settled' : 'payment_attempted',
    ...(amountAgorot > 0 ? { amountAgorot } : {}),
    actor: 'system',
    detail: `PayMe · ${notifyType} · ${saleStatus || '—'} · אסמכתה ${paymeSaleId}`,
  }).catch(() => { /* PayMe still get their 200; a lost journal row is not a lost sale */ });

  return ack('sale-recorded');
}
