export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession, getSellerById, updateSellerPayoutDetails } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { parsePayoutDetails, hasPayableBank, maskedBankLine, type PayoutDetailsInput } from '../../../lib/payout-details.js';
import { createNotification } from '../../../lib/notifications.js';

/**
 * Where this seller's money is sent — the one field on the platform whose value is a destination
 * for a bank transfer.
 *
 * ── Scope ──
 * The session proves an ACCOUNT, and these fields belong to that account, so the id being written
 * is `getSellerSession`'s and never anything from the body. There is no store in this route at all
 * and there must not be: payouts are per registered business, not per store (`pricing.ts`,
 * `seller-account.ts`), and taking a `storeId` here would invite exactly the "an id is not a
 * permission" mistake that `lib/store-ownership.ts` exists for.
 *
 * ── Why a change is announced ──
 * Changing the payout account is the highest-value write a seller can make, and the state it
 * creates is silent by nature: nothing looks different until a transfer lands somewhere else, a
 * month later. It is not GATED behind a password — the account's own email address is changed
 * through `/api/user/update-profile` with no more than this session either, and a gate here that
 * a Google-only account (no password at all) could not pass would lock those sellers out of ever
 * being paid. So it is ANNOUNCED instead, which is what actually surfaces a change the seller did
 * not make. ⚠️ When mail is really wired (GO_LIVE §4) this notification wants an email beside it —
 * an in-app badge is only seen by someone who signs in.
 *
 * ── The announcement carries NO account details (owner, סשן א׳ §2, 2026-08-11) ──
 * *"ההתראה לא צריכה לכלול את הפרטים, רק ״עודכן חשבון בנק, אם לא ביצעתם את השינוי — נא לפנות
 * אלינו״"*. It used to interpolate the masked account line, which was wrong in two ways at once and
 * only one of them is about privacy. A notification is the surface most likely to be read somewhere
 * the seller's own dashboard is not — a phone on a desk, a shared screen, and an email once §4
 * lands — so it is the LAST place bank digits belong, masked or otherwise. And the digits answered
 * a question nobody asked: someone who made the change knows what they typed, and someone who did
 * not needs one instruction, not a number to squint at. The masked line stays on the dashboard,
 * where the seller went looking for it.
 */

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const read = await readJsonBody<PayoutDetailsInput>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);

  const parsed = parsePayoutDetails(read.value);
  if (!parsed.ok) return json({ error: parsed.error, field: parsed.field }, 400);

  const before = await getSellerById(sellerId);
  if (!before) return json({ error: 'Unauthorized' }, 401);

  const seller = await updateSellerPayoutDetails(sellerId, parsed.details);
  if (!seller) return json({ error: 'Seller not found' }, 404);

  // Compared on the stored, normalised values rather than on what was typed: a seller re-saving the
  // same account with different punctuation has changed nothing and must not be told they have.
  const bankMoved = maskedBankLine(before) !== maskedBankLine(seller)
    || before.bankAccount !== seller.bankAccount
    || before.bankAccountHolder !== seller.bankAccountHolder;
  if (bankMoved) {
    await createNotification({
      userId: sellerId,
      role: 'seller',
      // Not 'order_update' (what it used to be): this is about the payout account, and the type is
      // what decides where clicking it lands — the payouts tab, not the orders one.
      type: 'payout_status',
      title: 'עודכן חשבון בנק',
      // One instruction, and the same one either way. The deletion case used to add "עד שיוזנו
      // מחדש היתרה ממשיכה להיצבר" — true, reassuring, and not what this message is for: it is the
      // alarm for a change the seller did not make, and a second sentence about accrual is the one
      // they read instead of the first.
      body: 'אם לא ביצעתם את השינוי — פנו אלינו מיד.',
      // Swallowed: the details are already saved, and a badge that failed to write must not report
      // to the seller that their save did not happen.
    }).catch(() => null);
  }

  return json({
    ok: true,
    hasBank: hasPayableBank(seller),
    bankLine: maskedBankLine(seller),
    businessId: seller.businessId ?? '',
    businessType: seller.businessType ?? '',
  });
}
