/**
 * How long each kind of personal data actually stays, as constants the privacy policy interpolates.
 *
 * **Why this file exists rather than digits in the copy.** `/privacy` is a published legal
 * statement: a retention window written there as a number, and separately in the code that enforces
 * it, is a pair that will eventually disagree — and the copy is the half a person can hold us to.
 * The same rule `terms.astro` already follows for the fulfilment deadlines (`order-sla.ts`), and
 * `tests/privacy-policy.test.ts` pins that the page carries no bare number of its own.
 *
 * **Everything here is a statement about what the code DOES, not a policy someone would like.** If
 * a purge changes, this file changes with it and the page follows; nothing else needs touching.
 *
 * Legal frame: תיקון 13 לחוק הגנת הפרטיות (in force 2025-08-14) requires the retention and deletion
 * policy to be stated in the privacy notice — the professional guide the Authority published, §11's
 * expanded duty. `docs/legal-privacy-accessibility.md` carries the sourcing.
 */

import { VISITOR_RETENTION_DAYS } from './visitor-retention.js';
import { MAX_RATE_WINDOW_SEC } from './rate-limit.js';
import { ATTRIBUTION_WINDOW_DAYS } from './attribution.js';

/** Per-visitor analytics detail (`analytics_visitors`, `store_page_view_visitors`). Re-exported
 *  rather than restated so the policy and the purge are one number — that module owns the why. */
export { VISITOR_RETENTION_DAYS };

/** Order rows, their items and the money journal.
 *
 *  **`null` means "no window exists in the code today", and that is the truth rather than an
 *  omission** — `money_events` is append-only to the point of `REVOKE UPDATE, DELETE` in
 *  production (GO_LIVE §6), because a financial journal is evidence. What has NOT been decided is
 *  how long the buyer's identifying fields inside those rows should live before they are
 *  anonymised, which is a question for the רו״ח (how many years an accounting record must be kept)
 *  and the עו״ד — it is an open ⚠️ row in GO_LIVE. The policy therefore states the DUTY and the
 *  fact, and promises no number nobody has set. When one is set, it lands here and the page moves
 *  with it. */
export const ORDER_RETENTION_YEARS: number | null = null;

/** A failed-attempt counter, keyed by e-mail and by origin IP (`auth_attempts`, `lib/rate-limit.ts`).
 *  This is the only place an IP address is written down at all, and a successful login deletes the
 *  row before the window is even reached.
 *
 *  Derived from `MAX_RATE_WINDOW_SEC` — the LONGEST window any rule builder may return, which that
 *  module's test enforces — rather than from the 15-minute login window, because the policy has to
 *  cover every bucket in the table and not the shortest of them. */
export const AUTH_ATTEMPT_RETENTION_MINUTES = MAX_RATE_WINDOW_SEC / 60;

/** How long the arrival-source cookie (`sn_attr`) is honoured — it is what lets a seller see which
 *  campaign a sale came from. Owned by `lib/attribution.ts`; re-exported so the policy quotes the
 *  same number the code decides with. */
export { ATTRIBUTION_WINDOW_DAYS };

/** The visitor cookie's own lifetime, in days — the same window as the rows it keys, because a
 *  cookie that outlives its data identifies a person for nothing. */
export const VISITOR_COOKIE_DAYS = VISITOR_RETENTION_DAYS;
