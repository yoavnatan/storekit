/**
 * One card entry, N charges — the split model's checkout, composed out of `payment-payme.ts`.
 *
 * **The model (2026-08-21, AI_INSTRUCTIONS → Payment architecture).** The platform never holds a
 * shekel of a seller's money. The buyer types a card ONCE; each store's goods are charged straight
 * into that store's own merchant account, with our commission taken inside the same transaction as
 * PayMe's `market_fee`; and the delivery fee is a SEPARATE charge on OUR merchant account, because
 * it is ours to collect and ours to pay a courier out of.
 *
 * ── Why shipping is its own charge and not a fixed fee on the seller's sale ──
 * `market_fee_fixed` would carry it, and that is what it was found for — but our total cut is
 * capped at 60% of the sale and a cheap item with a real delivery charge blows straight through it
 * (₪10 of goods + ₪30 delivery ≈ 87%, measured refused). A separate sale on our own account with
 * `market_fee: 0` touches no ceiling at all, and was measured working with the same buyer token.
 * So `market_fee_fixed` exists in the adapter, is proven, and is deliberately unused here.
 *
 * ── The ordering rule still holds, and this shape keeps it better than authorize/capture did ──
 * `lib/payment.ts` argues it at length: an order may exist only if money was really taken, and
 * money may be taken only if the order really exists. There is no authorization spanning N
 * merchants, so the reversible-first trick is a different one here — **the buyer's TOKEN is the
 * reversible step.** A token is not money: it can be taken, and the checkout abandoned, and nobody
 * is out anything. So the sequence is
 *
 *   1. token          — the buyer's card, once. Nothing charged. (Hosted Fields, before this file.)
 *   2. `planSplit`    — every refusal PayMe would give us, answered from the numbers in hand,
 *                       BEFORE a single charge exists. This is what stops store one being charged
 *                       and store two turning out to be unchargeable.
 *   3. order rows     — written pending.
 *   4. `chargeSplit`  — the irreversible step, and by now the orders provably exist.
 *
 * ── All-or-nothing, and the compensation is a REFUND, not a void ──
 * There is no hold to release: each `generate-sale` on a token completes immediately. So a failure
 * at charge k means refunding charges 1…k−1, in full. A full refund carries no amount, which is
 * what makes it safe at any size — PayMe's 500-agorot minimum applies to PARTIAL refunds only, so a
 * ₪3 slice that could never be partially refunded can still be given back whole.
 *
 * A refund that itself fails is the one outcome that costs a real person real money with nothing
 * pointing at it, so it is never swallowed: it comes back in the result, it is journalled by the
 * caller, and `lib/refund-owed.ts` is where the obligation lives until somebody settles it.
 */
import {
  generateSale, refundSale, refuseSale, saleIsPaid,
  PAYME_MIN_SALE_AGOROT, PaymeError,
  type PaymeCredentials,
} from './payment-payme.js';

/** One store's slice, as it will be charged: the seller's own merchant account, his goods, our
 *  commission. **Goods only — shipping is not in here**, because it is charged separately below. */
export interface StoreCharge {
  storeSlug: string;
  /** The seller's PayMe merchant id. Absent is not an error to discover here — `planSplit` refuses
   *  the whole checkout, because a store with no merchant account cannot be sold from at all
   *  (`lib/seller-merchant.ts`). */
  sellerPaymeId: string | undefined;
  /** Goods minus the seller's order discount, in AGOROT. Not the order total: the shipping part of
   *  that total is charged to us, on the separate sale below. */
  goodsAgorot: number;
  /** This seller's tier commission (`lib/pricing.ts#commissionPercentForTier`) — passed per sale
   *  rather than relying on the merchant's stored default, so a tier change takes effect on the
   *  next sale instead of needing a round trip to PayMe. */
  marketFeePercent: number;
  /** Shown to the buyer and on the seller's invoice. */
  productName: string;
}

export interface SplitInput {
  /** The permanent buyer token. One card entry; every charge below runs off it. */
  buyerKey: string;
  stores: StoreCharge[];
  /** Every store's delivery fee, summed into ONE charge on our own account. Zero means there is
   *  nothing to charge — a self-pickup-only cart — and the leg is skipped rather than sent as a
   *  zero sale. Each PayMe transaction costs us ₪1 flat (agreement, appendix ב׳), so this is one
   *  charge for the cart and not one per store. */
  shippingAgorot: number;
  /** Our own marketplace merchant account, which the shipping charge lands in. */
  marketplaceSellerId: string | undefined;
  /** Our reference for the whole purchase. Every PayMe `transaction_id` below is derived from it,
   *  so their records and ours can be matched without a lookup table. */
  checkoutRef: string;
  buyerEmail?: string;
  buyerName?: string;
  callbackUrl?: string;
}

/** Why a checkout cannot be charged at all — answered before any money moves, and machine-readable
 *  because the caller decides what a buyer is told. */
