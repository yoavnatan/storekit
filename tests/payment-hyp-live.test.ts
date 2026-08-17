/**
 * The Hyp integration, proved against Hyp's own servers — not mocked.
 *
 * **Opt-in, and it must stay that way.** It runs only with `HYP_LIVE=1`, so `npm run verify` never
 * reaches it. Everything else in `tests/` is hermetic; this one drives a real browser against a
 * third party's payment page, which makes it slow, dependent on their uptime, and dependent on the
 * markup of a page we do not own. Those are all disqualifying properties for a gate and none of
 * them are disqualifying for a PROOF, which is what this is: the answer to the one question
 * CURRENT_TASK asks about Hyp — *can they hold an amount now and take it later, as two separate
 * operations?* — obtained by doing it rather than by reading that they can.
 *
 *     HYP_LIVE=1 npx vitest run tests/payment-hyp-live.test.ts
 *
 * It uses Hyp's PUBLIC demo terminal and Hyp's PUBLISHED test card. No account, no contract, no
 * conversation with them, and no real money — which is the whole reason Hyp is the provider we
 * could build against before choosing one commercially (memory `project_provider_sandbox_access`).
 *
 * What a green run establishes, in order:
 *   1. A J5 authorization can be raised from our own signed request  → `CCode=700`.
 *   2. Hyp confirms the redirect is genuinely theirs                 → VERIFY answers `CCode=0`.
 *   3. The card can be tokenised without us ever touching card data  → a token comes back.
 *   4. The hold can be captured for LESS than was held               → 7₪ taken out of 10₪ held.
 *
 * Step 4 is the one that matters beyond Hyp: partial capture is what the ad-budget model needs
 * (`project_boost_billing_model` — a budget is a ceiling, unspent is never charged), and it is the
 * property a provider is least likely to have.
 */
import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright';
import {
  signPaymentPageRequest, verifyRedirect, fetchCardToken, captureAuthorization,
  HYP_AUTHORIZED, HYP_PUBLIC_DEMO_MASOF,
} from '../src/lib/payment-hyp.js';

/** Hyp's public demo credentials, published on their developer material. Not secrets. */
const DEMO = {
  masof: HYP_PUBLIC_DEMO_MASOF,
  key: '7110eda4d09e062aa5e4a390b0a572ac0d2c0220',
  passp: 'yaad',
  baseUrl: 'https://pay.hyp.co.il/p/',
};

/** Hyp's published success card (testing-environments.md). Their failure card is 4580458045804580. */
const TEST_CARD = { number: '5253360311315452', expiry: '12/29', cvv: '493', israeliId: '890108558' };

const HELD_AGOROT = 1000;      // 10₪ authorized …
const CAPTURED_AGOROT = 700;   // … 7₪ actually taken.

describe.skipIf(!process.env.HYP_LIVE)('Hyp Pay — live two-phase commit', () => {
  it('authorizes, verifies, tokenises and captures for less than it held', { timeout: 180_000 }, async () => {
    // Unique per run: Hyp echoes it back as `Order`, and reusing one makes two runs
    // indistinguishable in their dashboard.
    const orderRef = `proof-${Date.now()}`;

    // ── 1. Authorize (J5) ──
    const { url } = await signPaymentPageRequest(
      { amountAgorot: HELD_AGOROT, orderRef, description: 'two-phase proof', buyerName: 'Test' },
      DEMO,
    );

    const browser = await chromium.launch();
    let redirectUrl: string;
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.fill('#UserName', 'Test');
      await page.fill('#LastName', 'Buyer');
      await page.fill('#UserEmail', 'test@example.com');
      await page.fill('#credit-card-input', TEST_CARD.number);
      await page.fill('#_expire', TEST_CARD.expiry);
      await page.fill('#cvv', TEST_CARD.cvv);
      await page.fill('#userId-input', TEST_CARD.israeliId);
      const terms = page.locator('#takanon_checkbox');
      if (await terms.count()) await terms.check().catch(() => {});
      // `#btnSubmit` (`input.credit_pay_btn`, reading "לתשלום 10.00 ₪") is what the page actually
      // renders. The `#credit_btn` in their page source belongs to a template branch that never
      // reaches the DOM — a reminder that this file is driving markup we do not own, and that a
      // failure here means their page changed, not that J5 stopped working.
      await page.click('#btnSubmit');
      // Hyp redirects to the terminal's configured success page, which is theirs and not ours —
      // the outcome we need is in the query string of wherever the browser lands.
      await page.waitForURL((u) => u.searchParams.has('CCode'), { timeout: 90_000 });
      redirectUrl = page.url();
    } finally {
      await browser.close();
    }

    const redirect = new URL(redirectUrl);
    const params = redirect.searchParams;
    // 700, not 0. See payment-hyp.ts's header — this is the line that would fail if J5 were
    // silently downgraded to an ordinary charge on this terminal.
    expect(params.get('CCode')).toBe(HYP_AUTHORIZED);

    const transId = params.get('Id') ?? '';
    const authCode = params.get('ACode') ?? '';
    const uid = params.get('UID') ?? '';
    expect(transId).not.toBe('');
    expect(authCode).not.toBe('');
    // MoreData=True is what puts UID on the redirect, and without it there is no capture.
    expect(uid).not.toBe('');

    // ── 2. Verify the redirect really came from Hyp ──
    expect(await verifyRedirect([...params.entries()], DEMO)).toBe(true);

    // ── 3. Tokenise ──
    const { token, expiry } = await fetchCardToken(transId, DEMO);
    expect(token).not.toBe('');
    // The card number must never appear in what we hold. A token that is the PAN would put this
    // codebase in PCI scope without anyone noticing.
    expect(token).not.toContain(TEST_CARD.number);

    // ── 4. Capture LESS than was held ──
    const captured = await captureAuthorization({
      authCode, originalUid: uid, token, tokenExpiry: expiry,
      buyerIsraeliId: params.get('UserId') ?? undefined, buyerName: 'Test',
      authorizedAgorot: HELD_AGOROT, captureAgorot: CAPTURED_AGOROT,
      description: 'partial capture proof',
    }, DEMO);
    expect(captured.CCode).toBe('0');
    // Hyp normalises the amount it echoes back — we send "7.00" and it answers "7" — so this is a
    // numeric comparison, not a string one. Asserting the string is a test that fails on a
    // successful capture, which is the worst kind on a money path.
    expect(Number(captured.Amount)).toBe(CAPTURED_AGOROT / 100);
  });
});
