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
  /** Our own marketplace merchant account — the one the SHIPPING charge is made against, because
   *  a delivery fee is ours to collect and ours to pay a courier out of. Separate from a seller's
   *  `seller_payme_id`, and absent it the shipping leg cannot run. */
  marketplaceSellerId?: string;
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
  const marketplaceSellerId = serverEnv('PAYME_SELLER_API_ID');
  return {
    clientKey,
    ...(marketplaceSellerId ? { marketplaceSellerId } : {}),
    baseUrl: serverEnv('PAYME_BASE_URL') || 'https://sandbox.payme.io/api/',
  };
}

/** The sandbox is shared with PayMe's other partners and has no delete (`§3.1.1`). Knowing which
 *  environment a call is about to hit is what stops a test run creating merchants in production —
 *  and it is derived from the base URL we deliberately configured, never guessed from an id. */
export function isSandbox(creds: PaymeCredentials): boolean {
  return creds.baseUrl.includes('sandbox.payme.io');
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
  const res = await outboundFetch(`${creds.baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payme_client_key: creds.clientKey, ...body }),
    timeoutMs: 20_000,
  });
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
  const percentPart = Math.round((input.salePriceAgorot * input.marketFeePercent) / 100);
  return percentPart + (input.marketFeeFixedAgorot ?? 0);
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
    sellerPublicKey: String(res.seller_public_key ?? ''),
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
  // Matched on the id rather than taken as `items[0]`. `get-sellers` accepts an ARRAY for every
  // attribute and is a search, not a fetch — so a filter that PayMe ever loosen would silently
  // return somebody else's merchant, and this would write their approval onto our seller.
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
  expiryMonth?: string;
  expiryYear?: string;
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
    ...(input.expiryMonth ? { credit_card_exp_month: input.expiryMonth } : {}),
    ...(input.expiryYear ? { credit_card_exp_year: input.expiryYear } : {}),
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
  /** Charging an existing token — the multi-store path. Cannot coexist with `captureBuyer`. */
  buyerKey?: string;
  /** Ask for a token back alongside this charge. Cannot coexist with `buyerKey`. */
  captureBuyer?: boolean;
  /** Our percentage cut, overriding the merchant's default. `0` is meaningful and must survive:
   *  the shipping sale on our own account takes no market fee at all. */
  marketFeePercent?: number;
  /** AGOROT here; converted to the shekels PayMe want at the edge. See the module header. */
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
