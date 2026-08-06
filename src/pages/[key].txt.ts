export const prerender = false;
import type { APIContext } from 'astro';
import { store as platform } from '../config/store.config.js';

// IndexNow ownership-verification file. The protocol requires the key be
// retrievable at https://<host>/<key>.txt returning the key as plaintext, so
// the endpoint can trust a submission came from the site owner. Served
// dynamically from config so it exists the moment a key is set — no repo file
// to add, and the filename tracks the key automatically.
//
// This is a broad dynamic route (`/<anything>.txt`), but a static route always takes precedence
// over a dynamic one in Astro — /llms.txt and /robots.txt are both real routes (robots.txt stopped
// being a `public/` file when it had to vary by Host) — so this only ever catches an actual key
// request; anything else 404s.
export async function GET({ params }: APIContext): Promise<Response> {
  const key = platform.seo?.indexNowKey?.trim();
  if (!key || params.key !== key) return new Response('Not found', { status: 404 });
  return new Response(key, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
  });
}
