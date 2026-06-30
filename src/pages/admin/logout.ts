export const prerender = false;
import type { APIContext } from 'astro';

export async function GET({ cookies, redirect }: APIContext): Promise<Response> {
  cookies.delete('admin_token', { path: '/admin' });
  return redirect('/admin');
}
