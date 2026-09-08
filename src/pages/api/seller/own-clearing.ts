export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { saveSellerClearing, sellerClearingFor, forDisplay, canTakePayments, disconnectSellerClearing } from '../../../lib/seller-own-clearing.js';
import { clearingProvider } from '../../../lib/clearing-providers.js';

/**
 * Where a seller connects his OWN clearing account.
 *
 * ── Scope: the SESSION's seller, and nothing in the body decides whose ──
 * The same rule as `merchant-kyc.ts`. A body-supplied seller id here would let anyone overwrite
 * another shop's terminal credentials, which is the loudest possible failure in this system: every
 * one of that shop's payments would land in somebody else's account.
 *
 * ── Partial saves are normal ──
 * A seller pastes three values from another tab and will get one of them wrong or leave the browser
 * mid-way. What he did paste is kept and what is missing is reported back (`feedback_seller_form_burden`).
 *
 * ── What comes BACK never contains a secret ──
 * The response is `forDisplay`, which is per field a flag and a four-character hint. The credentials
 * themselves go to the provider adapter and nowhere else — not into this response, not into a log.
 */

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The shape both POST and GET answer with, so the screen has one thing to render. */
async function state(sellerId: string): Promise<Record<string, unknown>> {
  const clearing = await sellerClearingFor(sellerId);
  return {
    provider: clearing?.provider.id ?? null,
    fields: forDisplay(clearing),
    missing: clearing?.missing ?? [],
    verified: clearing?.verifiedAt ? clearing.verifiedAt.toISOString() : null,
    canTakePayments: canTakePayments(clearing),
  };
}

export async function GET({ cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);
  return json(await state(sellerId));
}

/**
 * Disconnect the account entirely (owner, 2026-09-08: *"אפשרות לבטל בחירה"*).
 *
 * Session-scoped like everything else here — a seller can only ever disconnect his own. It answers
 * with the same `state` shape as GET and POST, so the screen redraws from one thing whichever verb
 * it used.
 */
export async function DELETE({ cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);
  await disconnectSellerClearing(sellerId);
  return json(await state(sellerId));
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const read = await readJsonBody<Record<string, unknown>>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);

  const providerId = typeof read.value.provider === 'string' ? read.value.provider : '';
  const provider = clearingProvider(providerId);
  // A provider we cannot actually talk to is refused HERE rather than saved and discovered later:
  // the seller would otherwise fill in a form for Cardcom, be told it saved, and find his shop
  // still cannot take money with nothing on screen explaining why.
  if (!provider) return json({ error: 'ספק לא מוכר', field: 'provider' }, 400);
  if (!provider.fieldsVerified) {
    return json({ error: `החיבור ל${provider.name} עדיין לא זמין`, field: 'provider' }, 400);
  }

  await saveSellerClearing(sellerId, provider.id, read.value);
  return json(await state(sellerId));
}
