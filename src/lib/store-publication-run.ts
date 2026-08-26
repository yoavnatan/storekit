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
import { activePaymeCredentials, getSellerStatus } from './payment-payme.js';
import { refreshSubscription } from './seller-subscription.js';
import { startArmedSubscription } from './subscription-arm.js';
import { sellersAwaitingPublication, syncStorePublication } from './store-publication.js';
import { merchantAccountFor, setMerchantApproval } from './seller-merchant.js';

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
       * ── And ASK them whether the business was approved (2026-08-26) ──
       *
       * This sweep's own header says it reads "the approval flag the callback maintains" — and the
       * callback has never once been received, because it needs a public URL this platform does not
       * have yet (`docs/payme-sandbox-notes.md`). So nothing in the running system ever moved that
       * flag: a seller who had done everything sat in `awaiting-approval` for ever, and the sweep
       * looked at him every half hour without asking the one question that would have ended it.
       *
       * Asking is cheap and it is the same call the callback makes — `getSellerStatus`, over a
       * request WE authenticate, which is why the callback is only ever treated as a hint. It also
       * gives a REFUSAL somewhere to land (owner, §20): `setMerchantApproval` writes `active`, tells
       * the seller, and logs it for us. Once a public callback URL exists this stays as the
       * backstop for a notification they drop.
       *
       * Only for an account that is not settled yet: an approved, active merchant has nothing to
       * ask about, and a seller here may be waiting on the subscription rather than on them.
       */
      const account = await merchantAccountFor(sellerId);
      if (account?.providerRef && (!account.approved || !account.active)) {
        const status = await getSellerStatus(account.providerRef, creds);
        // Null is "they do not know him", which is not a verdict — writing `false` for it would
        // close a working seller's shop on a failed lookup.
        if (status && (status.approved !== account.approved || status.active !== account.active)) {
          await setMerchantApproval(account.providerRef, status.approved, status.active);
        }
      }
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
