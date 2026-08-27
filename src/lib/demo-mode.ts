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

/* How long a visitor's shop lives is deliberately NOT here. It is `VISITOR_CONTENT_HOURS` in
   `scripts/lib/seed-db.mjs`, the one file allowed to delete anything, and the job that sweeps shells
   out to a script — so no TypeScript module needs the number and there is no second copy to drift.
   The constant sat here unused from the day it was written until the sweep was actually built. */

/**
 * The accounts the demonstration's shortcuts sign a visitor into.
 *
 * The SELLER is reached from two places: the tour control on the home page, and the login page
 * itself — both post to `/seller/login`, which owns the handler. There was a `/demo` page once and
 * it is gone; a screen you pass through, made of its own buttons, read as detached from the
 * application (owner, 2026-08-27).
 *
 * The BUYER has no door any more, by the same decision — the owner asked for two, and a shopper is
 * what a signed-out visitor already is. The account still exists because a third of the seeded
 * orders hang off it, which is what makes the buyer side of those orders real; it simply is not
 * somewhere you can log in to.
 *
 * The seller is the platform account that owns the four showcase stores, so "log in as a seller"
 * lands on a dashboard with months of trading behind it rather than on an empty one. The buyer is
 * created by the portfolio seeder and given the orders, the returns and the reviews.
 *
 * **These strings also exist in `scripts/lib/seed-db.mjs`**, which cannot import a `.ts` module and
 * is run by plain Node. Rather than let two spellings drift apart silently — the failure being a
 * quick-login button that lands on a login form — `tests/demo-identities.test.ts` reads both files
 * and asserts they still agree. That is the guard; this comment is only the reason for it.
 */
export const DEMO_SELLER_EMAIL = 'showcase@dezabin.co.il';
export const DEMO_BUYER_EMAIL = 'buyer@demo.local';

/**
 * The second seller door: a shop on its FIRST DAY.
 *
 * The showcase seller's four stores are finished, and "שלבים ראשונים" — the checklist that tells a
 * new seller what to do — renders only while something is still undone (`OnboardingChecklist`
 * hides itself at 100%). So the one screen built to explain the product to a beginner was the one
 * screen no visitor to the demonstration could reach: pressing "פתח חנות" leads to a registration
 * form, and the tour's seller door lands on a shop with months of trading behind it (owner,
 * 2026-08-27: *"מה שהוא לא רואה זה את שלבים ראשונים שמסבירים מה הוא צריך לעשות"*).
 *
 * This account owns one nearly-empty store, so the door lands exactly where a real seller lands on
 * the day they sign up — an open checklist, a partial progress bar, and every "לביצוע" pointing at
 * the tab that does it. It is a shared demo account like the other two: read-only
 * (`lib/demo-viewer.ts`) and locked out of changing its own credentials (`lib/seller-auth.ts`).
 */
export const DEMO_NEW_SELLER_EMAIL = 'newseller@demo.local';

/**
 * The accounts the tour hands out, as one list.
 *
 * Every rule about them — read-only, credentials locked, kept by the visitor sweep — has to name
 * all of them, and each of those rules lived in a different module with its own `a === x || a === y`.
 * Adding this third account meant editing three of those, which is the definition of a rule that
 * will be missed the fourth time. One predicate, three readers.
 */
export const DEMO_SHARED_EMAILS: readonly string[] = [
  DEMO_SELLER_EMAIL,
  DEMO_NEW_SELLER_EMAIL,
  DEMO_BUYER_EMAIL,
];

/** Is this one of the accounts anybody can walk into? Compared by ACCOUNT, never by "is demo mode
 *  on": a visitor who registered has an account of their own and is an ordinary seller in it. */
export function isSharedDemoAccount(email: string | null | undefined): boolean {
  return !!email && DEMO_SHARED_EMAILS.includes(email);
}
