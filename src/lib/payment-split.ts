/**
 * One card, one authorization, one capture per store — PayMe's own multi-seller design.
 *
 * **The model (2026-08-21).** The platform never holds a shekel of a seller's money: each store's
 * share lands in that store's own merchant account, with our commission taken inside the same
 * transaction as PayMe's `market_fee`.
 *
 * **The mechanism (rewritten 2026-08-23, and the rewrite is the point).** This file used to take a
 * permanent buyer token and charge it once per store — N independent sales. That works, and was
 * measured working, but it is not what PayMe do. Asked directly whether their API supports paying
 * several sellers in one purchase, they pointed at MULTI-CAPTURE, whose own prerequisite reads
 * *"at least 2 users from the same marketplace"*:
 *
 *   1. `generate-sale` `sale_type: 'authorize'` — ONE hold on the buyer's card for the whole cart.
 *   2. `generate-sale` `sale_type: 'multi-capture'` + `origin_sale_id` — one per store, each naming
 *      that store's own merchant, each drawing a slice of the same authorization.
 *
 * One authorization instead of N charges is also the answer to the owner's objection that a buyer
 * should not see a row per shop on their statement. ⚠️ That it really collapses to one row is NOT
 * verified — it is the issuer's presentation, not something the API states — and it is the reason
 * the change was made, so it must be checked on a real card before it is claimed.
 *
 * **An earlier session recorded multi-capture as unavailable to us.** It had called `capture-sale`,
 * the single-capture endpoint. `docs/payme-sandbox-notes.md` §14 has the measurements that replaced
 * that conclusion, including the ₪40-to-A-then-₪60-to-B run this file is built on.
 *
 * ── Where the delivery fee goes, and why it is not its own charge ──
 * It was, until 2026-08-23, "a separate sale on OUR merchant account" — and there is no such
 * account: `PAYME_SELLER_API_ID` is the partner identity, and charging it is refused
 * `174 · not supported for users of this type` (§15). So delivery rides on each store's capture as
 * `market_fee_fixed`, which is exactly what PayMe told the owner to do when he asked how a delivery
 * fee reaches us. Their reply also promised the ceiling would be raised for it, which is needed:
 * ₪10 of goods with ₪30 of delivery makes our cut 87% of that capture, over the 60% cap (`308`).
 *
 * ── The ordering rule still holds ──
 * `lib/payment.ts` argues it: an order may exist only if money was really taken, and money may be
 * taken only if the order really exists. The authorization is the reversible half — measured,
 * `refund-sale` on an uncaptured authorization answers `voided` — so orders are written before any
 * capture, and a checkout abandoned between the two costs the buyer nothing.
 */
import {
  generateSale, refundSale, refuseSale, saleIsPaid, PaymeError,
  PAYME_MIN_SALE_AGOROT,
  type PaymeCredentials,
} from './payment-payme.js';

/** One store's slice, as it will be captured. */
export interface StoreCharge {
  storeSlug: string;
  /** The seller's PayMe merchant id. Absent means the store cannot sell at all
   *  (`lib/seller-merchant.ts`), and `planSplit` refuses the whole checkout rather than the line. */
  sellerPaymeId: string | undefined;
  /** Goods minus the seller's order discount, in AGOROT. */
  goodsAgorot: number;
  /** This store's delivery fee, in AGOROT. Captured SEPARATELY, to our own merchant account — see
   *  `SplitInput.deliveryMerchantId`. Zero for self-pickup. */
  shippingAgorot: number;
  /** This seller's tier commission (`lib/pricing.ts`), passed per capture rather than relying on the
   *  merchant's stored default — so a tier change takes effect on the next sale. */
  marketFeePercent: number;
  productName: string;
}

export interface SplitInput {
  /** The buyer's token from Hosted Fields. Used ONCE, on the authorization. */
  buyerKey: string;
  stores: StoreCharge[];
  /**
   * OUR OWN merchant account, which the delivery captures land in.
   *
   * **Not the partner id** — that cannot receive money at all (`174`, measured), and mistaking the
   * two is what sent an earlier version of this file down the fixed-fee route. This is an ordinary
   * merchant account opened with `create-seller` like any seller's, and a capture to it was measured
   * working from an authorization created on a DIFFERENT seller.
   *
   * Absent means delivery cannot be charged and `planSplit` refuses the cart rather than quietly
   * giving the delivery away.
   */
  deliveryMerchantId: string | undefined;
  /** Our reference for the purchase; every PayMe `transaction_id` below derives from it. */
  checkoutRef: string;
  buyerEmail?: string;
  buyerName?: string;
  callbackUrl?: string;
}

