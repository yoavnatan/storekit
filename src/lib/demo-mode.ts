/**
 * Is this process a PORTFOLIO DEMONSTRATION rather than a shop?
 *
 * One flag, read in one place, and it is deliberately a flag and not something derived — unlike
 * `site-mode.ts`, which argues at length that "can this deployment take money" must be derived from
 * what the payment provider actually IS. The two are opposite questions and want opposite shapes.
 *
 * `sellingClosed` protects a real business from an accident: nobody may forget to close the shop,
 * so it closes itself. `DEMO_MODE` is a statement about the deployment's PURPOSE, and there is no
 * fact about a running server that says "this one exists to be looked at". Somebody decides, once,
 * on the host. And it fails in the safe direction: forgetting it on the real site leaves the real
 * site behaving normally, whereas a derived answer that guessed wrong would turn a shop into a toy.
 *
 * ── What it changes, and the rule for adding to that list ────────────────────
 *
 *   `payme-demo.ts`     — every PayMe call is answered locally instead of over the network.
 *   quick-login buttons — one click into the seller, admin and buyer views, no credentials.
 *   credential locks    — a demo account may not change its own email or password (below).
 *   the reset job       — restores the showcase stores hourly.
 *
 * **The rule: demo mode may only ADD an answer where production has a gateway, or REFUSE a write
 * that would break the demonstration for the next visitor. It may never weaken a check that
 * protects money, stock or somebody's data.** A demo that authorised what production refuses is
 * not a demonstration of this application — it is a different one, and the screenshots would be
 * lies. Every branch guarded by this flag should be readable as "there is no PayMe here" or
 * "this visitor is a guest in a shared exhibit", never as "skip the guard".
 *
 * `isDemoMode()` is safe to call anywhere: `serverEnv` reads the live process environment, so a
 * host that sets the variable needs a restart and not a rebuild.
 */
import { serverEnv } from './runtime-env.js';

/** True when this deployment exists to be looked at rather than to sell. */
export function isDemoMode(): boolean {
  return serverEnv('DEMO_MODE') === '1';
}

/**
 * How long the demo's stand-in clearing company "examines" a new business before approving it.
 *
 * Twenty seconds, and the number is a piece of stagecraft rather than an implementation detail.
 * The real wait is up to seven business days and the screens that cover it — the pending card, the
 * two publication holds, the shop that is built but dark — are some of the most interesting in the
 * application. Approving instantly would hide all of them; approving realistically would mean no
 * visitor ever sees the other side. Twenty seconds is long enough that the waiting state is
 * genuinely on screen and read, and short enough that nobody leaves before it resolves.
 *
 * The publication sweep is re-timed to match (`lib/jobs/registry.ts`), because an approval nothing
 * acts on for half an hour is the same as no approval.
 */
export const DEMO_APPROVAL_SECONDS = 20;

/** The publication sweep's interval in demo mode. Just under the approval delay, so the first
 *  sweep after a business is approved is never more than a moment behind it. */
export const DEMO_PUBLICATION_INTERVAL_SEC = 15;

/**
 * How long a store a visitor created lives before the reset job removes it.
 *
 * A day, so somebody who builds a shop in the evening can show it to a colleague in the morning —
 * and so that the demonstration does not slowly fill with hundreds of abandoned one-product stores
 * that make the mall look like a dumping ground. The four showcase stores are never touched by
 * this; they are the exhibit.
 */
export const DEMO_VISITOR_STORE_HOURS = 24;
