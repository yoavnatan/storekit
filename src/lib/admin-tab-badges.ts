import { firstRow } from './db.js';
import { MODERATION_MISSING_MARKER } from './image-moderation.js';
import { MODERATION_STALE_DAYS, moderationDeclaredOn } from './image-moderation-health.js';
import { CHECKOUT_GROUP_KEY_SQL } from './checkout-group.js';
import type { TabViews } from './admin-tab-views.js';

/**
 * The "(N)" on each admin tab — how many rows arrived in that tab since the admin last left it.
 *
 * **This is the one thing on the dashboard that must be computed for tabs the admin is NOT looking
 * at, and it is a requirement rather than a nicety (owner, 2026-08-07).** The whole point of the
 * badge is to say that something happened somewhere they are not looking; a badge that only knows
 * about the open tab knows nothing worth knowing.
 *
 * That is why it exists as its own module and its own query. The counts used to be derived in JS
 * from whatever list the page had already loaded — `sellers.filter(…)`, `stores.filter(…)`,
 * `errorsAll.filter(…)` — which was free while the page loaded every list on every request. The
 * moment panels load lazily those lists are gone, and the failure mode is the bad kind: no error,
 * no warning, three badges quietly stuck at zero, and an owner who now trusts a signal that has
 * stopped working. `tests/admin-tab-badges.test.ts` fails on any badge derived from a list that is
 * no longer unconditionally loaded.
 *
 * **One round trip for all five.** The database is over the network (~64ms a crossing regardless of
 * the query), so five `COUNT`s in one statement cost what one costs — and this statement runs on
 * every dashboard request, including every panel swap, whatever tab is open.
 */
/** A `type`, not an `interface`, and deliberately: the tab strip walks the tab list and indexes
 *  these by a plain `string` id, which TypeScript allows for a type alias (it gets an implicit index
 *  signature) and refuses for an interface. */
export type AdminTabBadges = {
  sellers: number;
  stores: number;
  orders: number;
  alerts: number;
  /** Unread admin-side messages — an exact per-message signal, more precise than a per-tab
   *  timestamp, so this one is not measured against a `newSince` boundary at all. */
  messages: number;
};

export async function getAdminTabBadges(newSince: TabViews): Promise<AdminTabBadges> {
  const row = await firstRow<Record<string, string | number>>(
    `SELECT
       (SELECT count(*) FROM sellers WHERE created_at > $1::timestamptz) AS sellers,
       (SELECT count(*) FROM stores  WHERE created_at > $2::timestamptz) AS stores,
       -- DISTINCT on the checkout-group key, because the Orders tab lists PURCHASES: a five-store
       -- cart is one card there, and a badge counting rows would announce "5 new" above a list
       -- showing one (order-reporting.ts#countOrdersSince, which this replaces on this page).
       (SELECT count(DISTINCT ${CHECKOUT_GROUP_KEY_SQL}) FROM orders o WHERE o.created_at > $3::timestamptz) AS orders,
       -- The Alerts tab holds three things — the automatic error log, the reports visitors wrote
       -- (AdminReportsPanel.astro) and whether image moderation is running at all
       -- (AdminModerationStatus.astro) — so its badge counts all three against the same boundary.
       -- Counting only the errors would leave the one entry a PERSON is waiting on as the one the
       -- tab strip never mentions.
       --
       -- **The moderation term is ONE, never a count of its reports, and that is the point (owner,
       -- 2026-08-13: "make stopped add a number").** A stopped filter is reported by the BROWSER
       -- on upload, so a seller loading a catalogue files one report per session and twenty sellers
       -- file twenty — for a single condition. Counting those rows would put "(20)" on the tab for
       -- one problem, which is how a number stops meaning anything. So the raw reports are excluded
       -- from the error count above (NOT LIKE) and the condition contributes exactly 1.
       (SELECT count(*) FROM error_log
         WHERE created_at > $4::timestamptz AND message NOT LIKE $5) AS alert_errors,
       (SELECT count(*) FROM user_reports WHERE created_at > $4::timestamptz) AS alert_reports,
       -- Deliberately NOT measured against newSince: every other badge counts things that ARRIVED,
       -- and opening the tab is a complete answer to them. This is a condition that is still true
       -- after it has been read, so it clears when the filter comes back — not when it is looked at.
       -- NOT resolved, in step with image-moderation-health.ts: the badge and the section it
       -- carries the admin to must answer the same question, or the tab shows "(1)" over a card
       -- that has already been dismissed. See that file for why dismissal is allowed at all.
       (SELECT count(*) FROM error_log
         WHERE message LIKE $5 AND NOT resolved
           AND created_at > now() - make_interval(days => $6)) AS moderation_reports,
       (SELECT count(*) FROM admin_messages WHERE from_role = 'seller' AND NOT read_by_admin) AS messages`,
    [newSince.sellers, newSince.stores, newSince.orders, newSince.alerts,
     `${MODERATION_MISSING_MARKER}%`, MODERATION_STALE_DAYS],
  );
  // `count` is a bigint: a string from `pg`, a number from PGlite (§8). Left alone, the badge would
  // render `(3)` one way and `("3")` the other, and `count === 0` would never be true.
  const n = (value: string | number | undefined) => Number(value ?? 0);
  // One, or nothing. `moderationDeclaredOn()` gates it because an add-on nobody enabled is not an
  // incident — it is the platform's standing configuration, and a badge that can never reach zero
  // is furniture (memory `feedback_no_standing_screen_prose`). The section at the top of the tab is
  // what says "off"; this number is only ever about a filter that WAS running and stopped.
  const moderationStopped = moderationDeclaredOn() && n(row?.moderation_reports) > 0 ? 1 : 0;

  return {
    sellers: n(row?.sellers),
    stores: n(row?.stores),
    orders: n(row?.orders),
    alerts: n(row?.alert_errors) + n(row?.alert_reports) + moderationStopped,
    messages: n(row?.messages),
  };
}
