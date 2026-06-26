export const prerender = false;
import type { APIContext } from 'astro';
import { clearSellerSession } from '../../lib/seller-auth.js';

export async function POST({ cookies, request, redirect }: APIContext): Promise<Response> {
  clearSellerSession(cookies);
  const form = await request.formData();
  const rawNext = String(form.get('_next') || '');
  const dest = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  return redirect(dest);
}
