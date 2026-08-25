/**
 * PayMe — the transport layer for the split model.
 *
 * **Read `docs/payme-sandbox-notes.md` and `GO_LIVE_CHECKLIST.md` §3.1.0–§3.1.1 before changing
 * anything here.** Every rule this file enforces was MEASURED against `https://sandbox.payme.io/api/`
 * on 2026-08-21, and each one is a way a real integration silently takes the wrong amount of money
 * or refuses a payment that should have worked. Where something was NOT measured it says so out
 * loud, in the place a caller would otherwise assume it had been — `docs/payme-api-blueprint.md`
 * beside those notes is PayMe's raw spec, saved verbatim, and it is old: it does not know
 * `pay-sale`, `update-seller` or `market_fee_fixed`, so it is evidence for the shapes it describes
 * and never evidence that something does not exist.
 *
 * ── What the split model needs from PayMe, and it is exactly five things ──
 *
 *   `createSeller`        — a merchant account of the seller's OWN, so his money never passes
 *                           through us. Returns the id we store, the callback signing secret, the
 *                           Hosted-Fields public key, and a link he finishes his own KYC on.
 *   `captureBuyerToken`   — the buyer types a card ONCE and we get a token. ⚠️ It must be asked for
 *                           as PERMANENT or the second store in a cart fails; see `permanent`.
 *   `generateSale`        — one charge per store, on that store's own merchant account, with our
 *                           cut (`market_fee` + `market_fee_fixed`) taken inside the transaction.
 *   `refundSale`          — the other direction, for a cancelled order or a failed sibling charge.
 *   `verifyCallbackSignature` — the callback arrives over the public internet from anybody, so it
 *                           proves nothing until this returns true.
 *
 * ── The unit trap, and it is the expensive one ──
 * PayMe mixes units inside a SINGLE request: `sale_price` is in **agorot** (₪50 → `5000`) while
 * `market_fee_fixed` is in **shekels** (₪15 → `15`). Measured: a `5000` sale with `market_fee: 12`
 * and `market_fee_fixed: 15` answered `sale_market_fee_total: 2100` — ₪6 percentage plus ₪15
 * fixed. Sending `3000` meaning ₪30 is read as ₪3,000, i.e. a hundredfold over-charge of our own
 * cut against a seller. So **everything in this module's own interface takes AGOROT**, the unit the
 * rest of this codebase counts money in, and the conversion happens once at the edge in
 * `marketFeeFixedShekels`. Nothing above this file may ever hand PayMe a shekel figure.
 *
 * ── Why the transport layer and the `PaymentProvider` interface are not the same thing ──
 * `lib/payment.ts` models one authorize→capture pair against one merchant. The split model is N
 * charges against N merchants plus a shipping charge against ours, and there is no single
 * authorization behind them. Composing those into a checkout is `lib/payment-split.ts`'s job;
 * this file only knows how PayMe works, exactly as `payment-hyp.ts` only knows how Hyp works.
 */
import crypto from 'node:crypto';
import { agorotToDecimalString } from './money.js';
import { commissionOnAgorot } from './pricing.js';
import { outboundFetch } from './outbound-fetch.js';
import { serverEnv } from './runtime-env.js';

/** PayMe answers every call with JSON carrying its own status. `0` is success — and it can arrive
 *  under an HTTP 500 as easily as under a 200, so the HTTP status is never the answer. */
export const PAYME_OK = 0;

/**
 * The smallest sale PayMe will accept, and the smallest PARTIAL refund — 500 agorot, both.
 *
 * Measured on the account (`§3.1.1` item 8) and stated in their own spec beside `sale_price` and
 * `sale_refund_amount`. It matters twice over: a ₪4 product cannot be sold at all, and a ₪4
 * *remainder* cannot be refunded — which is the harder case, because a partial refund of an
 * eligible order is a thing a seller can ask for at any amount. A caller that does not check this
 * discovers it as a rejected refund on a real customer's money.
 */
export const PAYME_MIN_SALE_AGOROT = 500;
export const PAYME_MIN_REFUND_AGOROT = 500;

/**
 * Our total cut may not exceed 60% of the sale.
 *
 * Measured: ₪50 with a ₪30 delivery charge folded in is 72% and was refused outright —
 * `Market fee exceed allowed maximum of 60%`. A cheap item with a real delivery charge is exactly
 * the shape that breaches it (₪10 + ₪30 ≈ 87%), which is **why shipping is charged as its own sale
 * on our own merchant account** instead of as a fixed market fee on the seller's — that route
 * touches no ceiling at all and was measured working.
 *
 * PayMe offered to raise the ceiling "to 110% for example". That the 60% cap is the same setting
 * they meant is a READING of their sentence and not a measurement, so nothing here depends on it.
 */
export const PAYME_MAX_MARKET_FEE_PERCENT = 60;

/** ILS. The platform is ILS-only (AI_INSTRUCTIONS → hard constraints). */
export const PAYME_CURRENCY = 'ILS';

export interface PaymeCredentials {
  clientKey: string;
  /**
   * **Our own MERCHANT account** — `PAYME_DELIVERY_MERCHANT_ID`, opened with `create-seller` like
   * any seller's (`docs/payme-sandbox-notes.md` §18). Two charges are made against it and neither
   * can be made anywhere else: the delivery leg of a cart, which is ours to collect and ours to pay
   * a courier out of, and the seller's monthly subscription, which is money flowing towards us
   * rather than through us.
   *
   * ⚠️ **It is NOT `PAYME_SELLER_API_ID`**, which this field used to read. That value is the
   * PARTNER identity, and §15 measured that charging it anything is refused with
   * `174 · אפשרות זו אינה נתמכת במשתמשים מסוג זה` — being the partner does not exempt us from
   * needing a merchant account to accept a card. Nothing read this field while it held the wrong
   * value, which is the only reason the mistake cost nothing.
   */
  ownMerchantId?: string;
  /**
   * Our own merchant's Hosted Fields public key — `PAYME_OWN_PUBLIC_KEY`.
   *
   * Meant to reach a browser, like a Stripe publishable key, and it is what lets a SELLER's card be
   * typed on our page instead of on PayMe's. **It comes back exactly once, from `create-seller`**
   * (`scripts/payme-open-own-merchant.mjs` is the only thing that opens the account, and printing
   * these is its whole purpose): neither `get-sellers` nor `update-seller` returns it, measured
   * twice, so an account opened without storing it can never draw a card field again.
   *
   * Absent is a real state and not a failure — it is every deployment that has not opened the
   * account yet, and the subscription falls back to PayMe's own payment page.
   */
  ownPublicKey?: string;
  /** `https://sandbox.payme.io/api/` or `https://live.payme.io/api/`. Trailing slash included. */
  baseUrl: string;
}

/**
 * Credentials, or null when PayMe is not configured.
 *
 * Null is a real answer and not a failure — `lib/site-mode.ts` derives "this deployment cannot take
 * money" from the absence of a live provider rather than from a flag, so a production server can
 * never be one forgotten switch away from a free checkout.
 */
export function paymeCredentials(): PaymeCredentials | null {
  const clientKey = serverEnv('PAYME_CLIENT_KEY');
  if (!clientKey) return null;
  const ownMerchantId = serverEnv('PAYME_DELIVERY_MERCHANT_ID');
  const ownPublicKey = serverEnv('PAYME_OWN_PUBLIC_KEY');
  return {
    clientKey,
    ...(ownMerchantId ? { ownMerchantId } : {}),
    ...(ownPublicKey ? { ownPublicKey } : {}),
    baseUrl: serverEnv('PAYME_BASE_URL') || 'https://sandbox.payme.io/api/',
  };
}

