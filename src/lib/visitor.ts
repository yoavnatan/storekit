// The first-party visitor id, and the one place its name and shape are decided.
//
// It lived in `middleware.ts` as a private constant, which was right while the middleware was the
// only thing that ever touched it. It is not any more: a store page served on a seller's own domain
// has to hand this id across the origin boundary (`cross-origin-handoff.ts`), so a second module
// needs the cookie's name — and a cookie name copied into a second file is a cookie that gets
// renamed in one of them.

import type { AstroCookies } from 'astro';
import { randomUUID } from 'node:crypto';

/** Stable first-party visitor id — analytics only, `httpOnly` so it never reaches client JS or a
 *  third party. Lets store performance tell unique visitors apart from raw visit count (repeat
 *  loads by the same browser reuse this id). */
export const VISITOR_COOKIE = 'sn_vid';

/** ~13 months, so a returning visitor still de-dupes across a long gap. */
export const VISITOR_TTL_SEC = 60 * 60 * 24 * 400;

/** 20 lowercase hex characters. Pinned as a constant because the handoff re-validates against it on
 *  the far side of an origin boundary — a shape asserted in one file and checked in another is the
 *  kind of agreement that quietly stops holding. */
export const VISITOR_ID_RE = /^[a-f0-9]{20}$/;

export function visitorCookieOptions(): { path: string; maxAge: number; httpOnly: true; sameSite: 'lax' } {
  return { path: '/', maxAge: VISITOR_TTL_SEC, httpOnly: true, sameSite: 'lax' };
}

/** The id this browser already had, or a fresh one — set lazily on the first page GET. */
export function resolveVisitorId(cookies: AstroCookies): string {
  const existing = cookies.get(VISITOR_COOKIE)?.value;
  if (existing) return existing;
  const id = randomUUID().replace(/-/g, '').slice(0, 20);
  cookies.set(VISITOR_COOKIE, id, visitorCookieOptions());
  return id;
}
