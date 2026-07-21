export const prerender = false;
import type { APIRoute } from 'astro';
import { recordAnalyticsEvent } from '../../../lib/analytics.js';

// Client-reportable funnel events. Deliberately a tiny whitelist: only
// add_to_cart is a genuinely client-side action with no reliable server tap
// (view_item is recorded server-side in middleware / the product-modal API;
// begin_checkout + purchase are recorded server-side where they actually
// happen). Anything else is ignored so a spoofed body can't invent funnel stages.
const CLIENT_EVENTS = new Set(['add_to_cart']);
const MAX_BODY_BYTES = 2_000;

// Unauthenticated by design — any shopper (guest or logged-in) fires add_to_cart.
// The session id comes from the httpOnly `sn_vid` cookie set in middleware, NOT
// from the body, so a client can't forge which session an event belongs to.
export const POST: APIRoute = async ({ request, cookies }) => {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  let body: unknown;
  try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }

  const type = (body as { type?: unknown })?.type;
  if (typeof type !== 'string' || !CLIENT_EVENTS.has(type)) return new Response(null, { status: 400 });

  const pidRaw = (body as { productId?: unknown })?.productId;
  const productId = typeof pidRaw === 'string' ? pidRaw.slice(0, 64) : '';

  recordAnalyticsEvent(type as 'add_to_cart', {
    vid: cookies.get('sn_vid')?.value,
    productIds: productId ? [productId] : undefined,
  });
  return new Response(null, { status: 204 });
};
