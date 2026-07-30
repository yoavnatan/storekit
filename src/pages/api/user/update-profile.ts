export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, updateSeller } from '../../../lib/seller-auth.js';
import { isValidEmail } from '../../../lib/email-address.js';

export const POST: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  let body: { name?: string; email?: string; currentPassword?: string; newPassword?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

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

  const result = updateSeller(userId, {
    name,
    email,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });

  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), { status: 400 });
  }

  return new Response(JSON.stringify({ ok: true, name: result.seller.name, email: result.seller.email }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