export type SplitRefusal =
  | { reason: 'store-cannot-sell'; storeSlug: string }
  | { reason: 'store-below-minimum'; storeSlug: string; amountAgorot: number }
  /** Our cut would breach the 60% cap. Reachable in ordinary trading now that delivery rides on the
   *  capture — a cheap item with real delivery is 87% — which is why PayMe were asked to raise it. */
  | { reason: 'store-fee-ceiling'; storeSlug: string }
  /** Delivery to charge and no merchant account of ours to charge it to. */
  | { reason: 'no-delivery-merchant' }
  /** A non-zero delivery total under PayMe's minimum sale. Unreachable at the platform's own
   *  rates; pinned by a test so a future rate cannot introduce it quietly. */
  | { reason: 'delivery-below-minimum'; amountAgorot: number }
  | { reason: 'nothing-to-charge' };

export interface SplitLeg {
  /** `'store'` captures goods to that seller; `'delivery'` captures the cart's delivery to us. */
  kind: 'store' | 'delivery';
  /** Absent on the delivery leg, which belongs to the cart rather than to one shop. */
  storeSlug?: string;
  sellerPaymeId: string;
  /** Goods + delivery. What this capture draws from the authorization. */
  amountAgorot: number;
  marketFeePercent: number;
  productName: string;
  /** Deterministic from the checkout reference. A correlation id, **not** an idempotency key —
   *  PayMe document nothing about refusing a repeat and that behaviour is unmeasured. */
  transactionId: string;
}

export interface SplitPlan {
  refusals: SplitRefusal[];
  legs: SplitLeg[];
  /** What the authorization must hold: every leg's amount. Captures may not exceed it — measured,
   *  a further ₪1 on a fully-drawn ₪100 authorization is refused `352`. */
  authorizeAgorot: number;
  /** Whose merchant the authorization is created on. Any of the cart's sellers will do: an
   *  authorization on seller A was measured being captured by seller B. The first store, so the
   *  choice is deterministic and reproducible from the order rows. */
  authorizeOn: string;
}

/**
 * Everything PayMe would refuse, worked out before the buyer's card is touched.
 *
 * Every refusal is collected rather than only the first, so a buyer is told about all the lines they
 * have to fix instead of one per attempt.
 */
export function planSplit(input: SplitInput): SplitPlan {
  const refusals: SplitRefusal[] = [];
  const legs: SplitLeg[] = [];

  for (const store of input.stores) {
    if (!store.sellerPaymeId) {
      refusals.push({ reason: 'store-cannot-sell', storeSlug: store.storeSlug });
      continue;
    }
    // GOODS ONLY. Delivery is captured separately, to our own merchant account, so it is not part
    // of the seller's sale and takes no part in his 60% ceiling.
    const refusal = refuseSale({
      salePriceAgorot: store.goodsAgorot,
      marketFeePercent: store.marketFeePercent,
    });
    if (refusal === 'below-minimum') {
      refusals.push({ reason: 'store-below-minimum', storeSlug: store.storeSlug, amountAgorot: store.goodsAgorot });
      continue;
    }
    if (refusal === 'market-fee-ceiling') {
      refusals.push({ reason: 'store-fee-ceiling', storeSlug: store.storeSlug });
      continue;
    }
    legs.push({
      kind: 'store',
      storeSlug: store.storeSlug,
      sellerPaymeId: store.sellerPaymeId,
      amountAgorot: store.goodsAgorot,
      marketFeePercent: store.marketFeePercent,
      productName: store.productName,
      transactionId: `${input.checkoutRef}-${store.storeSlug}`,
    });
  }

  // ONE delivery capture for the whole cart, last. Each PayMe transaction costs a flat fee
  // (agreement, appendix bet), and this money is ours either way — so there is nothing to gain from
  // one capture per shop. `market_fee: 0`, because a commission on our own capture would be us
  // taking a cut from ourselves and the ledger would stop closing.
  const deliveryAgorot = input.stores.reduce((sum, st) => sum + st.shippingAgorot, 0);
  if (deliveryAgorot > 0) {
    if (!input.deliveryMerchantId) {
      refusals.push({ reason: 'no-delivery-merchant' });
    } else if (deliveryAgorot < PAYME_MIN_SALE_AGOROT) {
      // Unreachable at the platform's own rates and pinned by a test, so a future rate cannot make
      // it reachable in silence.
      refusals.push({ reason: 'delivery-below-minimum', amountAgorot: deliveryAgorot });
    } else {
      legs.push({
        kind: 'delivery',
        sellerPaymeId: input.deliveryMerchantId,
        amountAgorot: deliveryAgorot,
        marketFeePercent: 0,
        productName: 'משלוח',
        transactionId: `${input.checkoutRef}-delivery`,
      });
    }
  }

  if (!legs.length && !refusals.length) refusals.push({ reason: 'nothing-to-charge' });

  return {
    refusals,
    legs,
    authorizeAgorot: legs.reduce((sum, l) => sum + l.amountAgorot, 0),
    authorizeOn: legs.find((l) => l.kind === 'store')?.sellerPaymeId ?? legs[0]?.sellerPaymeId ?? '',
  };
}

