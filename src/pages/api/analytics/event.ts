export const prerender = false;
import type { APIRoute } from 'astro';
import { recordAnalyticsEvent } from '../../../lib/analytics.js';
import { isUuid } from '../../../lib/db.js';
import { readJsonBody } from '../../../lib/request-body.js';

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
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return new Response(null, { status: read.status });
  const body = read.value;

  const type = (body as { type?: unknown })?.type;
  if (typeof type !== 'string' || !CLIENT_EVENTS.has(type)) return new Response(null, { status: 400 });

  // Only a real product id shape is recorded. In the JSON era an invented id merely added a key to
  // a day's tally; against the database it adds a ROW to `analytics_products` — a table with no
  // foreign key by design (history outlives the products in it), reachable from an unauthenticated
  // POST, and kept forever. Every product created by this application has a uuid, so the shape
  // check costs one regex and no query, and the ids that predate uuids exist only in imported
  // history, which this route never writes. An id that fails it is dropped, not rejected: the
  // add-to-cart itself already happened, and a 400 here would only make the client retry.
  const pidRaw = (body as { productId?: unknown })?.productId;
  const productId = typeof pidRaw === 'string' && isUuid(pidRaw) ? pidRaw : '';

  void recordAnalyticsEvent(type as 'add_to_cart', {
    vid: cookies.get('sn_vid')?.value,
    productIds: productId ? [productId] : undefined,
  });
  return new Response(null, { status: 204 });
};