/** The sandbox is shared with PayMe's other partners and has no delete (`§3.1.1`). Knowing which
 *  environment a call is about to hit is what stops a test run creating merchants in production —
 *  and it is derived from the base URL we deliberately configured, never guessed from an id. */
export function isSandbox(creds: PaymeCredentials): boolean {
  return creds.baseUrl.includes('sandbox.payme.io');
}

/**
 * Should this process actually route checkouts through PayMe?
 *
 * **Credentials alone are the answer in PRODUCTION, deliberately** — `site-mode.ts` argues it at
 * length: a `CHECKOUT_OPEN` flag fails not because it gets set wrongly but because on the one day
 * it matters nobody remembers it exists, so wiring the gateway must open the shop by itself.
 *
 * **In DEVELOPMENT they are not, and that is not a hedge.** The sandbox keys live in `.env` on the
 * developer's own machine, so a credentials-only rule would mean every demo purchase — `seed:demo`
 * has a catalogue of them — posts a real `generate-sale` to a sandbox that is SHARED with PayMe's
 * other partners and **has no delete** (`docs/payme-sandbox-notes.md`). It would also block the
 * whole demo checkout on day one, because a seeded seller has no merchant account and never will.
 * So dev keeps the mock provider unless someone deliberately asks otherwise, one run at a time.
 *
 * `PAYME_DEV_LIVE=1` is named for what it DOES rather than for what it is for, exactly like
 * `ALLOW_MOCK_CHECKOUT`: what it does is send this developer's clicks to a real payment gateway.
 */
export function paymeIsActive(): boolean {
  if (!paymeCredentials()) return false;
  if (import.meta.env.PROD) return true;
  return serverEnv('PAYME_DEV_LIVE') === '1';
}

/** Credentials, but only when this process should really be using them. The one call every
 *  application path should make — `paymeCredentials()` itself is for code that needs the values
 *  regardless (a probe, a test). */
export function activePaymeCredentials(): PaymeCredentials | null {
  return paymeIsActive() ? paymeCredentials() : null;
}

/** A PayMe error, carrying their own code so a caller can branch on it rather than on prose. Their
 *  messages are Hebrew by default and are written for a merchant, not a shopper — never show one
 *  to a buyer. */
export class PaymeError extends Error {
  readonly code: number;
  readonly endpoint: string;
  constructor(endpoint: string, code: number, details: string) {
    super(`payme ${endpoint}: ${details || 'unknown error'} (code ${code})`);
    this.name = 'PaymeError';
    this.code = code;
    this.endpoint = endpoint;
  }
}

export type PaymeResponse = Record<string, unknown>;

/**
 * One POST, one JSON body, one status check.
 *
 * `payme_client_key` is injected here rather than by each caller, for the same reason the amount
 * conversion is: a call that forgets it is not a compile error, it is a runtime auth failure on a
 * money path. **The key is never included in a thrown message** — PayMe echo request context into
 * some errors, so the throw carries their code and their detail string and nothing of ours.
 */
async function callPayme(endpoint: string, body: Record<string, unknown>, creds: PaymeCredentials): Promise<PaymeResponse> {
  return sendPayme('POST', endpoint, endpoint, { payme_client_key: creds.clientKey, ...body }, creds);
}

/**
 * One request to PayMe, and the answer read their way.
 *
 * Split out of `callPayme` for the one endpoint that is not a POST to `{base}{name}`:
 * `set-price` is a PATCH and carries the subscription id in the PATH (`subscriptions/{id}/set-price`).
 * Everything below the request is identical and must stay so — the non-JSON diagnosis and the rule
 * about `status_code` are what make a PayMe failure legible, and a second copy of them would drift.
 * `label` is what an error names, so a caller sees the endpoint rather than the built path.
 */
