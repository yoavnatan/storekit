/**
 * Where a request on an external hostname that NO store claims today should be sent — or null,
 * meaning nobody here has ever answered to this name and it gets a 404.
 *
 * Lives beside the middleware rather than inside it so it can be exercised against a real database
 * (`tests/unclaimed-host-db.test.ts`): the middleware is meant to stay a thin wrapper, and every
 * rule below is a claim about *rows*, not about request plumbing.
 *
 * Three ways a live hostname stops matching a store, and all of them used to end in a 404:
 *  1. **It moved.** The seller removed their domain or swapped it for another. Every link, bookmark
 *     and indexed page earned on it dies — the worst outcome for the store that built the most
 *     audience, since the 301 onto that domain had deliberately consolidated its whole ranking
 *     there. Migration 0015 remembers the old hostname; this is what reads it.
 *  2. **It is the other spelling.** `www.` present when the store registered it absent, or the
 *     reverse — see `custom-domain.ts#hostnameAlias`. The seller pointed both at us because that is
 *     how domains are owned; only one is in our record.
 *  3. **BOTH AT ONCE**, which is the case the first version missed (area audit row 5, 2026-08-16).
 *     A seller who owns `mybrand.co.il` has `www.mybrand.co.il` pointed at us too — that is the
 *     premise of (2) — but only one spelling is ever stored. So when they move away, the stored
 *     spelling 301s correctly and its twin 404s: exactly the dead half of a brand that (1) exists to
 *     prevent, on the half that older links, printed material and word of mouth are most likely to
 *     use. The alias is therefore asked about previous owners too.
 *
 * Ordered claimed-first: an active domain must never be shadowed by a stale row, and a store that
 * moved away answers about ITS OWN old host before we start guessing at spellings. Case 3 answers
 * with the store's canonical DIRECTLY rather than bouncing through the other spelling — a redirect
 * chain is a thing engines drop, and there is nothing at the intermediate hop worth visiting.
 *
 * The lookups are sequential rather than one `Promise.all`, deliberately: this runs only for a host
 * no store claims, which is a 404 or a bot and never a click path — and the ordering IS the
 * precedence, so a live twin must be answered without the later queries having been spent.
 */
import { getStoreByCustomDomain, getStoreByPreviousCustomDomain } from './stores.js';
import { hostnameAlias, previousDomainRedirectUrl } from './custom-domain.js';
import { machineUrl } from './url-base.js';

export async function unclaimedHostRedirect(
  host: string,
  pathname: string,
  search: string,
): Promise<string | null> {
  const previousOwner = await getStoreByPreviousCustomDomain(host);
  if (previousOwner) return previousDomainRedirectUrl(previousOwner, pathname, search);

  const alias = hostnameAlias(host);
  if (!alias) return null;

  const twin = await getStoreByCustomDomain(alias);
  // The store sits at the ROOT of both spellings, so the path carries over untouched. `machineUrl`
  // for the reason every redirect in this application uses it: a product slug is Hebrew here, and a
  // raw one in a Location header throws a 500 instead of redirecting (url-base.ts).
  if (twin) return machineUrl(`https://${alias}${pathname === '/' ? '' : pathname}${search}`);

  const twinPreviousOwner = await getStoreByPreviousCustomDomain(alias);
  if (twinPreviousOwner) return previousDomainRedirectUrl(twinPreviousOwner, pathname, search);

  return null;
}
