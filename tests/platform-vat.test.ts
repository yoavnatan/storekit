/**
 * What the platform BILLS a seller carries VAT — and the rate is the platform's own status.
 *
 * ── The bug this exists for, found 2026-08-26 ──
 * `pricing.ts` had said since 2026-08-18 that every fee in it is quoted before VAT and that every
 * seller-facing surface must print `+ מע״מ`. The screens did. What was actually charged did not:
 * the standing order was created at the bare plan sum and `market_fee` went to PayMe as the bare
 * percent, so a card was debited 99 ₪ under a screen saying "99 ₪ + מע״מ". It was invisible from
 * either side — every screen was internally consistent, and PayMe were charging exactly what we
 * asked them to.
 *
 * The rule is one sentence with three edges, so all three are pinned here rather than left in a
 * comment: the CHARGE carries the tax, the PLATFORM's own status decides whether there is one, and
 * the SELLER's status decides nothing about it at all (the three planes of the owner's own diagram
 * are in `vat.ts#platformVatPercent`).
 */
import { describe, expect, it } from 'vitest';
import { SELLER_TIERS, feeWithVatAgorot, feeWithVatPercent, commissionOnAgorot } from '../src/lib/pricing.js';
import { billedTotalAgorot, totalFeeAgorot, chargedCommissionPercentForStore, commissionPercentForStore } from '../src/lib/store-plan.js';
import { platformVatPercent, VAT_PERCENT, chargesVat } from '../src/lib/vat.js';
import { toAgorot } from '../src/lib/money.js';

describe('what the platform bills a seller', () => {
  it('adds VAT to the standing order, so the debit matches the screen', () => {
    const lines = [{ storeId: 'a', storeName: 'א', tier: 'starter' as const, feeAgorot: 9900 }];
    expect(totalFeeAgorot(lines)).toBe(9900);
    // 99 × 1.18, written out rather than derived: an assertion computed the same way as the code
    // passes whether or not the code is right.
    expect(billedTotalAgorot(lines)).toBe(11682);
  });

  it('adds VAT to the SUM and not per line, so a breakdown adds up to its total', () => {
    const lines = [
      { storeId: 'a', storeName: 'א', tier: 'growth' as const, feeAgorot: 12500 },
      { storeId: 'b', storeName: 'ב', tier: 'starter' as const, feeAgorot: 9900 },
    ];
    // 224 × 1.18 = 264.32.
    expect(billedTotalAgorot(lines)).toBe(26432);
    expect(billedTotalAgorot(lines)).toBe(feeWithVatAgorot(totalFeeAgorot(lines)));
  });

  it('takes no share of a sale at all, so both rates are zero', () => {
    /* ── This assertion is inverted, and the pair it guards is kept ──
       Until 2026-09-08 the two functions answered two different numbers on purpose:
       `commissionPercentForStore` was the platform's quoted revenue (12%, ex-VAT) and
       `chargedCommissionPercentForStore` was what the processor actually deducted (14.16% — VAT on
       a commission has no line to sit on inside a transaction, so it is charged as a bigger
       percentage). Conflating them overstated our own income by 18%.

       The commission itself is gone: the seller clears into his OWN account, so the buyer's money
       never passes through us. Both functions therefore answer 0, which is the true number, and
       they are kept rather than deleted because `market_fee` is still SENT — the split transport
       is intact and switched off, not removed (`docs/pivot-saas.md`). The distinction is asserted
       below, at a non-zero rate, so the rule survives the day a commission comes back. */
    const store = { tier: 'starter' };
    expect(commissionPercentForStore(store)).toBe(0);
    expect(chargedCommissionPercentForStore(store)).toBe(0);
    expect(commissionOnAgorot(10000, commissionPercentForStore(store))).toBe(0);

    // The two-rate rule itself, proved on a rate rather than on the plan: quoted 12 → charged 14.16,
    // and 10,000 agorot is 1,200 against 1,416. Zeroing the plan must never zero the arithmetic.
    expect(feeWithVatPercent(12)).toBeCloseTo(14.16, 10);
    expect(commissionOnAgorot(10000, 12)).toBe(1200);
    expect(commissionOnAgorot(10000, feeWithVatPercent(12))).toBe(1416);
  });

  it('keeps every plan on the same rule', () => {
    for (const tier of SELLER_TIERS) {
      expect(chargedCommissionPercentForStore({ tier: tier.id })).toBeCloseTo(feeWithVatPercent(tier.commissionPercent), 10);
      expect(billedTotalAgorot([{ storeId: 'x', storeName: 'x', tier: tier.id, feeAgorot: toAgorot(tier.monthlyFee) }]))
        .toBe(feeWithVatAgorot(toAgorot(tier.monthlyFee)));
    }
  });

  /**
   * ── The rate is OURS, and an עוסק פטור platform charges none ──
   * Driven through the parameter rather than through `process.env`: the arithmetic is proved at
   * both rates without a test mutating global state another file's test could observe.
   */
  it('bills NET when the platform itself is exempt', () => {
    // Untouched, not zeroed: with no tax to add, the fee IS the charge and the rate IS the rate.
    expect(feeWithVatAgorot(9900, 0)).toBe(9900);
    expect(feeWithVatPercent(12, 0)).toBe(12);
  });

  it('defaults to charging VAT when nothing is configured', () => {
    // Over-collecting is a refund; under-collecting is a debt to רשות המסים on money already spent.
    expect(platformVatPercent()).toBe(VAT_PERCENT);
  });

  /** The seller's own status changes what he is SHOWN and never what he is charged — the confusion
   *  that would put VAT on a fee because the SELLER happens to be registered. `chargesVat` answers a
   *  question about HIS invoice to a buyer, and nothing about ours to him. */
  it("does not let the seller's own status change the fee", () => {
    expect(chargesVat('exempt')).toBe(false);
    expect(chargesVat('licensed')).toBe(true);
    expect(billedTotalAgorot([{ storeId: 'a', storeName: 'א', tier: 'starter', feeAgorot: 9900 }])).toBe(11682);
  });
});