export interface CapturedLeg extends SplitLeg {
  paymeSaleId: string;
  /** **PayMe's own figure for what they kept for us on this capture** (`sale_market_fee_total`),
   *  carried up so the caller can compare it with what our pricing said it would be
   *  (`lib/commission-check.ts`). It used to be dropped here, which is why a disagreement between
   *  the rate on a seller's dashboard and the money really deducted from his sale was invisible on
   *  both sides. Absent when they did not report one — which is not a mismatch. */
  marketFeeTotalAgorot?: number;
}

/** Money taken that could not be given back. A real person is out real money and nothing else
 *  points at it. */
export interface UnrefundedCharge {
  leg: CapturedLeg;
  error: string;
}

export type SplitResult =
  | { ok: true; authorizationId: string; captures: CapturedLeg[] }
  | {
      ok: false;
      /** Buyer-safe machine reason, never PayMe's merchant-facing Hebrew. */
      error: string;
      detail: string;
      failedAt?: SplitLeg;
      /** True when the authorization was released without a single capture — the buyer's card was
       *  held for a moment and nothing was taken. */
      voided: boolean;
      refunded: CapturedLeg[];
      /** ‼️ Captures nobody could give back. Each is a manual refund somebody owes. */
      unrefunded: UnrefundedCharge[];
    };

/**
 * Hold the whole cart on the buyer's card. Takes nothing.
 *
 * Separate from the captures because the ordering rule needs it to be: the order rows are written
 * between the two, so that money moves only once an order provably exists. An authorization that is
 * never captured is released by `releaseAuthorization`, and costs the buyer nothing.
 */
