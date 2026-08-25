#!/usr/bin/env node
/**
 * Ask PayMe's sandbox a question, instead of guessing at the answer.
 *
 * **This exists because every wrong turn in this integration came from reasoning where a call would
 * have answered.** Multi-capture was recorded as unavailable (wrong endpoint). The fixed-fee field
 * was recorded under PayMe's conversational name (silently ignored). Two of three incorporation
 * codes were wrong. A ceiling was argued about in both directions on one day. Each took minutes to
 * settle with a real request, and each had cost a session before anyone made one.
 *
 *   node scripts/payme-probe.mjs exists <endpoint>     does it exist, and what does it want first
 *   node scripts/payme-probe.mjs sellers               our merchants, and their approval state
 *   node scripts/payme-probe.mjs sale <sale-id>        one sale read back, with its real fee split
 *   node scripts/payme-probe.mjs flow                  the whole checkout, end to end, on test cards
 *   node scripts/payme-probe.mjs subscription          the SELLER's monthly fee, created and cancelled
 *   node scripts/payme-probe.mjs set-price             WHICH price a charge after a plan change uses
 *   node scripts/payme-probe.mjs withdrawals [MPL]     what PayMe owe a seller, and what they paid
 *   node scripts/payme-probe.mjs vas [MPL]             which add-on services a merchant really has
 *
 * **Sandbox only, and it refuses to run against anything else.** The sandbox is shared with PayMe's
 * other partners and has no delete, so this creates SALES freely and merchants never
 * (`docs/payme-sandbox-notes.md`). The client key is redacted out of everything it prints.
 */
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const KEY = env.PAYME_CLIENT_KEY;
const BASE = env.PAYME_BASE_URL || 'https://sandbox.payme.io/api/';
const DELIVERY = env.PAYME_DELIVERY_MERCHANT_ID;

if (!KEY) { console.error('no PAYME_CLIENT_KEY in .env'); process.exit(1); }
if (!BASE.includes('sandbox')) { console.error('REFUSING: this is not the sandbox'); process.exit(1); }

/** Their two test merchants. Do not create more — there is no delete, and the environment is shared. */
const SELLER_A = 'MPL17873-13741TOF-ET7YURJJ-DOZ4LSGO';
const SELLER_B = 'MPL17873-13773IVT-PXWKVCT1-QAW9P2LJ';

const redact = (s) => String(s).split(KEY).join('«CLIENT_KEY»');

async function call(endpoint, body = {}) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payme_client_key: KEY, ...body }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status_code: -1, status_error_details: `non-JSON (HTTP ${res.status})` }; }
}

/**
 * The one endpoint here that is not a POST to `{BASE}{endpoint}`: updating a running
 * subscription's price is `PATCH /api/subscriptions/{sub_id}/set-price`, with the id in the PATH.
 * Written out rather than folded into `call` because that shape is the question — a body-only
 * client would have to guess where the id goes.
 */
async function patchPrice(subId, body) {
  const res = await fetch(`${BASE}subscriptions/${encodeURIComponent(subId)}/set-price`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return { http: res.status, ...JSON.parse(text) }; }
  catch { return { http: res.status, status_code: -1, status_error_details: `non-JSON (HTTP ${res.status})` }; }
}

const ok = (r) => r.status_code === 0;
function say(label, r, extra = '') {
  console.log(label.padEnd(44), ok(r)
    ? `OK ${r.sale_status ?? r.payme_sale_status ?? ''} ${extra}`.trim()
    : `REFUSED · ${redact(r.status_error_details)} (${r.status_error_code}) ${r.status_additional_info ?? ''}`);
}

const [mode, arg] = process.argv.slice(2);