export type SplitRefusal =
  /** This store's seller has no merchant account, so there is nowhere for his money to go. */
  | { reason: 'store-cannot-sell'; storeSlug: string }
  /** Below PayMe's 500-agorot minimum. Names the store so the page can say which line. */
  | { reason: 'store-below-minimum'; storeSlug: string; amountAgorot: number }
  /** Our cut would breach the 60% ceiling. Should be unreachable with commissions in the 10–12%
   *  band `lib/pricing.ts` sets, and is checked anyway — a tier table is an edit away from making
   *  it reachable, and the failure would otherwise be a live refused charge. */
  | { reason: 'store-fee-ceiling'; storeSlug: string }
  /** A non-zero delivery fee under the minimum cannot be charged, and there is nowhere to fold it:
   *  putting it on a seller's sale is the 60% ceiling problem this design exists to avoid.
   *  Unreachable with the current ₪20/₪30 platform rates, and pinned by a test so a future rate
   *  cannot introduce it silently. */
  | { reason: 'shipping-below-minimum'; amountAgorot: number }
  /** A cart has delivery to charge and we have no merchant account configured to charge it on. */
  | { reason: 'no-marketplace-account' };

export interface SplitPlan {
  /** Empty means chargeable. Every refusal is collected rather than only the first, so a buyer is
   *  told about all the lines they have to fix instead of one per attempt. */
  refusals: SplitRefusal[];
  /** What will actually be charged, in order: sellers first, our shipping charge last. */
  legs: SplitLeg[];
}

export interface SplitLeg {
  kind: 'store' | 'shipping';
  /** Whose merchant account. Resolved here, so `chargeSplit` never has to ask again. */
  sellerPaymeId: string;
  storeSlug?: string;
  amountAgorot: number;
  marketFeePercent: number;
  productName: string;
  /** Deterministic from the checkout reference, so the same purchase always produces the same
   *  references at PayMe. **This is a correlation id and NOT an idempotency key** — PayMe document
   *  `transaction_id` as "merchant's unique sale ID for correlation with us" and say nothing about
   *  refusing a repeat, and that behaviour is UNMEASURED. Our own guard is
   *  `lib/checkout-idempotency.ts`; do not let this look like a second one. */
  transactionId: string;
}

/**
 * Everything that would refuse this checkout, worked out before any of it is charged.
 *
 * This is the step that makes the split safe. Without it, a two-store cart whose second slice is
 * ₪4 charges store one, gets refused by store two, and has to unwind a completed charge on a real
 * card — for a condition that was fully knowable from the numbers a moment earlier.
 *
 * **Sellers first, shipping last, and the order is deliberate.** A seller's leg is the one that can
 * fail for reasons outside our sight — PayMe review each business and may restrict one at their own
 * discretion (agreement §11) — while the shipping leg runs on an account we control and monitor.
 * Charging the risky legs first means the common failure unwinds fewer completed charges.
 */
export function planSplit(input: SplitInput): SplitPlan {
  const refusals: SplitRefusal[] = [];
  const legs: SplitLeg[] = [];

  for (const store of input.stores) {
    if (!store.sellerPaymeId) {
      refusals.push({ reason: 'store-cannot-sell', storeSlug: store.storeSlug });
      continue;
    }
    const refusal = refuseSale({ salePriceAgorot: store.goodsAgorot, marketFeePercent: store.marketFeePercent });
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
      sellerPaymeId: store.sellerPaymeId,
      storeSlug: store.storeSlug,
      amountAgorot: store.goodsAgorot,
      marketFeePercent: store.marketFeePercent,
      productName: store.productName,
      transactionId: `${input.checkoutRef}-${store.storeSlug}`,
    });
  }

  if (input.shippingAgorot > 0) {
    if (!input.marketplaceSellerId) {
      refusals.push({ reason: 'no-marketplace-account' });
    } else if (input.shippingAgorot < PAYME_MIN_SALE_AGOROT) {
      refusals.push({ reason: 'shipping-below-minimum', amountAgorot: input.shippingAgorot });
    } else {
      legs.push({
        kind: 'shipping',
        sellerPaymeId: input.marketplaceSellerId,
        amountAgorot: input.shippingAgorot,
        // Zero, and it must survive as zero: this sale is already entirely ours, so a market fee on
        // it would be us taking a commission from ourselves and would make the ledger stop closing.
        marketFeePercent: 0,
        productName: 'משלוח',
        transactionId: `${input.checkoutRef}-shipping`,
      });
    }
  }

  return { refusals, legs };
}

/** A charge that went through, kept so it can be given back if a later one does not. */
export interface ChargedLeg extends SplitLeg {
  paymeSaleId: string;
}

/** Money that was taken and could not be given back. The single most important thing this module
 *  can report: a real person is out real money and nothing else points at it. */