export async function authorizeCart(input: SplitInput, plan: SplitPlan, creds: PaymeCredentials): Promise<{ ok: true; authorizationId: string } | { ok: false; detail: string }> {
  if (!plan.legs.length || !plan.authorizeOn) return { ok: false, detail: 'nothing to authorize' };
  try {
    const auth = await generateSale({
      sellerPaymeId: plan.authorizeOn,
      salePriceAgorot: plan.authorizeAgorot,
      productName: `הזמנה ${input.checkoutRef}`,
      transactionId: input.checkoutRef,
      buyerKey: input.buyerKey,
      saleType: 'authorize',
      // No market fee on the AUTHORIZATION. Our cut is taken on each capture, where it belongs to a
      // particular seller; charging it here would attribute the whole cart's commission to whichever
      // store happened to be first.
      marketFeePercent: 0,
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
      ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
      ...(input.buyerName ? { buyerName: input.buyerName } : {}),
    }, creds);
    return { ok: true, authorizationId: auth.paymeSaleId };
  } catch (err) {
    return { ok: false, detail: err instanceof PaymeError ? err.message : err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Draw each store's slice out of the authorization.
 *
 * Sequential, not concurrent: a failure arriving while other captures are still in flight would
 * leave the compensation unwinding transactions that do not exist yet. In order, the set to unwind
 * is always exactly the set already completed.
 *
 * A capture that answers success with a status other than `completed` is treated as a FAILURE and
 * unwound — guessing that an unknown status means paid is how an unpaid order becomes shippable.
 */
export async function captureSlices(
  authorizationId: string,
  input: SplitInput,
  plan: SplitPlan,
  creds: PaymeCredentials,
): Promise<SplitResult> {
  const captured: CapturedLeg[] = [];

  for (const leg of plan.legs) {
    let failure: string | null = null;
    try {
      const sale = await generateSale({
        sellerPaymeId: leg.sellerPaymeId,
        salePriceAgorot: leg.amountAgorot,
        productName: leg.productName,
        transactionId: leg.transactionId,
        saleType: 'multi-capture',
        originSaleId: authorizationId,
        // `0` on the delivery leg, and it must survive as 0 rather than being dropped as falsy:
        // omitting the field falls back to the merchant's stored default, which would take a fee
        // nobody agreed to — out of our own capture.
        marketFeePercent: leg.marketFeePercent,
        ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
      }, creds);
      captured.push({
        ...leg,
        paymeSaleId: sale.paymeSaleId,
        ...(sale.marketFeeTotalAgorot !== undefined ? { marketFeeTotalAgorot: sale.marketFeeTotalAgorot } : {}),
      });
      if (!saleIsPaid(sale.saleStatus)) {
        failure = `capture ${sale.paymeSaleId} came back '${sale.saleStatus || 'unknown'}', not completed`;
      }
    } catch (err) {
      failure = err instanceof PaymeError ? err.message : err instanceof Error ? err.message : String(err);
    }

    if (failure) {
      const unwound = await refundAll(captured, creds);
      // Nothing was captured, so the hold itself is what has to go. `refund-sale` on an uncaptured
      // authorization answers `voided` (measured) — the buyer is left owing nothing at all.
      const voided = captured.length === 0
        ? (await releaseAuthorization(plan.authorizeOn, authorizationId, creds)).ok
        : false;
      return {
        ok: false,
        error: 'payment-failed',
        detail: `${leg.kind === 'delivery' ? 'delivery' : `store ${leg.storeSlug}`}: ${failure}`,
        failedAt: leg,
        voided,
        refunded: unwound.refunded,
        unrefunded: unwound.unrefunded,
      };
    }
  }

  return { ok: true, authorizationId, captures: captured };
}

/**
 * Release a hold that will never be captured — an abandoned checkout, or a failure before the first
 * capture. Measured: `refund-sale` against an uncaptured authorization answers `voided`.
 */
export async function releaseAuthorization(sellerPaymeId: string, authorizationId: string, creds: PaymeCredentials): Promise<{ ok: boolean; error?: string }> {
  try {
    await refundSale({ sellerPaymeId, paymeSaleId: authorizationId }, creds);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Give back every capture, and never throw.
 *
 * It runs inside a failure path that still has to restock, release the idempotency claim and log — a
 * compensation that can itself throw turns one bad outcome into four. Its own failures come back in
 * `unrefunded`, because "we could not give it back" is the one case a person must handle by hand.
 *
 * FULL refunds, carrying no amount: the 500-agorot floor applies to PARTIAL refunds only, so
 * refunding by amount would be refused on exactly the small orders that most need giving back.
 */
async function refundAll(captured: CapturedLeg[], creds: PaymeCredentials): Promise<{ refunded: CapturedLeg[]; unrefunded: UnrefundedCharge[] }> {
  const refunded: CapturedLeg[] = [];
  const unrefunded: UnrefundedCharge[] = [];
  // Newest first, so the charge a buyer's banking app is most likely showing them goes first.
  for (const leg of [...captured].reverse()) {
    try {
      await refundSale({ sellerPaymeId: leg.sellerPaymeId, paymeSaleId: leg.paymeSaleId }, creds);
      refunded.push(leg);
    } catch (err) {
      unrefunded.push({ leg, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { refunded, unrefunded };
}

/**
 * Give back one store's slice after the fact — a cancelled order, an accepted return.
 *
 * Separate from the unwinding above because the situation differs where it matters: there nothing
 * had settled and the purchase is being erased; here an order really happened and part of it is
 * being reversed. So the amount is explicit and the 500-agorot partial floor really applies, which
 * `refundSale` refuses below rather than silently rounding up — a ₪3 remainder is not refundable in
 * part, and the caller has to know that instead of being told a refund succeeded.
 *
 * Pass no amount to reverse the whole capture, which is allowed at any size.
 */
export async function refundStoreCapture(
  input: { sellerPaymeId: string; paymeSaleId: string; amountAgorot?: number },
  creds: PaymeCredentials,
): Promise<{ ok: true; saleStatus: string } | { ok: false; error: string }> {
  try {
    const res = await refundSale({
      sellerPaymeId: input.sellerPaymeId,
      paymeSaleId: input.paymeSaleId,
      ...(input.amountAgorot !== undefined ? { refundAmountAgorot: input.amountAgorot } : {}),
    }, creds);
    return { ok: true, saleStatus: res.saleStatus };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
