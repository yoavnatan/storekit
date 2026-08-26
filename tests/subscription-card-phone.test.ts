/**
 * The phone PayMe demand for a tokenisation, on the one screen where we might not have one.
 *
 * ── The bug ──
 * Step 3 of the go-live screen — pick a plan, put a card on file — is open from the seller's first
 * minute on purpose (`GoLiveSteps.astro`): it waits on PayMe for nothing, and making it wait was
 * the delay the owner asked to remove. Step 1, the ten-field business form, is where
 * `merchant_kyc.ownerPhone` comes from. So the intended-and-encouraged path — commit to a plan
 * before filling in ten KYC fields — sent `payerPhone: ''` to PayMe, who refused it, and the
 * refusal reached the seller as their own merchant-facing English:
 *
 *     הכרטיס לא התקבל. בדקו את הפרטים ונסו שוב. Please provide "payerPhone" value
 *
 * (owner, 2026-08-26). Three card boxes on screen, none of them the problem.
 *
 * ── What is held here ──
 * Not the rendering of a field, which a screenshot proves better than a test — but the two things
 * that would silently rot: that the request cannot go out with an empty phone, and that a phone
 * typed beside the card is STORED as `ownerPhone` rather than spent on the tokenizer alone. The
 * second is what stops one seller holding two phone numbers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sourceGuard, readSource } from './helpers/source-guard.js';

const state = vi.hoisted(() => ({
  kycSaves: [] as unknown[],
  armedAfter: [] as number[],
}));

vi.mock('../src/lib/seller-auth.js', () => ({
  getSellerSession: () => '11111111-1111-4111-8111-111111111111',
}));

vi.mock('../src/lib/seller-merchant.js', () => ({
  saveMerchantKyc: async (_id: string, input: unknown) => { state.kycSaves.push(input); return {}; },
}));

vi.mock('../src/lib/subscription-arm.js', () => ({
  armSubscriptionCard: async () => {
    // Recorded so the ORDER can be asserted: a phone stored after the arm would leave
    // `stillMissing` reporting a field the same request had just supplied.
    state.armedAfter.push(state.kycSaves.length);
    return { status: 'armed', priceAgorot: 9900 };
  },
  removeArmedCard: async () => true,
}));

vi.mock('../src/lib/seller-subscription.js', () => ({
  startSubscription: async () => ({ status: 'not-configured' }),
  endSubscription: async () => true,
  subscriptionFor: async () => null,
}));

vi.mock('../src/lib/store-publication.js', () => ({
  syncStorePublication: async () => [],
  publishHoldsFor: async () => [],
}));

const { POST } = await import('../src/pages/api/seller/subscription.js');

async function saveCard(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await POST({
    request: new Request('http://localhost/api/seller/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save-card', token: 'tok_abc', ...body }),
    }),
    cookies: {} as never,
  } as never);
  return await res.json() as Record<string, unknown>;
}

beforeEach(() => { state.kycSaves = []; state.armedAfter = []; });

describe('the phone that travels with the subscription card', () => {
  it('stores a phone typed beside the card as ownerPhone, before the card is armed', async () => {
    const body = await saveCard({ phone: '052-123-4567' });

    expect(body['ok']).toBe(true);
    expect(state.kycSaves).toEqual([{ ownerPhone: '052-123-4567' }]);
    // 1 = one save had already happened when the arm ran. Zero would mean `stillMissing` was
    // computed against a record that did not yet hold the phone the seller had just given.
    expect(state.armedAfter).toEqual([1]);
  });

  it('writes nothing when the seller already had a phone on file, so the box sent none', async () => {
    const body = await saveCard({});

    expect(body['ok']).toBe(true);
    expect(state.kycSaves).toEqual([]);
  });

  it('does not write an empty or blank phone over a stored one', async () => {
    await saveCard({ phone: '   ' });
    await saveCard({ phone: '' });
    await saveCard({ phone: 42 });

    expect(state.kycSaves).toEqual([]);
  });
});

describe('the browser cannot tokenise without one', () => {
  it('refuses before calling PayMe rather than showing their English refusal', () => {
    expect(sourceGuard({
      file: 'src/scripts/dashboard/subscription.ts',
      rule: 'the phone is checked for emptiness BEFORE fields.tokenize is called',
      find: (src) => {
        const at = src.indexOf('fields.tokenize');
        if (at < 0) return ['fields.tokenize is gone — this guard is pointing at nothing'];
        const before = src.slice(0, at);
        return /if \(!phone\)/.test(before) ? [] : ['no empty-phone check above fields.tokenize'];
      },
      mustReject: `const phone = fieldsBox.dataset['phone'] ?? '';
        const token = await fields.tokenize({ phone, label: '' });`,
    })).toEqual([]);
  });

  it('asks for a phone exactly when there is none to reuse', () => {
    const src = readSource('src/components/dashboard/SubscriptionCard.astro');
    // Conditional, not unconditional: a seller who filled step 1 has answered this already, and
    // asking twice is the burden `feedback_seller_form_burden` forbids.
    expect(src).toMatch(/\{!payer\.phone && \(/);
    expect(src).toContain('id="sub-card-phone"');
  });
});