export interface UnrefundedCharge {
  leg: ChargedLeg;
  error: string;
}

export type SplitResult =
  | { ok: true; charges: ChargedLeg[] }
  | {
      ok: false;
      /** Buyer-safe: a machine reason, never PayMe's Hebrew merchant-facing prose. */
      error: string;
      /** For the journal and the alert. Not for a buyer. */
      detail: string;
      /** Which leg refused. */
      failedAt?: SplitLeg;
      /** Charges that were successfully given back. Nobody is owed anything for these. */
      refunded: ChargedLeg[];
      /** ‼️ Charges that could NOT be given back. Each one is a manual refund somebody owes. */
      unrefunded: UnrefundedCharge[];
    };

/**
 * Charge every leg, and give everything back if any of them refuses.
 *
 * Sequential, not `Promise.all`, and that is not a performance oversight. Concurrent charges would
 * mean a failure arriving while other charges are still in flight, so the compensation would have
 * to refund transactions that do not exist yet — a race with real money in it. Charging in order
 * means the set to unwind is always exactly the set already completed.
 *
 * A leg that answers success with a status that is not `completed` is treated as a FAILURE and
 * unwound. PayMe's `authorized` is a hold and this platform's rule is that an order exists only
 * when money really moved; anything else is a status this code has not met, and guessing that an
 * unknown status means "paid" is how an unpaid order becomes shippable.
 */
export async function chargeSplit(input: SplitInput, plan: SplitPlan, creds: PaymeCredentials): Promise<SplitResult> {
  const charged: ChargedLeg[] = [];

  for (const leg of plan.legs) {
    let failure: string | null = null;
    try {
      const sale = await generateSale({
        sellerPaymeId: leg.sellerPaymeId,
        salePriceAgorot: leg.amountAgorot,
        productName: leg.productName,
        transactionId: leg.transactionId,
        buyerKey: input.buyerKey,
        marketFeePercent: leg.marketFeePercent,
        ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
        ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
        ...(input.buyerName ? { buyerName: input.buyerName } : {}),
      }, creds);
      if (!saleIsPaid(sale.saleStatus)) {
        failure = `sale ${sale.paymeSaleId} came back '${sale.saleStatus || 'unknown'}', not completed`;
        // The sale EXISTS even though it is not paid, so it is recorded before unwinding: refunding
        // an unpaid sale is a no-op PayMe will refuse, and that refusal is information, not a bug.
        charged.push({ ...leg, paymeSaleId: sale.paymeSaleId });
      } else {
        charged.push({ ...leg, paymeSaleId: sale.paymeSaleId });
      }
    } catch (err) {
      failure = err instanceof PaymeError ? err.message : err instanceof Error ? err.message : String(err);
    }

    if (failure) {
      const unwound = await refundAll(charged, creds);
      return {
        ok: false,
        // The one thing a buyer is told, and it is true whatever the leg was: nothing they were
        // charged is being kept. Never PayMe's own message — it is Hebrew merchant prose and can
        // name another seller's account.
        error: 'payment-failed',
        detail: `${leg.kind === 'shipping' ? 'shipping' : `store ${leg.storeSlug}`}: ${failure}`,
        failedAt: leg,
        refunded: unwound.refunded,
        unrefunded: unwound.unrefunded,
      };
    }
  }

  return { ok: true, charges: charged };
}

/**
 * Give back everything in `charged`, and never throw.
 *
 * It runs inside a failure path that still has to restock, release the idempotency claim and log —
 * a compensation that can itself throw turns one bad outcome into four. Its own failures are not
 * swallowed either: they come back in `unrefunded`, because "we could not give it back" is the one
 * case a person must handle by hand.
 *
 * A FULL refund (no amount) on purpose: partial refunds have a 500-agorot floor, so refunding a
 * slice by amount would be refused on exactly the small orders that most need giving back.
 */
async function refundAll(charged: ChargedLeg[], creds: PaymeCredentials): Promise<{ refunded: ChargedLeg[]; unrefunded: UnrefundedCharge[] }> {
  const refunded: ChargedLeg[] = [];
  const unrefunded: UnrefundedCharge[] = [];
  // Newest first, so the most recent charge — the one a buyer's banking app is most likely showing
  // them right now — is the first to disappear.
  for (const leg of [...charged].reverse()) {
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
 * Separate from the unwinding above because the situation is different in the way that matters:
 * there, nothing had settled and the whole purchase is being erased; here an order really happened
 * and part of it is being reversed. The amount is therefore explicit and the 500-agorot partial
 * floor really applies, which is why `refundSale` refuses below it rather than silently rounding up
 * — a ₪3 remainder is not refundable in part, and the caller has to know that instead of being
 * told a refund succeeded.
 *
 * Pass no amount to reverse the whole sale, which is always allowed at any size.
 */
export async function refundStoreCharge(
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
