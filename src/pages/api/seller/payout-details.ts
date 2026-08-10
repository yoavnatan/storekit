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
      type: 'order_update',
      title: 'פרטי חשבון הבנק עודכנו',
      body: hasPayableBank(seller)
        ? `התשלומים הבאים יועברו לחשבון ${maskedBankLine(seller)}. אם לא אתם עשיתם את זה — פנו אלינו מיד.`
        : 'פרטי חשבון הבנק נמחקו. עד שיוזנו מחדש היתרה ממשיכה להיצבר ולא מועברת.',
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
