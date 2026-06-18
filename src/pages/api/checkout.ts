export const prerender = false;
import type { APIContext } from 'astro';

export async function POST({ request }: APIContext): Promise<Response> {
  const payload = await request.json().catch(() => null) as { items?: unknown[] } | null;
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    return json({ message: 'Cart is empty' }, 400);
  }

  const secret = import.meta.env.STRIPE_SECRET_KEY;
  if (!secret || secret.startsWith('sk_test_xxx')) {
    return json({
      message: 'Payment not configured. Add STRIPE_SECRET_KEY to .env and complete src/pages/api/checkout.ts',
    }, 200);
  }

  return json({ message: 'Complete the payment integration in src/pages/api/checkout.ts' }, 501);
}

function json(data: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
