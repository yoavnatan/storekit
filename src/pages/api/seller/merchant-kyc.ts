export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { saveMerchantKyc, clearingStatusFor } from '../../../lib/seller-merchant.js';
import { missingMerchantKyc } from '../../../lib/merchant-kyc.js';
import { syncStorePublication, publishHoldsFor } from '../../../lib/store-publication.js';

/**
 * What PayMe require about the business, and the only place a seller types it.
 *
 * ── Why this route exists at all ──
 * `merchant_kyc` had a reader and no writer: `ensureMerchantAccount` needed ten fields and there was
 * no screen that collected any of them, so on a real deployment **no seller could ever have opened a
 * clearing account**. The store-opening path called `ensureMerchantAccount` and got `needs-details`
 * every time, and there was nowhere to go and fix it.
 *
 * ── Scope: the SESSION's account, and nothing from the body decides whose ──
 * These fields belong to a registered business, not to a store — the same rule `payout-details.ts`
 * states at length — so there is no store id in this route and there must not be.
 *
 * ── Saving is what STARTS the week ──
 * PayMe examine every business before it may take a card (up to seven business days, agreement §11)
 * and **the clock does not start until this is submitted**. So a save does not just store fields: it
 * opens the merchant account in the same request, and asks the publication gate to re-run
 * (`store-publication.ts`) in case that was the last thing holding the shop back. A seller who
 * filled this in and then had to wait for a nightly job would be waiting for no reason on the one
 * screen where waiting costs him a week.
 *
 * ── Partial saves are normal, not an error ──
 * A seller may fill in half of it and come back. `saveMerchantKyc` merges over what is already
 * there, `missingMerchantKyc` reports the rest, and `ensureMerchantAccount` simply answers
 * `needs-details` until the record is whole. Refusing an incomplete submission would lose the six
 * fields he did get right — and the rule here is that a form never blocks a seller
 * (`feedback_seller_form_burden`).
 */

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const read = await readJsonBody<Record<string, unknown>>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);

  // `normalizeMerchantKyc` inside this drops any field that fails validation rather than refusing
  // the submission, which is what makes a partial save partial instead of lost.
  const stored = await saveMerchantKyc(sellerId, read.value);

  /**
   * ── The account is NOT opened here any more (owner, 2026-08-25) ──
   *
   * *"הרי יש עלות הקמה של 99 ש״ח! ו-65 ש״ח החזקת מסוף. אני לא מעוניין להפסיד את הכסף הזה על מוכרים
   * שמתחרטים לי באמצע."*
   *
   * The ₪65-a-month terminal is charged to the PARTNER wallet — ours — for every merchant account
   * that exists, and it cannot be passed to the seller (GO_LIVE §3.1.1). **And it cannot be
   * stopped:** `update-seller` has no deactivation (`is_active` is about the public key), there is
   * no delete-seller endpoint, and `docs/payme-sandbox-notes.md` records that accounts cannot be
   * removed at all. So an account opened for somebody who then walks away is ₪65 every month, for
   * ever, against a seller who never paid us a shekel.
   *
   * Opening it on THIS request meant the meter started the moment a form was submitted — the
   * cheapest possible action, taken before the seller had committed to anything. It now starts when
   * he puts a card on file (`lib/subscription-arm.ts`), which is the first moment he has.
   *
   * **His wait does not get longer for it.** Saving the card is a minute in the same sitting, and
   * PayMe's seven-day review begins at that point rather than at this one.
   */

  // The gate is still asked, because saving these details can be the last thing a seller needed to
  // do — for a second shop on an account PayMe already approved, nothing here opens anything and the
  // shop may be free to go.
  const published = await syncStorePublication(sellerId);

  return json({
    ok: true,
    // What is still missing, from the SAME function the account path asks — so the form can never
    // disagree with the thing that decides whether an account may be opened.
    missing: missingMerchantKyc(stored),
    clearing: await clearingStatusFor(sellerId),
    holds: await publishHoldsFor(sellerId),
    published,
  });
}
