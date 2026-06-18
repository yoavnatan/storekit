/**
 * POST /api/checkout — create a payment session.
 *
 * PLACEHOLDER: returns "not configured" until a real payment provider is
 * wired in. To enable Stripe:
 *   1. npm i stripe
 *   2. Set STRIPE_SECRET_KEY in .env
 *   3. Replace the body below with a Stripe Checkout Session built from
 *      `payload.items`, returning { url: session.url }.
 *
 * See AI_INSTRUCTIONS.md → "Payments" for the full snippet.
 */
export const prerender = false;

export async function POST({ request }) {
  const payload = await request.json().catch(() => null);
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    return json({ message: 'Cart is empty' }, 400);
  }

  const secret = import.meta.env.STRIPE_SECRET_KEY;
  if (!secret || secret.startsWith('sk_test_xxx')) {
    return json({
      message: 'Payment not configured. Add STRIPE_SECRET_KEY to .env and complete src/pages/api/checkout.js',
    }, 200);
  }

  // TODO: create real Stripe Checkout Session here and return { url }.
  return json({ message: 'Complete the payment integration in src/pages/api/checkout.js' }, 501);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
