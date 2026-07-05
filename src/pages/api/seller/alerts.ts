export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { sellerHasAnyAlert } from '../../../lib/seller-alerts.js';

export const GET: APIRoute = async ({ cookies }) => {
  const sellerId = getSellerSession(cookies);
  const hasAlert = sellerId ? sellerHasAnyAlert(sellerId) : false;

  return new Response(JSON.stringify({ hasAlert }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
