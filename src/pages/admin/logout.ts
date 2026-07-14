export const prerender = false;
import type { APIContext } from 'astro';
import { clearAdminCookie } from '../../lib/admin-auth.js';

export async function GET({ cookies, redirect }: APIContext): Promise<Response> {
  clearAdminCookie(cookies);
  return redirect('/admin');
}
