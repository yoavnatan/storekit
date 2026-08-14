/**
 * Is the platform open for business, and may search engines have it?
 *
 * Two questions, one file, because they are asked at the same moment and for the same reason: the
 * site goes onto its real domain WEEKS before it can take money (GO_LIVE §7 plans that window
 * deliberately — Merchant Center review runs 3-5 business days and cannot start without a live
 * host). During that window the site must look and behave like itself, so the review and the
 * approvals are of the real thing, while two specific consequences must not happen.
 *
 * ── 1. SELLING, and why it is DERIVED rather than switched ───────────────────
 *
 * `lib/payment.ts` ships `MockPaymentProvider`, whose `authorize()` returns ok unconditionally and
 * contacts no gateway — and `checkout.astro` collects no card details at all. So on the day the
 * domain points at a real host, a stranger fills in a name and an address, gets a real order, real
 * stock comes off the shelf, a real confirmation email goes out, and nothing is paid. That is not
 * an unfinished feature; it is a shop giving goods away, and it is reachable by anyone who finds
 * the URL.
 *
 * A `CHECKOUT_OPEN=0` flag would fix it, and would be the wrong shape: the danger is not that the
 * flag is set wrongly, it is that on the one day it matters nobody remembers it exists. So the
 * default is not a flag at all — **a production server whose payment provider cannot take money
 * refuses to sell**, and that answer is derived from what the provider actually IS. Wiring the real
 * gateway opens the shop by itself, with nothing to remember and nothing to switch.
 *
 * The escape hatch is `ALLOW_MOCK_CHECKOUT=1`, for walking the purchase flow on the live site
 * before a gateway exists. It is named for what it does rather than for what it is for, because
 * what it does is let anybody order for free.
 *
 * Development is unaffected: the mock provider is the point there, and no stranger can reach it.
 *
 * ── 2. INDEXING, and why THAT one is an explicit switch ──────────────────────
 *
 * The opposite shape, on purpose. There is no fact about the running server that says "this
 * catalogue is ready to be the platform's first impression in Google" — the stores may be demos,
 * the copy may be half-written, the policies may be placeholders, and none of that is visible to
 * code. It is a judgement, so it is a decision someone makes: `SITE_NOINDEX=1`.
 *
 * And it must be reversible in one line without a deploy, because SEO is this project's first
 * priority and the day the site is ready is the day it should start being crawled.
 *
 * **What this switch is not:** it is not access control and does not hide anything. It asks
 * politely, and well-behaved crawlers comply. Anyone with the URL still sees everything. It is also
 * slow in one direction — removing a page Google has already taken can take days, which is the
 * whole argument for having it on from the FIRST minute the domain resolves rather than adding it
 * after something appears in a search result.
 */

import { serverEnv } from './runtime-env.js';
import { paymentProvider, MockPaymentProvider } from './payment.js';

/** True when the configured provider cannot actually take money. Asked of the object rather than
 *  of a name or a flag, so it stays true the moment the provider is swapped and never drifts. */
export function paymentsAreMock(): boolean {
  return paymentProvider instanceof MockPaymentProvider;
}

export type ClosedReason = 'mock-payments';

/**
 * Why the shop cannot take an order right now, or `null` when it can.
 *
 * A reason rather than a boolean: the checkout route, the checkout page and the buy buttons all
 * need to say something true to a person, and three surfaces inventing their own sentence from a
 * `false` is exactly the drift the copy modules in this repo exist to prevent.
 */
export function checkoutClosedReason(): ClosedReason | null {
  if (!import.meta.env.PROD) return null;
  if (!paymentsAreMock()) return null;
  // Deliberately last: the override only has meaning once everything above says "closed".
  if (serverEnv('ALLOW_MOCK_CHECKOUT') === '1') return null;
  return 'mock-payments';
}

export function checkoutIsOpen(): boolean {
  return checkoutClosedReason() === null;
}

/**
 * Should every page tell crawlers to stay away?
 *
 * Read through `serverEnv` rather than `import.meta.env`, so it is a server setting that can be
 * changed on the host and take effect on restart — `import.meta.env` is frozen at BUILD time, and a
 * switch that needs a rebuild is one that will not be flipped at the moment it should be
 * (memory `project_runtime_env_reading`).
 */
export function siteIsHiddenFromSearch(): boolean {
  return serverEnv('SITE_NOINDEX') === '1';
}
