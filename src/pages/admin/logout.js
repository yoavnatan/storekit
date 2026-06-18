/** POST /admin/logout — clear the session cookie and return to login. */
export const prerender = false;
import { logout } from '../../lib/auth.js';

export async function POST({ cookies, redirect }) {
  logout(cookies);
  return redirect('/admin/login');
}
