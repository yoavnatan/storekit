/**
 * Who a request is, and which store it is about — resolved from the session and the path, and from
 * nothing the caller sent.
 *
 * **This is one rule with two readers, and it is extracted because two answers to "who was this"
 * would land on two admin screens that sit on the same tab.** The Alerts tab shows the automatic
 * error log above the visitor reports; the error log resolved its own
 * actor and `platform-inquiries.ts` resolved another, and the day one of them learned something — a
 * buyer-only session cookie, say, or a store found through a PREVIOUS slug — the two lists would
 * quietly start describing the same person differently. `tests/request-actor.test.ts` greps `src/`
 * so the next surface that needs this cannot hand-roll a third copy.
 *
 * **Two facts decide everything below.**
 *
 * 1. **Stores live at the ROOT** — `/<slug>`, `/<slug>/<product>` — so the first path segment is a
 *    candidate store slug and `getStoreBySlug` is the filter. A non-store route (`/checkout`,
 *    `/search`) simply resolves to nothing; there is no list of "store routes" to keep in step.
 * 2. **Buyer and seller share ONE session cookie.** An account is a seller when it owns a store and
 *    a buyer when it does not — the distinction is ownership, never a separate login. Anything that
 *    needs a third value for "not signed in at all" adds it on top (`platform-inquiries.ts` calls that
 *    `guest`); this module leaves the field unset, because "we could not tell" and "nobody was
 *    signed in" are the same observation from here.
 *
 * **Best-effort, and it never throws.** It is three queries, and both callers run it somewhere a
 * rejection would be expensive: inside an error handler, and on the write path of a report a person
 * took the trouble to file. Missing attribution costs a column; a throw costs the record.
 */

import type { AstroCookies } from 'astro';
import { getSellerSession, getSellerById } from './seller-auth.js';
import { getStoreBySlug, getStoreBySellerId } from './stores.js';

export interface RequestActor {
  storeSlug?: string;
  storeName?: string;
  /** Unset when nobody is signed in, or when the account no longer exists. */
  actorRole?: 'buyer' | 'seller';
  actorId?: string;
  /** The email — what an admin screen shows, since an id names nobody. */
  actorLabel?: string;
}

export async function resolveRequestActor(pathname: string, cookies: AstroCookies): Promise<RequestActor> {
  const actor: RequestActor = {};
  try {
    const segment = pathname.match(/^\/([^/?#]+)/)?.[1];
    if (segment) {
      // Slugs on this platform carry Hebrew (`url-base.ts`), and a path that has been through
      // `safeRedirectPath` arrives percent-encoded — so the segment has to be decoded before it can
      // be compared with a stored slug. A path that was never encoded decodes to itself.
      let slug = segment;
      try { slug = decodeURIComponent(segment); } catch { /* not encoded — use it as it came */ }
      const store = await getStoreBySlug(slug);
      if (store) { actor.storeSlug = store.slug; actor.storeName = store.name; }
    }

    const accountId = getSellerSession(cookies);
    if (accountId) {
      const account = await getSellerById(accountId);
      if (account) {
        const ownStore = await getStoreBySellerId(accountId);
        actor.actorId = accountId;
        actor.actorLabel = account.email;
        actor.actorRole = ownStore ? 'seller' : 'buyer';
        // A seller reporting from a page that is not a store page is still reporting about their
        // own shop more often than not — so their store fills the gap, but never overrides a store
        // the path actually named.
        if (ownStore && !actor.storeSlug) { actor.storeSlug = ownStore.slug; actor.storeName = ownStore.name; }
      }
    }
  } catch { /* best-effort — see the module note */ }

  return actor;
}
