export const prerender = false;
import type { APIContext } from 'astro';
import { clearSellerSession } from '../../lib/seller-auth.js';

export async function POST({ cookies, redirect }: APIContext): Promise<Response> {
  clearSellerSession(cookies);
  return redirect('/seller/login');
}