if (mode === 'exists') {
  // Their API walks you through its own required set, one error at a time, creating nothing:
  // "Required parameter is missing" plus a field name means the endpoint EXISTS.
  const r = await call(arg);
  console.log(redact(JSON.stringify(r, null, 2)));

} else if (mode === 'sellers') {
  for (const id of [SELLER_A, SELLER_B, DELIVERY].filter(Boolean)) {
    const r = await call('get-sellers', { seller_payme_id: id });
    // Matched by id, never items[0]: `get-sales` was measured ignoring its filter entirely, and
    // neither endpoint may be assumed to behave like the other.
    const found = (r.items ?? []).find((i) => i.seller_payme_id === id);
    console.log(id, found ? `approved=${found.seller_approved} active=${found.seller_active}` : 'NOT FOUND');
  }

} else if (mode === 'sale') {
  const r = await call('get-sales', { seller_payme_id: SELLER_A, payme_sale_id: arg });
  // ⚠️ Their id field is `sale_payme_id` here and `payme_sale_id` on generate-sale. Same value.
  const found = (r.items ?? []).find((i) => i.sale_payme_id === arg);
  console.log(found ? redact(JSON.stringify({ price: found.sale_price, status: found.sale_status, fees: found.sale_fees }, null, 2)) : `not among ${r.items?.length ?? 0} items`);

} else if (mode === 'withdrawals') {
  // The seller's own money, as PayMe hold it — what `/api/seller/transfers` shows him
  // (`lib/seller-transfers.ts`). Read-only: `withdraw-balance` is deliberately never called from
  // anywhere, including here, because it MOVES money and costs the seller a fee.
  const id = arg || SELLER_A;
  const future = await call('get-future-withdrawals', { seller_payme_id: id, currency: 'ILS' });
  // ⚠️ `total` is agorot and arrives as a STRING on a row with money, the number 0 on an empty one.
  console.log('future  ', (future.items ?? []).map((i) => `${i.created_at} · ${i.total} · window_end ${i.end_time}`).join('\n         ') || 'none');
  console.log('pending ', (future.items ?? []).reduce((n, i) => n + Number(i.total || 0), 0), 'agorot');
  const past = await call('get-withdrawals', { seller_payme_id: id, page_size: 10, page: 1, language: 'he' });
  console.log('past    ', (past.items ?? []).map((i) => `${i.withdrawal_created} · ${i.withdrawal_total} · ${i.withdrawal_description}`).join('\n         ') || `none (items_count ${past.items_count})`);

} else if (mode === 'vas') {
  // Which add-on services a merchant actually has. This is the call that settled whether we can
  // switch a seller's INVOICING module on ourselves (§26 in the sandbox notes): `vas-enable` needs
  // a `vas_payme_id`, i.e. it activates a service that already exists on that seller — so if
  // `Invoice` is not in this list, no request of ours can put it there.
  const r = await call('get-vas-seller', { seller_payme_id: arg || SELLER_A });
  for (const v of r.items ?? []) console.log(`${v.vas_is_active ? '●' : '○'} ${String(v.vas_type).padEnd(26)} ${v.vas_description}`);
  console.log(`— ${r.items_count} services · Invoice present: ${(r.items ?? []).some((v) => /invoic/i.test(String(v.vas_type)))}`);

} else if (mode === 'flow') {
  // The whole checkout, exactly as `lib/payment-split.ts` performs it.
  const tok = await call('capture-buyer-token', {
    seller_payme_id: SELLER_A, buyer_is_permanent: true,          // permanent, or store two fails
    credit_card_number: '12312312', credit_card_exp: '1230', credit_card_cvv: '123',
    buyer_name: 'Probe', buyer_email: 'random@paymeservice.com',
    buyer_phone: '0500000001', buyer_social_id: '9999999999',
  });
  say('token', tok);
  if (!ok(tok)) process.exit(1);

  // ONE authorization for the whole cart: ₪60 + ₪60 of goods, ₪30 of delivery.
  const auth = await call('generate-sale', {
    seller_payme_id: SELLER_A, sale_price: 15000, currency: 'ILS',
    product_name: 'probe cart', installments: 1,
    sale_type: 'authorize', market_fee: 0, buyer_key: tok.buyer_key,
  });
  say('authorize ₪150', auth, auth.payme_sale_id ?? '');
  if (!ok(auth)) process.exit(1);

  const capture = (seller, agorot, name, fee) => call('generate-sale', {
    seller_payme_id: seller, sale_price: agorot, currency: 'ILS',
    product_name: name, installments: 1,
    sale_type: 'multi-capture', origin_sale_id: auth.payme_sale_id, market_fee: fee,
  });
  say('  capture ₪60 → seller A', await capture(SELLER_A, 6000, 'goods A', 12));
  say('  capture ₪60 → seller B', await capture(SELLER_B, 6000, 'goods B', 10));
  if (DELIVERY) say('  capture ₪30 → our delivery merchant', await capture(DELIVERY, 3000, 'משלוח', 0));
  else console.log('  (no PAYME_DELIVERY_MERCHANT_ID — the delivery leg cannot be probed)');

} else if (mode === 'subscription') {
  // How the SELLER's monthly fee is collected — the one thing a seller owes us that has a
  // collection path (`docs/payme-sandbox-notes.md` §16). The money runs the OTHER way from the
  // checkout: it is charged to the seller's card onto OUR OWN merchant account, so
  // `seller_payme_id` here is ours and the card belongs to the seller. The probe stands in for a
  // seller with one of their test cards.
  if (!DELIVERY) { console.error('no PAYME_DELIVERY_MERCHANT_ID — our own merchant is what collects a subscription'); process.exit(1); }

  const tok = await call('capture-buyer-token', {
    seller_payme_id: DELIVERY, buyer_is_permanent: true,
    credit_card_number: '12312312', credit_card_exp: '1230', credit_card_cvv: '123',
    buyer_name: 'Probe Seller', buyer_email: 'random@paymeservice.com',
    buyer_phone: '0500000001', buyer_social_id: '9999999999',
  });
  say("seller's card token", tok);
  if (!ok(tok)) process.exit(1);

  // The HOSTED-PAGE variant first, and it is the one that matters: **our own merchant's public key
  // was never stored** (`create-seller` returns it once, §18 did not save it), so Hosted Fields
  // cannot be drawn for a subscription and `sub_url` is the only route a seller's card can reach.
  const page = await call('generate-subscription', {
    seller_payme_id: DELIVERY, sub_currency: 'ILS', sub_price: 9900,
    sub_description: 'מנוי חודשי — דזבין (עמוד)', sub_iteration_type: 3, sub_type: 1,
    subscription_id: `probe-page-${Date.now()}`, sub_send_notification: false,
  });
  say('no token → hosted page', page, page.sub_url ? 'has sub_url' : 'NO sub_url');
  console.log('  status', page.sub_status, '· paid', page.sub_paid, '·', String(page.sub_url ?? '').slice(0, 70));
  if (ok(page)) await call('cancel-subscription', { seller_payme_id: DELIVERY, sub_payme_id: page.sub_payme_id });

  const sub = await call('generate-subscription', {
    seller_payme_id: DELIVERY,
    sub_currency: 'ILS',
    sub_price: 9900,                    // the base tier, in agorot. Their documented minimum is 500.
    sub_description: 'מנוי חודשי — דזבין',
    sub_iteration_type: 3,              // monthly
    sub_type: 1,                        // regular; 10 is a template
    buyer_key: tok.buyer_key,           // with a token there is no page for anyone to visit
    subscription_id: `probe-${Date.now()}`,
    sub_send_notification: false,
  });
  console.log(redact(JSON.stringify(sub, null, 2)));
  if (!ok(sub)) process.exit(1);

  // **Changing the plan of a seller who is already paying** — the question that matters, because
  // the alternative anyone reaches for first is cancel-and-recreate, which re-authorises a card
  // the seller already gave us. Their docs say `set-price` applies to a subscription in status
  // `active`; what a document cannot say is whether ours is in that status, whether the client key
  // belongs in the body, and what the read-back shows afterwards.
  const withKey = await patchPrice(sub.sub_payme_id, { payme_client_key: KEY, seller_payme_id: DELIVERY, sub_price: '12500' });
  console.log('set-price (with client key)', redact(JSON.stringify(withKey)));
  const noKey = await patchPrice(sub.sub_payme_id, { seller_payme_id: DELIVERY, sub_price: '17900' });
  console.log('set-price (no client key)  ', redact(JSON.stringify(noKey)));

  // Read it back, then cancel — the sandbox is shared, and a recurring charge left running is the
  // one thing here that would keep happening after the probe exits.
  const list = await call('get-subscriptions', { seller_payme_id: DELIVERY });
  const found = (list.items ?? []).find((i) => i.sub_payme_id === sub.sub_payme_id);
  console.log('read back:', found ? redact(JSON.stringify(found, null, 2)) : `not among ${list.items?.length ?? 0} items`);

  const cancelled = await call('cancel-subscription', { seller_payme_id: DELIVERY, sub_payme_id: sub.sub_payme_id });
  say('cancel', cancelled);
  if (!ok(cancelled)) console.log(redact(JSON.stringify(cancelled, null, 2)));

} else if (mode === 'set-price') {
  // **The question a document cannot answer: after the price is patched, what does the NEXT charge
  // take?** `set-price` was already measured to change `sub_price` on a live subscription
  // (§23), and the owner's question was the one that actually reaches a seller — *"אבל זה נכנס
  // לתוקף ממש מידי? מה יהיה בחיוב הקרוב?"*.
  // Waiting for a monthly iteration is not a measurement anyone can run, so the charge is forced:
  // `pay-subscription` bills the subscription now, with the seller's card, and the sale it returns
  // says which price the payment engine read.
  if (!DELIVERY) { console.error('no PAYME_DELIVERY_MERCHANT_ID'); process.exit(1); }
  const CARD = { credit_card_number: '12312312', credit_card_exp: '1230', credit_card_cvv: '123' };

  // A. UNPAID first (status 1). Patch, then pay: does the first charge take the new price?
  const unpaid = await call('generate-subscription', {
    seller_payme_id: DELIVERY, sub_currency: 'ILS', sub_price: 9900,
    sub_description: 'בדיקת עיתוי — לא שולם', sub_iteration_type: 3, sub_type: 1,
    subscription_id: `timing-a-${Date.now()}`, sub_send_notification: false,
  });
  say('A · created unpaid at 9900', unpaid, `status ${unpaid.sub_status}`);
  const patchA = await patchPrice(unpaid.sub_payme_id, { payme_client_key: KEY, seller_payme_id: DELIVERY, sub_price: '17900' });
  console.log('A · patched to 17900        ', patchA.status_code === 0 ? `OK (sub_price ${patchA.sub_price})` : redact(patchA.status_error_details));
  const payA = await call('pay-subscription', { seller_payme_id: DELIVERY, sub_payme_id: unpaid.sub_payme_id, ...CARD, buyer_name: 'Probe Seller', buyer_email: 'random@paymeservice.com', buyer_phone: '0500000001', buyer_social_id: '9999999999' });
  console.log('A · paid it now             ', payA.status_code === 0
    ? `CHARGED ${payA.sale_price ?? payA.sub_price ?? '?'} (sale ${payA.payme_sale_id ?? ''})`
    : `REFUSED · ${redact(payA.status_error_details)} (${payA.status_error_code})`);
  const listA = await call('get-subscriptions', { seller_payme_id: DELIVERY });
  const rowA = (listA.items ?? []).find((i) => i.sub_payme_id === unpaid.sub_payme_id);
  console.log('A · read back               ', rowA ? `price ${rowA.sub_price} · status ${rowA.sub_status} · next ${rowA.sub_next_date}` : 'not found');
  await call('cancel-subscription', { seller_payme_id: DELIVERY, sub_payme_id: unpaid.sub_payme_id });

  // A2. And what CAN be done with an unpaid one, since patching it is refused: cancelling it costs
  // nothing — no card was charged and there is no standing order yet — which is what lets a seller
  // who changed plan before paying be given a fresh subscription at the new price.
  const spare = await call('generate-subscription', {
    seller_payme_id: DELIVERY, sub_currency: 'ILS', sub_price: 9900,
    sub_description: 'בדיקת עיתוי — ביטול לא-שולם', sub_iteration_type: 3, sub_type: 1,
    subscription_id: `timing-a2-${Date.now()}`, sub_send_notification: false,
  });
  const killed = await call('cancel-subscription', { seller_payme_id: DELIVERY, sub_payme_id: spare.sub_payme_id });
  say('A2 · cancel an UNPAID subscription', killed);

  // B. MID-CYCLE. Token subscription charges 9900 at once; patch it, then force the next charge.
  const tok = await call('capture-buyer-token', {
    seller_payme_id: DELIVERY, buyer_is_permanent: true, ...CARD,
    buyer_name: 'Probe Seller', buyer_email: 'random@paymeservice.com',
    buyer_phone: '0500000001', buyer_social_id: '9999999999',
  });
  const live = await call('generate-subscription', {
    seller_payme_id: DELIVERY, sub_currency: 'ILS', sub_price: 9900,
    sub_description: 'בדיקת עיתוי — פעיל', sub_iteration_type: 3, sub_type: 1,
    buyer_key: tok.buyer_key, subscription_id: `timing-b-${Date.now()}`, sub_send_notification: false,
  });
  say('B · created and charged at 9900', live, `status ${live.sub_status} · paid ${live.sub_paid}`);
  const patchB = await patchPrice(live.sub_payme_id, { payme_client_key: KEY, seller_payme_id: DELIVERY, sub_price: '17900' });
  console.log('B · patched to 17900        ', patchB.status_code === 0 ? `OK (sub_price ${patchB.sub_price})` : redact(patchB.status_error_details));
  const payB = await call('pay-subscription', { seller_payme_id: DELIVERY, sub_payme_id: live.sub_payme_id, ...CARD, buyer_name: 'Probe Seller', buyer_email: 'random@paymeservice.com', buyer_phone: '0500000001', buyer_social_id: '9999999999' });
  console.log('B · forced the next charge  ', payB.status_code === 0
    ? `CHARGED ${payB.sale_price ?? payB.sub_price ?? '?'} (sale ${payB.payme_sale_id ?? ''})`
    : `REFUSED · ${redact(payB.status_error_details)} (${payB.status_error_code})`);
  const listB = await call('get-subscriptions', { seller_payme_id: DELIVERY });
  const rowB = (listB.items ?? []).find((i) => i.sub_payme_id === live.sub_payme_id);
  console.log('B · read back               ', rowB ? `price ${rowB.sub_price} · completed ${rowB.sub_iterations_completed} · next ${rowB.sub_next_date}` : 'not found');
  const cancelledB = await call('cancel-subscription', { seller_payme_id: DELIVERY, sub_payme_id: live.sub_payme_id });
  say('B · cancelled', cancelledB);

} else {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(2, 20).join('\n'));
}