async function sendPayme(
  method: 'POST' | 'PATCH',
  label: string,
  path: string,
  body: Record<string, unknown>,
  creds: PaymeCredentials,
): Promise<PaymeResponse> {
  const res = await outboundFetch(`${creds.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 20_000,
  });
  const endpoint = label;
  const text = await res.text();
  let parsed: PaymeResponse;
  try {
    parsed = JSON.parse(text) as PaymeResponse;
  } catch {
    // An HTML body is how a non-existent endpoint answers (`§3.1.1`, endpoint discovery). Saying so
    // is worth more than "unexpected token <" — it names the actual cause, which is a typo in a
    // path or a base URL pointing somewhere that is not the API.
    throw new PaymeError(endpoint, -1, `non-JSON response (HTTP ${res.status}) — endpoint may not exist`);
  }
  // The HTTP status is deliberately not consulted: PayMe return `status_code: 1` under a 500 and
  // under a 200 alike, and their own success is `status_code: 0`. Reading `res.ok` instead would
  // accept a refusal as a completed charge.
  const status = Number(parsed.status_code ?? -1);
  if (status !== PAYME_OK) {
    throw new PaymeError(
      endpoint,
      Number(parsed.status_error_code ?? status),
      String(parsed.status_error_details ?? parsed.status_additional_info ?? ''),
    );
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money rules — pure, so they are testable without a network and enforceable
// before a call rather than discovered inside PayMe's answer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agorot → the shekel NUMBER `market_fee_fixed` expects.
 *
 * `agorotToDecimalString` and not a division, deliberately: `1015 / 100` is `10.149999999999999`
 * in binary floating point, and a JSON body carrying fifteen decimal places of a fee is a
 * conversation with PayMe's support nobody wants to have. The string is exact, and `Number` of an
 * exact two-decimal string is the nearest double to it, which is the best any JSON number can be.
 */
export function marketFeeFixedShekels(agorot: number): number {
  return Number(agorotToDecimalString(agorot));
}

/**
 * What PayMe will actually take for us on a sale, in agorot.
 *
 * The percentage applies to `sale_price`; the fixed amount is added on top. Measured exactly:
 * `sale_price 5000` + `market_fee 12` + `market_fee_fixed 15` → `sale_market_fee_total: 2100`.
 * Rounded to the agora once, at the end, for the same reason `pricing.ts#commissionOnAgorot`
 * exists — so our figure and theirs cannot disagree by a rounding.
 */
export function marketFeeTotalAgorot(input: { salePriceAgorot: number; marketFeePercent: number; marketFeeFixedAgorot?: number }): number {
  // `commissionOnAgorot` and not `Math.round(price * pct / 100)` written out again, even though
  // that is all it is. It is `pricing.ts`'s definition of "the platform's cut of a figure held in
  // agorot", and the percentage PayMe apply here IS that cut — so a hand-rolled copy is two
  // definitions of one number, and the day they round differently our predicted commission and the
  // seller's reported commission disagree by an agora with no way to tell which is right. Written
  // out once, caught reviewing this diff.
  return commissionOnAgorot(input.salePriceAgorot, input.marketFeePercent) + (input.marketFeeFixedAgorot ?? 0);
}

/**
 * Would this sale breach the 60% ceiling — checked HERE, before the call, and not left to PayMe.
 *
 * Their refusal is a rejected charge on a buyer who is watching, mid-checkout, with the other
 * stores in the cart possibly already charged. Ours is a number a caller can act on: reduce the
 * cut, or move the amount onto the shipping sale where the ceiling does not apply.
 */
export function exceedsMarketFeeCeiling(input: { salePriceAgorot: number; marketFeePercent: number; marketFeeFixedAgorot?: number }): boolean {
  if (input.salePriceAgorot <= 0) return true;
  return marketFeeTotalAgorot(input) > (input.salePriceAgorot * PAYME_MAX_MARKET_FEE_PERCENT) / 100;
}

/**
 * Everything PayMe will refuse a sale for, answered before the money is at stake.
 *
 * Returns a machine reason rather than a sentence: the caller decides what a buyer is told, and
 * PayMe's own message is Hebrew merchant-facing prose that must never reach a shopper.
 */
export type SaleRefusal = 'below-minimum' | 'market-fee-ceiling' | null;

export function refuseSale(input: { salePriceAgorot: number; marketFeePercent: number; marketFeeFixedAgorot?: number }): SaleRefusal {
  if (input.salePriceAgorot < PAYME_MIN_SALE_AGOROT) return 'below-minimum';
  if (exceedsMarketFeeCeiling(input)) return 'market-fee-ceiling';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sellers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimum PayMe accept to open a merchant account — and it is deliberately the minimum.
 *
 * `create-seller` returns `seller_dashboard_signup_link`, a page the seller completes his own
 * details on, so we do NOT have to collect every KYC field ourselves. Asking a seller for his
 * birth date and his ID issue date before he has opened a store is exactly the registration
 * barrier `feedback_seller_form_burden` forbids; handing him a link after the store exists is not.
 *
 * ⚠️ **`seller_id` — our own correlation field — is REFUSED on this plan** (error 790, measured).
 * So the join between his account here and his account there is the `seller_payme_id` we store,
 * and there is nothing on PayMe's side pointing back at us. Losing that column loses the link.
 */
export interface CreateSellerInput {
  firstName: string;
  lastName: string;
  socialId: string;
  birthdate: string;            // DD/MM/YYYY
  socialIdIssued: string;       // DD/MM/YYYY
  /** 0 male, 1 female — PayMe's enum, required by them. */
  gender: 0 | 1;
  email: string;
  phone: string;
  bankCode: string;
  bankBranch: string;
  bankAccount: string;
  description: string;
  siteUrl: string;
  /** MCC / business category code. */
  businessType: string;
  /** PayMe's incorporation enum: 0/1 individual or sole trader, 2 licensed company, 5 exempt. */
  incorporation: number;
  /** ח.פ / ע.מ — required by PayMe whenever `incorporation` is not 0. */
  businessId?: string;
  merchantName?: string;
  registrationDate: string;     // DD/MM/YYYY
  addressCity: string;
  addressStreet: string;
  addressStreetNumber: string;
  /** The seller's default distribution fee, i.e. OUR commission percent for his tier
   *  (`lib/pricing.ts#commissionPercentForTier`). Set per merchant at creation and overridable per
   *  sale — which is what makes a tier change take effect on the next sale rather than needing a
   *  round-trip to PayMe. */
  marketFeePercent: number;
}

export interface CreatedSeller {
  /** The id every later call names this merchant by. This is the whole of the join — store it. */
  sellerPaymeId: string;
  /** Per-seller callback signing key. Half of the MD5 in `verifyCallbackSignature`; a secret. */
  sellerPaymeSecret: string;
  /** Public key for Hosted Fields, so the card is entered on PayMe's own field and never touches
   *  this server. Not a secret. */
  sellerPublicKey: string;
  /** Where to send the seller to finish his own KYC. */
  signupLink: string;
  /** **A new merchant is `false` / `Restricted` and CANNOT SELL.** PayMe review every business and
   *  may reject one at their sole discretion (agreement §11), so "the store is open" never implies
   *  "this seller can take money" — the UX has to be able to say so. */
  approved: boolean;
}

/** The Hosted Fields public key, out of either shape PayMe have used for it: the object their
 *  current reference documents (`{ uuid, … }`) or the bare string their older spec showed. An
 *  inactive key is refused rather than stored — `is_active: false` is a key that will not
 *  initialise, and a blank is a state the rest of the code already handles honestly. */
function readPublicKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const key = value as { uuid?: unknown; is_active?: unknown };
    if (key.is_active === false) return '';
    return typeof key.uuid === 'string' ? key.uuid : '';
  }
  return '';
}

export async function createSeller(input: CreateSellerInput, creds: PaymeCredentials): Promise<CreatedSeller> {
  const res = await callPayme('create-seller', {
    seller_first_name: input.firstName,
    seller_last_name: input.lastName,
    seller_social_id: input.socialId,
    seller_birthdate: input.birthdate,
    seller_social_id_issued: input.socialIdIssued,
    seller_gender: input.gender,
    seller_email: input.email,
    seller_phone: input.phone,
    seller_bank_code: input.bankCode,
    seller_bank_branch: input.bankBranch,
    seller_bank_account_number: input.bankAccount,
    seller_description: input.description.slice(0, 255),
    seller_site_url: input.siteUrl,
    seller_person_business_type: input.businessType,
    seller_inc: input.incorporation,
    ...(input.businessId ? { seller_inc_code: input.businessId } : {}),
    ...(input.merchantName ? { seller_merchant_name: input.merchantName } : {}),
    seller_registration_date: input.registrationDate,
    seller_retail_type: 1,                    // Card-not-present. Every store here is online.
    seller_address_city: input.addressCity,
    seller_address_street: input.addressStreet,
    seller_address_street_number: input.addressStreetNumber,
    seller_address_country: 'IL',
    market_fee: input.marketFeePercent,
    // NOT `seller_id`. Our correlation field is refused on this plan (790) and sending it fails
    // the whole call — see the interface header.
  }, creds);

  const sellerPaymeId = String(res.seller_payme_id ?? '');
  // A create that answers success without an id is unusable and must not be recorded as an
  // account: every later call names the merchant by this string, so an empty one would leave a
  // store looking able to sell with nothing behind it.
  if (!sellerPaymeId) throw new PaymeError('create-seller', PAYME_OK, 'succeeded without a seller_payme_id');

  return {
    sellerPaymeId,
    sellerPaymeSecret: String(res.seller_payme_secret ?? ''),
    // **`seller_public_key` is an OBJECT, not a string** — `{ uuid, description, is_active }`, per
    // their own API reference (read 2026-08-23). `String(...)` of it yields `"[object Object]"`,
    // which stores cleanly, passes every type check, and then fails at the one moment that matters:
    // the buyer's card form refuses to initialise, on a value we can never fetch again because
    // `create-seller` returns it once. The string form is tolerated too — their older spec shows
    // one, and a provider changing a field's SHAPE is exactly what this should survive.
    sellerPublicKey: readPublicKey(res.seller_public_key),
    signupLink: String(res.seller_dashboard_signup_link ?? ''),
    approved: res.seller_approved === true || res.seller_approved === 'true',
  };
}

/**
 * Ask PayMe what a merchant's status actually is.
 *
 * **This exists because the seller callback cannot be verified.** Their sale callback carries
 * `payme_signature`; their SELLER callback carries no signature field at all (their spec's
 * attribute table for "Callback upon Seller creation or update"), so a POST claiming
 * `seller_approved: 1` is a claim by whoever sent it — and acting on it would let anyone on the
 * internet unblock any store on this platform.
 *
 * So the callback is treated as a HINT — "something about this merchant changed" — and the truth
 * comes from here, over a call WE make, authenticated by our own client key. Same shape as
 * `payment-hosted.ts#readReturn` asking Hyp rather than believing the browser, and the same rule as
 * `checkout-idempotency.ts#checkoutOwner`: an identifier that arrives from outside is an
 * identifier, never a permission.
 *
 * Returns null when PayMe do not know the merchant, which is a different answer from "not
 * approved" and must stay one: a caller must not read "we could not find him" as a verdict.
 */
export async function getSellerStatus(sellerPaymeId: string, creds: PaymeCredentials): Promise<{ approved: boolean; active: boolean } | null> {
  const res = await callPayme('get-sellers', { seller_payme_id: sellerPaymeId }, creds);
  const items = Array.isArray(res.items) ? (res.items as Record<string, unknown>[]) : [];
  // Matched on the id rather than taken as `items[0]`, and this stopped being a precaution on
  // 2026-08-23: **`get-sales` was measured IGNORING its `payme_sale_id` filter entirely**, returning
  // the caller's whole list — and with no seller scope, other partners' sales in the shared sandbox.
  // `get-sellers` did filter correctly when probed, so the two endpoints do not behave alike and
  // neither can be trusted to. Reading `items[0]` here would write another merchant's approval onto
  // our seller and open a store that PayMe have not approved.
  const found = items.find((item) => String(item.seller_payme_id ?? '') === sellerPaymeId);
  if (!found) return null;
  return {
    // `=== true` and `=== '1'` explicitly: their own example returns a JSON boolean here and the
    // string `'1'` elsewhere for the same concept, and `Boolean('0')` is true.
    approved: found.seller_approved === true || found.seller_approved === '1' || found.seller_approved === 1,
    active: found.seller_active === true || found.seller_active === '1' || found.seller_active === 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The buyer's token — one card entry, N charges
// ─────────────────────────────────────────────────────────────────────────────

export interface CaptureBuyerTokenInput {
  /** The merchant the token is created UNDER. Any of them will do: a token created under seller A
   *  charges successfully under seller B (measured, `§3.1.1` item 2), and that crossing is the
   *  entire mechanism behind "one cart, several stores". */
  sellerPaymeId: string;
  /** Server-to-server only — their test cards, in tests. **Production enters the card in Hosted
   *  Fields and this field is never populated**, because a card number reaching this process puts
   *  the whole deployment in PCI scope. `§3.1.1` item 1: `pay-sale`/`capture-buyer-token` being
   *  open to us is a TESTING affordance, not the shipping integration. */
  creditCardNumber?: string;
  /** **`MMYY`, one field.** Measured 2026-08-23: sending `credit_card_exp_month` and
   *  `credit_card_exp_year` — the obvious pair, and what this originally sent — is refused with
   *  `Required parameter is missing · credit_card_exp`. Loud, which is the only reason it cost
   *  minutes rather than a debugging session. */
  expiry?: string;
  cvv?: string;
  buyerName?: string;
  buyerEmail?: string;
  buyerPhone?: string;
  buyerSocialId?: string;
}

export interface BuyerToken {
  buyerKey: string;
}

/**
 * Take the buyer's card once and get a token to charge every store with.
 *
 * **⚠️ `buyer_is_permanent: true` is not an option, it is the whole thing.** Measured: an ordinary
 * token is SINGLE-USE — the second charge on the same key answered `Buyer inactive`, so store one
 * succeeds, store two fails, and a buyer with a two-store cart is left holding a half-completed
 * purchase. Passing the flag upgrades the same key rather than issuing a new one.
 *
 * It is hard-coded here rather than exposed as a parameter precisely because it has a plausible
 * default (`false`) that is wrong for every cart this platform will ever take. A caller cannot
 * forget it, and a caller cannot turn it off.
 */
export async function captureBuyerToken(input: CaptureBuyerTokenInput, creds: PaymeCredentials): Promise<BuyerToken> {
  const res = await callPayme('capture-buyer-token', {
    seller_payme_id: input.sellerPaymeId,
    buyer_is_permanent: true,
    ...(input.creditCardNumber ? { credit_card_number: input.creditCardNumber } : {}),
    ...(input.expiry ? { credit_card_exp: input.expiry } : {}),
    ...(input.cvv ? { credit_card_cvv: input.cvv } : {}),
    ...(input.buyerName ? { buyer_name: input.buyerName } : {}),
    ...(input.buyerEmail ? { buyer_email: input.buyerEmail } : {}),
    ...(input.buyerPhone ? { buyer_phone: input.buyerPhone } : {}),
    ...(input.buyerSocialId ? { buyer_social_id: input.buyerSocialId } : {}),
  }, creds);

  const buyerKey = String(res.buyer_key ?? '');
  if (!buyerKey) throw new PaymeError('capture-buyer-token', PAYME_OK, 'succeeded without a buyer_key');
  return { buyerKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateSaleInput {
  /** Whose merchant account the money lands in. The seller's for a store's slice; OUR marketplace
   *  account for the shipping charge. */
  sellerPaymeId: string;
  /** AGOROT. Never shekels — see the module header. */
  salePriceAgorot: number;
  /** Shown to the buyer and printed on the seller's invoice if he has the module enabled. */
  productName: string;
  /** Our reference for this charge, so their record and ours can be matched later. */
  transactionId: string;
  /** Charging an existing token. Cannot coexist with `captureBuyer`. */
  buyerKey?: string;
  /**
   * `authorize` holds the cart total without taking it; `multi-capture` draws a slice of an
   * existing authorization, named by `originSaleId`. Absent is an ordinary immediate sale.
   *
   * **This is the pair PayMe's own guide gives for paying several sellers from one purchase**, and
   * their prerequisite says so outright: *"at least 2 users from the same marketplace"*. Measured
   * 2026-08-23 — authorize ₪100, capture ₪40 to seller A and ₪60 to seller B, both `completed`.
   *
   * ⚠️ An earlier session concluded multi-capture was disabled on our key. It had called
   * `capture-sale`, which is the SINGLE-capture endpoint; this is a different call entirely.
   */
  saleType?: 'authorize' | 'multi-capture';
  /** The authorization this capture draws on — `payme_sale_id` from the `authorize` call. Required
   *  by `saleType: 'multi-capture'` and meaningless without it. */
  originSaleId?: string;
  /** Ask for a token back alongside this charge. Cannot coexist with `buyerKey`. */
  captureBuyer?: boolean;
  /** Our percentage cut, overriding the merchant's default. `0` is meaningful and must survive:
   *  the shipping sale on our own account takes no market fee at all. */
  marketFeePercent?: number;
  /**
   * A FIXED cut, on top of the percentage. AGOROT here; converted to the shekels PayMe want at the
   * edge (see the module header).
   *
   * **The field name is `market_fee_fixed`, and this was proved rather than assumed.** PayMe told
   * the owner in writing that a fixed fee is available and called it *"direct market fee"*. That is
   * their conversational name for it: a paid sandbox sale with `direct_market_fee: 15` came back
   * `sale_market_fee_fixed: 0`, `sale_market_fee_total: 0` — silently ignored — while the same sale
   * with `market_fee_fixed: 15` came back `1500` (measured 2026-08-23).
   *
   * ⚠️ **That silence is the danger, and it generalises past this one field.** PayMe accept unknown
   * parameters without complaint, so a misspelled fee field is not an error — it is a sale where we
   * take nothing and nobody finds out until the month's distribution fee is short. Never rename a
   * field here from a document; change it only against a paid sale whose fee you read back.
   */
  marketFeeFixedAgorot?: number;
  callbackUrl?: string;
  returnUrl?: string;
  buyerEmail?: string;
  buyerName?: string;
  installments?: number;
}

export interface GeneratedSale {
  paymeSaleId: string;
  /** Present when the sale still needs the buyer — the IFRAME URL. Absent on a token charge, which
   *  completes server-to-server with nobody to show anything to. */
  saleUrl?: string;
  /** `completed`, `authorized`, `initial`, `failed`… — PayMe's own vocabulary, passed through
   *  rather than mapped, so a status this code has not met is visible instead of silently bucketed
   *  as one it has. */
  saleStatus: string;
  /** What PayMe took for us on this sale, agorot. Their figure, not our recomputation of it —
   *  `marketFeeTotalAgorot` predicts, this reports, and a disagreement between them is a finding. */
  marketFeeTotalAgorot?: number;
}

/**
 * One charge, on one merchant account, with our cut taken inside the transaction.
 *
 * The two refusals PayMe would give us are checked BEFORE the call (`refuseSale`), because both
 * are perfectly predictable from the numbers in hand and neither is worth discovering as a failed
 * charge in the middle of a multi-store checkout.
 *
 * `installments: 1` by default: this platform has never offered payments, and PayMe's default
 * comes from terminal configuration rather than from the request, which would make the number of
 * installments a property of a setting nobody in this repo can see.
 */
export async function generateSale(input: GenerateSaleInput, creds: PaymeCredentials): Promise<GeneratedSale> {
  if (input.buyerKey && input.captureBuyer) {
    // PayMe reject the pair, but locally is where the message can name the mistake: asking for a
    // token while paying WITH a token is a caller bug, not a gateway condition.
    throw new PaymeError('generate-sale', -1, 'buyer_key and capture_buyer cannot coexist');
  }
  const refusal = refuseSale({
    salePriceAgorot: input.salePriceAgorot,
    marketFeePercent: input.marketFeePercent ?? 0,
    ...(input.marketFeeFixedAgorot !== undefined ? { marketFeeFixedAgorot: input.marketFeeFixedAgorot } : {}),
  });
  if (refusal === 'below-minimum') {
    throw new PaymeError('generate-sale', -1, `sale_price ${input.salePriceAgorot} is below PayMe's minimum of ${PAYME_MIN_SALE_AGOROT}`);
  }
  if (refusal === 'market-fee-ceiling') {
    throw new PaymeError('generate-sale', -1, `market fee exceeds ${PAYME_MAX_MARKET_FEE_PERCENT}% of the sale`);
  }

  const res = await callPayme('generate-sale', {
    seller_payme_id: input.sellerPaymeId,
    sale_price: input.salePriceAgorot,
    currency: PAYME_CURRENCY,
    product_name: input.productName.slice(0, 500),
    transaction_id: input.transactionId,
    installments: input.installments ?? 1,
    // `!== undefined` and not a truthiness test: `0` is the shipping sale's real market fee, and
    // dropping it would silently fall back to the merchant's default percentage.
    ...(input.marketFeePercent !== undefined ? { market_fee: input.marketFeePercent } : {}),
    ...(input.marketFeeFixedAgorot !== undefined ? { market_fee_fixed: marketFeeFixedShekels(input.marketFeeFixedAgorot) } : {}),
    ...(input.buyerKey ? { buyer_key: input.buyerKey } : {}),
    ...(input.captureBuyer ? { capture_buyer: 1 } : {}),
    ...(input.saleType ? { sale_type: input.saleType } : {}),
    ...(input.originSaleId ? { origin_sale_id: input.originSaleId } : {}),
    ...(input.callbackUrl ? { sale_callback_url: input.callbackUrl } : {}),
    ...(input.returnUrl ? { sale_return_url: input.returnUrl } : {}),
    ...(input.buyerEmail ? { sale_email: input.buyerEmail } : {}),
    ...(input.buyerName ? { sale_name: input.buyerName } : {}),
  }, creds);

  const paymeSaleId = String(res.payme_sale_id ?? '');
  if (!paymeSaleId) throw new PaymeError('generate-sale', PAYME_OK, 'succeeded without a payme_sale_id');
  const saleUrl = String(res.sale_url ?? '');
  const feeTotal = res.sale_market_fee_total;
  return {
    paymeSaleId,
    ...(saleUrl ? { saleUrl } : {}),
    saleStatus: String(res.sale_status ?? ''),
    ...(feeTotal !== undefined && feeTotal !== null ? { marketFeeTotalAgorot: Number(feeTotal) } : {}),
  };
}

/** PayMe's sale statuses that mean the money really moved. Their vocabulary
 *  (`docs/payme-api-blueprint.md` → Sale Statuses), listed rather than inferred: `authorized` is
 *  NOT here, because an authorization is a hold and this platform's rule is that an order exists
 *  only when money was really taken (`lib/payment.ts` header). */
export function saleIsPaid(saleStatus: string): boolean {
  return saleStatus === 'completed';
}

export interface RefundSaleInput {
  sellerPaymeId: string;
  paymeSaleId: string;
  /** AGOROT, and **omitting it means a FULL refund** — that is PayMe's rule, not a convenience
   *  here. A partial refund below `PAYME_MIN_REFUND_AGOROT` is refused, and this is the case
   *  callers get wrong: a multi-store order where only one small slice is cancelled. */
  refundAmountAgorot?: number;
}

export async function refundSale(input: RefundSaleInput, creds: PaymeCredentials): Promise<{ paymeSaleId: string; saleStatus: string }> {
  if (input.refundAmountAgorot !== undefined && input.refundAmountAgorot < PAYME_MIN_REFUND_AGOROT) {
    // Refused locally with the number in the message. PayMe's own refusal would be a rejected
    // refund on money that is already the buyer's, discovered by whoever is waiting for it.
    throw new PaymeError('refund-sale', -1, `partial refund ${input.refundAmountAgorot} is below PayMe's minimum of ${PAYME_MIN_REFUND_AGOROT}`);
  }
  const res = await callPayme('refund-sale', {
    seller_payme_id: input.sellerPaymeId,
    payme_sale_id: input.paymeSaleId,
    ...(input.refundAmountAgorot !== undefined ? { sale_refund_amount: input.refundAmountAgorot } : {}),
  }, creds);
  return { paymeSaleId: String(res.payme_sale_id ?? input.paymeSaleId), saleStatus: String(res.sale_status ?? '') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Add-on services (PayMe call them VAS), and the fee breakdown of one transaction.
// Both are READS about a seller's own account, plus the one write that turns a
// service on or off for him.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One add-on service as it sits on a merchant, in PayMe's own vocabulary.
 *
 * **A service is PROVISIONED onto a seller by PayMe, and only then can we switch it.** There is no
 * endpoint that creates one — measured 2026-08-25: `vas-list`, `get-vas`, `vas-create` and
 * `get-vases` are all 404, while `vas-enable` and `vas-disable` exist and both demand a
 * `vas_payme_id` that must already be on that merchant. `שירות 3DSecure` is the worked example: it
 * sits on all three of our merchants with `active: false`, waiting for exactly one call.
 *
 * **Prices are AGOROT integers.** Measured against the credit-reconciliation service, which came
 * back `vas_price_periodic_fixed: 25000` against a ₪250 line in the agreement.
 */
export interface PaymeService {
  id: string;
  /** Their type name — `Invoice`, `Payments`, `Settlements`, … (their VAS-types table). */
  type: string;
  /** Their Hebrew description of it, which is what a person would recognise. */
  description: string;
  active: boolean;
  /** Recurring price, agorot. */
  periodicAgorot: number;
  /** Per-use price, agorot. */
  usageAgorot: number;
  /** Their period code: 1 instant · 2 daily · 3 monthly · 4 yearly. */
  period: number;
}

const serviceAgorot = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** Every add-on service provisioned on this merchant, on or off. */
export async function getSellerServices(sellerPaymeId: string, creds: PaymeCredentials): Promise<PaymeService[]> {
  const res = await callPayme('get-vas-seller', { seller_payme_id: sellerPaymeId }, creds);
  const items = Array.isArray(res.items) ? res.items : [];
  return items.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.vas_guid ?? ''),
      type: String(row.vas_type ?? ''),
      description: String(row.vas_description ?? ''),
      active: row.vas_is_active === true,
      periodicAgorot: serviceAgorot(row.vas_price_periodic_fixed),
      usageAgorot: serviceAgorot(row.vas_price_usage_fixed),
      period: Number(row.vas_period ?? 0),
    };
  }).filter((s) => !!s.id);
}

/**
 * Turn one of a seller's provisioned services on or off.
 *
 * **The only WRITE in this group, and it commits the SELLER to a recurring charge** — so the caller
 * must have his explicit consent, and the price it showed him must be the one read back from
 * `getSellerServices` rather than a number typed anywhere in this repo (`seller-invoicing.ts`).
 */
export async function setSellerServiceActive(
  input: { sellerPaymeId: string; serviceId: string; active: boolean },
  creds: PaymeCredentials,
): Promise<void> {
  await callPayme(input.active ? 'vas-enable' : 'vas-disable', {
    seller_payme_id: input.sellerPaymeId,
    vas_payme_id: input.serviceId,
  }, creds);
}

/**
 * What one charge really cost the seller — PayMe's own arithmetic, not ours.
 *
 * The owner asked where a seller sees his clearing fee (2026-08-25), and the answer is that PayMe
 * publish it per transaction and we had never read it. **`processingAgorot` is the CLEARING fee and
 * `marketFeeAgorot` is OUR commission**; they are separate numbers from separate parties and
 * collapsing them into "fees" is how a seller ends up believing the platform took both.
 *
 * `netAgorot` is THEIRS too (`transaction_price_after_fees`) and is deliberately not recomputed
 * here: measured on a ₪40 sale it came back ₪33.19 against ₪1.00 + ₪4.80 of fees, i.e. it also
 * carries VAT on the fees and PayMe's fixed per-transaction charge. A number we derived would
 * disagree with the one on his bank statement, which is the only one he can check.
 */
export interface PaymeTransaction {
  saleId: string;
  /** `YYYY-MM-DD HH:MM:SS`, PayMe's own clock. */
  at: string;
  description: string;
  /** What the buyer paid on this charge, agorot. */
  priceAgorot: number;
  /** What reaches the seller after everything, agorot — PayMe's own figure. */
  netAgorot: number;
  /** PayMe's clearing fee on this charge, agorot. */
  processingAgorot: number;
  /** OUR distribution fee on this charge, agorot. */
  marketFeeAgorot: number;
  saleStatus: string;
  /** The invoice PayMe issued in the seller's name, when his invoicing service is on. `null`
   *  otherwise — measured null on a merchant without it. **This is the pull route** that makes the
   *  automatic invoice work without the public callback URL we still do not have. */
  invoiceUrl: string | null;
}

/**
 * This seller's recent charges, newest first.
 *
 * Scoped by `seller_payme_id` and never unfiltered: the sandbox is shared with PayMe's other
 * partners and an unscoped call really does return their merchants' rows (seen 2026-08-25).
 */
export async function getSellerTransactions(
  sellerPaymeId: string,
  creds: PaymeCredentials,
  limit = 10,
): Promise<PaymeTransaction[]> {
  const res = await callPayme('get-transactions', {
    seller_payme_id: sellerPaymeId,
    items_order_by_column: 'transaction_created_at',
    items_order_by_direction: 'desc',
    page_size: limit,
    page: 1,
    language: 'he',
  }, creds);
  const items = Array.isArray(res.items) ? res.items : [];
  return items
    // Belt and braces on a shared sandbox: the id is asked for AND checked, the same rule §12 in
    // the sandbox notes learned the hard way about `get-sales` ignoring its own filter.
    .filter((raw) => String((raw as Record<string, unknown>).seller_payme_id ?? '') === sellerPaymeId)
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      const fees = (row.sale_fees ?? {}) as Record<string, unknown>;
      const url = String(row.transaction_invoice_url ?? '').trim();
      return {
        saleId: String(row.sale_payme_id ?? ''),
        at: String(row.transaction_created_at ?? ''),
        description: String(row.sale_description ?? ''),
        priceAgorot: serviceAgorot(row.transaction_price),
        netAgorot: serviceAgorot(row.transaction_price_after_fees),
        processingAgorot: serviceAgorot(fees.sale_processing_fee_total),
        marketFeeAgorot: serviceAgorot(fees.sale_market_fee_total),
        saleStatus: String(row.sale_status ?? ''),
        invoiceUrl: url || null,
      };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Withdrawals — what PayMe are about to move into the seller's BANK, and what they
// already moved. Read-only, and the only reason the seller never has to open PayMe.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line of PayMe's own answer, kept in THEIR vocabulary.
 *
 * Deliberately not reshaped here: this module is the transport, and a field renamed on the way
 * through is a field nobody can look up in their documentation when it stops matching. The
 * seller-facing summary is `lib/seller-transfers.ts`, which is pure and has the tests.
 *
 * **Amounts are AGOROT** and arrive as a string on one endpoint and a number on the other —
 * measured 2026-08-25, both against the live sandbox. `Number()` at the edge, once, here.
 */
export interface PaymeWithdrawal {
  /** Agorot. */
  totalAgorot: number;
  /** Their own code for the row. Opaque, and on `get-future-withdrawals` it is a long encrypted
   *  blob rather than an id anyone would show — carried so a support question can quote it. */
  code: string;
  /** `get-future-withdrawals`: when the row was created. `get-withdrawals`: when the transfer was
   *  made. ISO-ish, PayMe's own `YYYY-MM-DD HH:MM:SS`, their timezone. */
  at: string;
  /** Only on a FUTURE row: the end of the window this money is being paid for, epoch seconds, and
   *  `-1` means the window is still open — i.e. this is the bucket money is accruing into right
   *  now. Measured: six closed daily windows at 0 and one open row holding the whole balance. */
  windowEnd?: number;
  /** Only on a PAST row: PayMe's own description of the transfer ("משיכה לבנק"). */
  description?: string;
}

const withdrawalAgorot = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/**
 * Money PayMe are holding for this seller and have not yet moved to his bank.
 *
 * **This is the number the owner asked for** (CURRENT_TASK סשן א׳ §1: *"איפה המוכר בעצם רואה כמה
 * כסף יועבר לו"*). It is PayMe's own figure and not ours: `seller-balance.ts` says what he EARNED
 * through the mall, which is a different question with a different answer — it knows nothing of
 * their clearing fee, their monthly minimum, a chargeback, or a sale he took outside the platform.
 * Showing our accrual under the words "will be transferred to you" would be a promise we do not
 * make and cannot keep.
 *
 * `currency` is required by the endpoint (measured: it is the first thing it asks for) and the
 * platform is ILS-only.
 */
export async function getFutureWithdrawals(sellerPaymeId: string, creds: PaymeCredentials): Promise<PaymeWithdrawal[]> {
  const res = await callPayme('get-future-withdrawals', {
    seller_payme_id: sellerPaymeId,
    currency: PAYME_CURRENCY,
  }, creds);
  const items = Array.isArray(res.items) ? res.items : [];
  return items.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      totalAgorot: withdrawalAgorot(row.total),
      code: String(row.withdrawal_payme_code ?? ''),
      at: String(row.created_at ?? ''),
      // **Anything that is not a finite number is treated as the OPEN window (-1)**, which is the
      // conservative direction: an open window promises the seller no date, and a dated one does.
      // `Number(row.end_time ?? -1)` alone was not enough — `??` catches null and undefined, and
      // `Number('')` is 0, a value that is neither the sentinel nor a plausible epoch and would
      // have put a date on money PayMe have not dated.
      windowEnd: Number.isFinite(Number(row.end_time)) ? Number(row.end_time) : -1,
    };
  });
}

/**
 * Transfers PayMe have already made to this seller's bank, newest first.
 *
 * The other half of the same screen: a pending figure with no history behind it is a number a
 * seller has no way to believe. Their `page_size` cap is 500; we ask for far less because this is a
 * dashboard strip and not a statement — a seller wanting everything has PayMe's own reporting.
 */
export async function getPastWithdrawals(
  sellerPaymeId: string,
  creds: PaymeCredentials,
  limit = 12,
): Promise<PaymeWithdrawal[]> {
  const res = await callPayme('get-withdrawals', {
    seller_payme_id: sellerPaymeId,
    items_order_by_column: 'withdrawal_created',
    items_order_by_direction: 'desc',
    page_size: limit,
    page: 1,
    language: 'he',
  }, creds);
  const items = Array.isArray(res.items) ? res.items : [];
  return items.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      totalAgorot: withdrawalAgorot(row.withdrawal_total),
      code: String(row.withdrawal_payme_code ?? ''),
      at: String(row.withdrawal_created ?? ''),
      description: String(row.withdrawal_description ?? ''),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions — the SELLER's monthly fee, and the only collection path we have
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything below runs the OPPOSITE way from the checkout, and reading it as "another sale" is the
 * mistake to avoid: here the card belongs to the SELLER and the merchant account is OURS. It is the
 * one thing a seller owes us that has somewhere to be collected from — GO_LIVE §3.0.1 records the
 * hole, and this is the half of it that closes, because the split model leaves us no balance of his
 * to deduct from. PayMe price it at ללא עלות (appendix ב׳) and handle the dunning themselves: a
 * failed iteration is retried daily and the subscription is cancelled on the seventh failure.
 *
 * Measured against the live sandbox 2026-08-23 (`scripts/payme-probe.mjs subscription`), which is
 * where every number in here comes from.
 */

/** PayMe's `sub_iteration_type`. Monthly is the only one this platform bills on. */
export const PAYME_ITERATION_MONTHLY = 3;

/** PayMe's own minimum iteration price, agorot — the same 500 as a sale, documented on their
 *  Generate page. Every tier is far above it; the constant exists so a discount can never quietly
 *  produce a subscription PayMe would refuse. */
export const PAYME_MIN_SUBSCRIPTION_AGOROT = 500;

/**
 * `sub_status`, from their own Subscriptions page — **not the two-value enum their Generate page
 * prints**, which says "0 active, 1 inactive" and is simply wrong: a subscription created here came
 * back `2`, and 0 is not in the real list at all.
 *
 * Kept as PayMe's numbers rather than mapped to words at this layer, for the reason `saleIsPaid`
 * gives: a status nobody has met should be visible as itself instead of bucketed as one we know.
 */
export const PAYME_SUB_STATUS = {
  initial: 1,
  active: 2,
  failed: 4,
  canceled: 5,
  completed: 6,
  retrying: 7,
} as const;

/** Is the seller paying right now? `retrying` counts as paying — PayMe are mid-dunning and will
 *  either succeed or cancel within a week, and taking a working shop off the site on the first
 *  declined card would punish an expired card exactly as hard as a refusal to pay. */
export function subscriptionIsPaying(subStatus: number): boolean {
  return subStatus === PAYME_SUB_STATUS.active || subStatus === PAYME_SUB_STATUS.retrying;
}

export interface GenerateSubscriptionInput {
  /** OURS. See `PaymeCredentials.ownMerchantId` — the partner id is refused with `174`. */
  ownMerchantId: string;
  /** One iteration, agorot. */
  priceAgorot: number;
  description: string;
  /** The seller's card, tokenised. **With it the first iteration is charged immediately and
   *  server-to-server** (measured: `sub_paid: true` on the response), so there is no page for
   *  anyone to visit. Without it PayMe return `sub_url` and the seller pays on their page. */
  buyerKey?: string;
  /** Our own id for this subscription, echoed back on every callback — how a notification finds
   *  the seller it is about without trusting anything else in the body. */
  correlationId: string;
  callbackUrl?: string;
  /** Where PayMe send the seller back after he pays on their page. Only meaningful without a
   *  token — with one there is no page and nobody to send anywhere. */
  returnUrl?: string;
  buyerEmail?: string;
}

export interface GeneratedSubscription {
  /** PayMe's id, and what `cancel-subscription` is called with. */
  subPaymeId: string;
  /** Their numeric status — compare with `PAYME_SUB_STATUS`, never with a literal. */
  subStatus: number;
  /** Present when nobody has paid yet: the page the seller enters a card on. Absent on a token
   *  subscription, which is already paid by the time this returns. */
  subUrl?: string;
  /** When the next iteration is due, PayMe's string. Passed through unparsed — it is display and
   *  reconciliation material, and their format is `YYYY-MM-DD HH:MM:SS`. */
  nextDate?: string;
}

export async function generateSubscription(input: GenerateSubscriptionInput, creds: PaymeCredentials): Promise<GeneratedSubscription> {
  if (input.priceAgorot < PAYME_MIN_SUBSCRIPTION_AGOROT) {
    throw new PaymeError('generate-subscription', -1, `sub_price ${input.priceAgorot} is below PayMe's minimum of ${PAYME_MIN_SUBSCRIPTION_AGOROT}`);
  }
  const res = await callPayme('generate-subscription', {
    seller_payme_id: input.ownMerchantId,
    sub_currency: PAYME_CURRENCY,
    sub_price: input.priceAgorot,
    sub_description: input.description.slice(0, 500),
    sub_iteration_type: PAYME_ITERATION_MONTHLY,
    // 1 = regular. 10 is a template, whose link never expires — a standing payment page for a
    // per-seller charge is not something this platform should be creating.
    sub_type: 1,
    subscription_id: input.correlationId,
    // Their receipts are ours to send, in our own words, from `lib/email/`. Two systems mailing a
    // seller about the same charge is how a support conversation starts.
    sub_send_notification: false,
    ...(input.buyerKey ? { buyer_key: input.buyerKey } : {}),
    ...(input.callbackUrl ? { sub_callback_url: input.callbackUrl } : {}),
    ...(input.returnUrl ? { sub_return_url: input.returnUrl } : {}),
    ...(input.buyerEmail ? { sub_email_address: input.buyerEmail } : {}),
  }, creds);

  const subPaymeId = String(res.sub_payme_id ?? '');
  if (!subPaymeId) throw new PaymeError('generate-subscription', PAYME_OK, 'succeeded without a sub_payme_id');
  const subUrl = String(res.sub_url ?? '');
  const nextDate = String(res.sub_next_date ?? '');
  return {
    subPaymeId,
    subStatus: Number(res.sub_status ?? PAYME_SUB_STATUS.initial),
    // Only when there is still something for a person to do. PayMe return the URL on a token
    // subscription too, already paid, and rendering that as "finish your payment" would send a
    // paying seller to a page that charges him twice.
    ...(subUrl && !input.buyerKey ? { subUrl } : {}),
    ...(nextDate ? { nextDate } : {}),
  };
}

/** Stop billing. Idempotent at their end for our purposes: cancelling an already-cancelled
 *  subscription is refused with a code, never a second charge. */
export async function cancelSubscription(ownMerchantId: string, subPaymeId: string, creds: PaymeCredentials): Promise<void> {
  await callPayme('cancel-subscription', { seller_payme_id: ownMerchantId, sub_payme_id: subPaymeId }, creds);
}

/**
 * Change what a RUNNING subscription charges, without touching the standing order behind it.
 *
 * **This is the whole of a plan change for a seller who is already paying** (owner, 2026-08-24:
 * *"למה לבטל את המנוי? זה רק להחליף את ההוראת קבע שלו מפעם הבאה"*). The obvious alternative —
 * cancel and generate a new subscription — throws away a card the seller already gave us and asks
 * him to authorise it again, for a change he made in one click.
 *
 * ── Measured, not read (`scripts/payme-probe.mjs subscription`, 2026-08-24) ──
 * A live subscription at 9,900 was patched to 12,500 and then to 17,900. Both answered
 * `status_code: 0` with the new `sub_price` echoed back, `sub_status` stayed 2 (active), and
 * `get-subscriptions` afterwards reported 17,900 — so the change lands on the standing arrangement
 * and the next iteration is what charges it. `sub_next_date` did not move.
 *
 * **`payme_client_key` is not required here** — the probe ran it both ways and both were accepted.
 * It is sent anyway, because every other call on this client carries it and an endpoint that
 * authenticates differently from its neighbours is a fact about PayMe, not a licence for us to
 * treat one call as special.
 *
 * The minimum is theirs and it is the same 500 agorot `generate-subscription` enforces; refused
 * here rather than at their end so the failure names the number.
 */
export async function setSubscriptionPrice(
  ownMerchantId: string,
  subPaymeId: string,
  priceAgorot: number,
  creds: PaymeCredentials,
): Promise<void> {
  if (priceAgorot < PAYME_MIN_SUBSCRIPTION_AGOROT) {
    throw new PaymeError('set-price', -1, `sub_price ${priceAgorot} is below PayMe's minimum of ${PAYME_MIN_SUBSCRIPTION_AGOROT}`);
  }
  await sendPayme(
    'PATCH',
    'set-price',
    `subscriptions/${encodeURIComponent(subPaymeId)}/set-price`,
    // A STRING, which is their documented shape for this field and what the probe sent
    // (`"sub_price": "12500"`). Agorot either way — the same unit `generate-subscription` takes.
    { payme_client_key: creds.clientKey, seller_payme_id: ownMerchantId, sub_price: String(priceAgorot) },
    creds,
  );
}

/**
 * What PayMe say this subscription's status is — asked of THEM, never read off a callback body.
 *
 * Same rule as `getSellerStatus`, and for the same reason: `sub_callback_url` is a public address,
 * and a handler that believed `sub_status=2` would let anyone on the internet publish any store on
 * this platform for free.
 *
 * ⚠️ **Matched by id, never `items[0]`.** `get-sales` was measured ignoring its own filter (§12),
 * and no endpoint here may be assumed to behave like another. `null` = PayMe do not know it, which
 * is NOT "cancelled" — writing a verdict from a failed lookup is how a paying seller's shop goes
 * dark.
 */
export async function getSubscriptionStatus(ownMerchantId: string, subPaymeId: string, creds: PaymeCredentials): Promise<{ subStatus: number; nextDate?: string; subUrl?: string } | null> {
  const res = await callPayme('get-subscriptions', { seller_payme_id: ownMerchantId }, creds);
  const items = Array.isArray(res.items) ? res.items as Record<string, unknown>[] : [];
  const found = items.find((i) => String(i.sub_payme_id ?? '') === subPaymeId);
  if (!found) return null;
  const nextDate = String(found.sub_next_date ?? '');
  // Their own payment page, echoed back on the listing (measured). It is what lets a seller who
  // closed the tab be sent to the SAME subscription instead of a second one being created for him.
  const subUrl = String(found.sub_url ?? '');
  return {
    subStatus: Number(found.sub_status ?? PAYME_SUB_STATUS.initial),
    ...(nextDate ? { nextDate } : {}),
    ...(subUrl ? { subUrl } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The callback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this callback really PayMe's?
 *
 * The callback is an ordinary `x-www-form-urlencoded` POST to a public URL, so **anybody on the
 * internet can send one**, and every field in it — including `sale_status: completed` — is a claim
 * by whoever posted it until this returns true. Same class as `checkout-idempotency.ts#checkoutOwner`
 * and `payment-hosted.ts#readReturn`: a reference that arrives from outside proves nothing on its
 * own, and the version of this bug that ships is the handler that reads `sale_status` first.
 *
 * The formula is PayMe's, from their spec (`docs/payme-api-blueprint.md` → MD5 Signature Creation):
 *
 *     md5(payme_client_key + payme_merchant_secret + payme_transaction_id + payme_sale_id)
 *
 * where `payme_merchant_secret` is the per-seller `seller_payme_secret` that `create-seller`
 * returned — which is why that column is stored and why it is a secret.
 *
 * **⚠️ Documented, not measured.** `docs/payme-sandbox-notes.md` says so explicitly: no callback
 * has been received end to end, because that needs a public URL. Everything else in this module was
 * verified against the live sandbox; this one function was not, and the first real callback is the
 * test. Two things follow. It must be exercised against the sandbox with a public tunnel before
 * launch (GO_LIVE §3.1.1), and until then a handler must treat a signature MISMATCH as "reject and
 * alert a person", never as "the formula must be wrong, let it through".
 *
 * MD5 is PayMe's choice and not a security decision of ours — it is a shared-secret construction,
 * so a collision attack does not help an attacker who does not know the secret. The comparison is
 * still `timingSafeEqual`: this runs on every callback and a byte-by-byte early exit leaks the
 * expected digest one character at a time to anyone willing to send enough requests.
 */
export function callbackSignature(input: {
  clientKey: string;
  sellerSecret: string;
  paymeTransactionId: string;
  paymeSaleId: string;
}): string {
  /* MD5 is PayMe's choice of construction, not ours, and this is neither a password hash nor a
   * content digest: it is an HMAC-shaped proof over a SHARED SECRET (`seller_payme_secret`), where
   * the property that matters is that an attacker who does not hold the secret cannot produce the
   * digest. MD5's weakness is collision resistance — finding two inputs with one digest — which
   * buys nothing here, because the attacker controls neither input and can compute neither digest.
   * Swapping in SHA-256 would harden nothing; it would simply stop verifying PayMe's real
   * callbacks. What actually guards this path is `verifyCallbackSignature`'s constant-time compare
   * and its refusal of an empty secret. */
  // eslint-disable-next-line sonarjs/hashing
  const digest = crypto.createHash('md5');
  return digest
    .update(`${input.clientKey}${input.sellerSecret}${input.paymeTransactionId}${input.paymeSaleId}`)
    .digest('hex');
}

export function verifyCallbackSignature(input: {
  clientKey: string;
  sellerSecret: string;
  paymeTransactionId: string;
  paymeSaleId: string;
  signature: string;
}): boolean {
  // A missing secret would otherwise hash to a perfectly valid digest of the empty string, and a
  // seller whose secret failed to store would accept forged callbacks. Refused, loudly-by-absence.
  if (!input.sellerSecret || !input.clientKey) return false;
  const expected = callbackSignature(input);
  const given = String(input.signature ?? '').toLowerCase();
  // `timingSafeEqual` throws on a length mismatch, so the length is checked first — and checking it
  // leaks nothing, because the length of an MD5 hex digest is a constant everyone knows.
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));
}
