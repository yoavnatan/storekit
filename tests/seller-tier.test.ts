/**
 * Choosing a plan — the one seller-facing write that decides what the platform charges him.
 *
 * There was no way to make this choice at all until 2026-08-23 (CURRENT_TASK סשן ב׳): `Seller.tier`
 * was read by the reporting views and by `monthlyFeeForTier`, and written by nothing, so every
 * account on the platform was silently on Starter. The tests below are about the two ways adding a
 * write could go wrong — recording a plan nobody clicked, and reporting one that was not stored.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { parseTierId, sellerMayChangeTier, setSellerTier } from '../src/lib/seller-tier.js';
import { DEFAULT_TIER, SELLER_TIERS, monthlyFeeForTier } from '../src/lib/pricing.js';

async function freshSeller(): Promise<string> {
  const id = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [id, `${id}@example.test`]);
  return id;
}

describe('parseTierId', () => {
  it('accepts every tier the price list actually offers', () => {
    // Written off SELLER_TIERS rather than a literal list, so adding a fifth plan cannot leave the
    // parser silently rejecting the one thing the new card's button sends.
    for (const t of SELLER_TIERS) expect(parseTierId(t.id)).toBe(t.id);
  });

  it('refuses anything else instead of falling back to the default', () => {
    // The asymmetry that matters: READING an unknown stored value falls back to Starter on purpose
    // (pricing.ts#resolveTier — a bad row must not break a dashboard render). WRITING one must not,
    // because a tampered or stale form would otherwise record a plan nobody clicked and bill it.
    for (const bad of ['', 'STARTER', 'free', 'pro ', null, undefined, 0, {}, ['pro']]) {
      expect(parseTierId(bad)).toBeNull();
    }
  });
});

describe('sellerMayChangeTier', () => {
  it('is free until a subscription is running', () => {
    expect(sellerMayChangeTier(false)).toBe(true);
  });

  it('is not free once one is', () => {
    // PayMe hold the monthly amount at their end, so a tier written here while a subscription is
    // live would say ₪199 while the card is still charged ₪99 and nothing on either side would
    // report the gap. The propagation belongs beside the subscription (lib/seller-tier.ts header).
    expect(sellerMayChangeTier(true)).toBe(false);
  });
});

describe('setSellerTier', () => {
  it('stores the choice and hands back what a later charge will read', async () => {
    const id = await freshSeller();
    expect(await setSellerTier(id, 'pro')).toBe('pro');
    // The whole point of the write: the fee the subscription is generated for now follows it.
    expect(monthlyFeeForTier(await storedTier(id))).toBe(
      SELLER_TIERS.find((t) => t.id === 'pro')!.monthlyFee);
  });

  it('is idempotent — the same plan twice is one state', async () => {
    const id = await freshSeller();
    await setSellerTier(id, 'growth');
    expect(await setSellerTier(id, 'growth')).toBe('growth');
    expect(await storedTier(id)).toBe('growth');
  });

  it('a seller who never chose reads as the default rather than as nothing', async () => {
    const id = await freshSeller();
    expect(await storedTier(id)).toBeNull();
    // Nothing is charged for an unchosen plan, but every money surface already treats an empty
    // column as Starter (pricing.ts#DEFAULT_TIER). A page that showed "—" here would be inventing a
    // state the platform does not have.
    expect(monthlyFeeForTier(await storedTier(id))).toBe(
      SELLER_TIERS.find((t) => t.id === DEFAULT_TIER)!.monthlyFee);
  });

  it('answers null for an id that is not a uuid instead of raising', async () => {
    // Postgres REJECTS a malformed uuid literal rather than failing to match it, so a stale session
    // value would be a 500 on the endpoint instead of a 404.
    expect(await setSellerTier('seller-1', 'pro')).toBeNull();
  });
});

async function storedTier(id: string): Promise<string | null> {
  const { rows } = await query<{ tier: string | null }>(`SELECT tier FROM sellers WHERE id = $1`, [id]);
  return rows[0]?.tier ?? null;
}
