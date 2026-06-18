export const prerender = false;
import type { APIContext } from 'astro';
import { logout } from '../../lib/auth.js';

export async function POST({ cookies, redirect }: APIContext): Promise<Response> {
  logout(cookies);
  return redirect('/admin/login');
}
