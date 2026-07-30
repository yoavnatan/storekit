export const prerender = false;
import type { APIContext } from 'astro';
import { clearSellerSession } from '../../lib/seller-auth.js';
import { safeRedirectPath } from '../../lib/safe-redirect.js';

export async function POST({ cookies, request, redirect }: APIContext): Promise<Response> {
  clearSellerSession(cookies);
  const form = await request.formData();
  return redirect(safeRedirectPath(String(form.get('_next') || ''), '/'));
}
