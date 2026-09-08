export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, updateSeller } from '../../../lib/seller-auth.js';
import { isValidEmail } from '../../../lib/email-address.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { saveMerchantKyc } from '../../../lib/seller-merchant.js';

export const POST: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const read = await readJsonBody<{ name?: string; email?: string; phone?: string; currentPassword?: string; newPassword?: string }>(request, BODY_LIMIT.form);
  if (!read.ok) return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: read.status });
  const body = read.value;

  const name  = body.name?.trim();
  const email = body.email?.trim().toLowerCase();

  if (!name || !email) {
    return new Response(JSON.stringify({ error: 'שם ואימייל הם שדות חובה' }), { status: 400 });
  }

  if (!isValidEmail(email)) {
    return new Response(JSON.stringify({ error: 'כתובת מייל לא תקינה' }), { status: 400 });
  }

  if (body.newPassword && body.newPassword.length < 6) {
    return new Response(JSON.stringify({ error: 'סיסמה חייבת להכיל לפחות 6 תווים' }), { status: 400 });
  }

  const result = await updateSeller(userId, {
    name,
    email,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });

  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), { status: 400 });
  }

  /* ── The phone belongs to the PERSON, not to a card (owner, 2026-09-08) ──
   * It was asked for inside the subscription's card form, because the tokenizer refuses a charge
   * without one — *"מוזר לי שבפרטי כרטיס יש טלפון… זה אמור להיות בתוך פרטים אישיים"*, and he is
   * right: a phone is a fact about him that a payment terminal happens to need, not a property of
   * the card. It is asked once, on his own account, and every later charge reads it.
   *
   * Stored on `merchant_kyc.ownerPhone`, which is where the subscription already looks. That column
   * is named for a KYC record the SaaS shape no longer collects, and moving it is a migration for
   * the day the subscription's own terminal is chosen — writing it anywhere else today would mean
   * two homes for one number, which is the shape this project keeps getting bitten by.
   *
   * Only when a phone is actually sent: this route is also the buyer dashboard's profile save,
   * which has no phone field, and an absent key must not blank a stored value. */
  const phone = body.phone?.trim();
  if (phone) await saveMerchantKyc(userId, { ownerPhone: phone });

  return new Response(JSON.stringify({ ok: true, name: result.seller.name, email: result.seller.email }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
