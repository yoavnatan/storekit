export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { getAllOrders } from '../../../lib/orders.js';

export const GET: APIRoute = async ({ cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const seller = getSellerById(userId);
  if (!seller) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  const orders = getAllOrders()
    .filter((o) => o.buyerEmail === seller.email)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return new Response(JSON.stringify({ orders }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
