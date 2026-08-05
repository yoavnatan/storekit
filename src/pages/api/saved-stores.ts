export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getFavoriteStoresForUser } from '../../lib/user-carts.js';
import { getStoresBySlugs, isStoreVisible } from '../../lib/stores.js';
import { storeMark, storeMarkGradient } from '../../lib/store-mark.js';

/** What the avatar menu shows before its "all saved stores" link takes over. A menu is a shortcut,
 *  not a list page — past a handful of rows it stops being one and starts being a scroll. */
const MENU_CAP = 6;

/**
 * The signed-in shopper's saved stores, name + logo included — what the header's avatar menu
 * lists so saved stores are reachable from anywhere, not only from the homepage's "liked" tab.
 *
 * **Client-side on purpose, never SSR into the header.** The header renders on every page of the
 * site, so anything it computes is the cost of the whole site (AI_INSTRUCTIONS → Scalability);
 * this list is only ever looked at after a deliberate click on the avatar, so it is fetched then
 * and cached for the page's lifetime by the caller.
 *
 * `isStoreVisible`, not `isStoreDiscoverable`: this is a personal list, not a discovery surface.
 * A store the seller has PAUSED still serves its page (with a notice), so dropping it here would
 * quietly lose a store the shopper deliberately saved; a blocked or closed one has no page left
 * to link to and is filtered out by the same predicate.
 */
export async function GET({ cookies }: APIContext): Promise<Response> {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response('Unauthorized', { status: 401 });

  // Sequential because the second read's input IS the first's output — not a missed Promise.all.
  const slugs = await getFavoriteStoresForUser(userId);
  const stores = (await getStoresBySlugs(slugs)).filter(isStoreVisible);

  // The fallback avatar is resolved HERE, not in the header's script: `total` is what tells the
  // menu whether its "all saved stores" link has anything more to show, and shipping the mark
  // rather than the seed keeps store-mark.ts out of a bundle that loads on every page of the site.
  return new Response(
    JSON.stringify({
      total: stores.length,
      stores: stores.slice(0, MENU_CAP).map((s) => {
        const mark = storeMark(s.slug, s.name);
        return {
          slug: s.slug,
          name: s.name,
          image: s.profileImage ?? '',
          initial: mark.initial,
          gradient: storeMarkGradient(mark),
        };
      }),
    }),
    // Per-user data behind a session cookie: never let a shared cache hold it.
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } },
  );
}
