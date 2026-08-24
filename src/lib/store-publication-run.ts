/**
 * The sweep that ends a seller's wait — one pass over every shop that has not gone live yet.
 *
 * ── Why a timer and not only the callback ──
 * PayMe notify us when they finish examining a business, and `/api/payme/callback` publishes on it.
 * But **that callback has never been received end to end** (`docs/payme-sandbox-notes.md`): it needs
 * a public URL, and this platform has no host yet. So on the day the first real seller signs up, the
 * timer is the only thing that will ever end his wait. After a host exists this is still the cover
 * for a notification PayMe dropped — a seller whose shop stayed dark because one HTTP request was
 * lost is the worst failure in this whole flow, and it is silent.
 *
 * ── What it does per seller ──
 * Re-reads the two holds from their sources rather than from anything stored: `refreshSubscription`
 * asks PayMe what the subscription is really doing, and `merchantBlockFor` (inside
 * `syncStorePublication`) reads the approval flag the callback maintains. Then it publishes what is
 * free to go.
 *
 * ── Idempotent, and cheap when nothing changed ──
 * Publication is derived from current state and `published_at` is written once, so a second pass
 * finds the same shops already live and does nothing. Sellers with no shop waiting are not in the
 * query at all, which is what keeps the steady state at one statement.
 *
 * Never throws: one seller whose PayMe lookup fails must not stop the rest of the platform going
 * live. The count of failures is on the row, so a systematic outage is visible as a number rather
 * than as silence.
 */
import { activePaymeCredentials } from './payment-payme.js';
import { refreshSubscription } from './seller-subscription.js';
import { startArmedSubscription } from './subscription-arm.js';
import { sellersAwaitingPublication, syncStorePublication } from './store-publication.js';

export async function runStorePublicationSweep(): Promise<string> {
  const creds = activePaymeCredentials();
  // Not an error, and named rather than swallowed: with no gateway there are no holds to lift and
  // `publishHoldsFor` already answers "nothing is blocked", so the sweep would publish everything
  // it looked at. Development and CI live here.
  if (!creds) return 'PayMe not configured — nothing to sweep';

  const sellers = await sellersAwaitingPublication();
  if (!sellers.length) return 'no store waiting to be published';

  let published = 0;
  let failed = 0;
  for (const sellerId of sellers) {
    try {
      // The subscription first: it is the hold PayMe change without telling us — a card that expired
      // between iterations moves the status, and the approval flag would not have moved with it.
      await refreshSubscription(sellerId, creds);
      /**
       * **And this is where a waiting seller's week actually ends** (2026-08-24). He put a card on
       * file when he chose his plan and has been in PayMe's review since; the moment they approve,
       * the card is charged and the shop goes up — without him coming back to press anything.
       * `subscription-arm.ts` re-asks the clearing gate itself before spending his money, and
       * answers with nothing at all when there is no armed card, which is every other seller here.
       */
      const armed = await startArmedSubscription(sellerId, creds);
      published += armed.length;
      if (!armed.length) published += (await syncStorePublication(sellerId, creds)).length;
    } catch {
      failed += 1;
    }
  }
  return `${sellers.length} seller(s) waiting · ${published} store(s) published${failed ? ` · ${failed} failed` : ''}`;
}
