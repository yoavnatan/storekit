/**
 * The admin bell's feed — every alert that puts a number on a tab, as a ROW you can click.
 *
 * ── Why this is derived and not a table ─────────────────────────────────────
 *
 * `notifications` is a real table with real rows, written when something happens to a buyer or a
 * seller. Nothing writes one for the admin, and adding a writer at each of the five places that can
 * raise a tab badge would be the classic second definition: the day someone adds a sixth source,
 * the badge counts it and the bell does not, and the bell is then a signal that is quietly wrong.
 *
 * So the bell is DERIVED from the same five sources `admin-tab-badges.ts` counts, with the same
 * predicates. "Every alert on a tab is in the bell" is then true by construction rather than by
 * discipline — `tests/admin-notifications.test.ts` holds the two together by asserting that the
 * unread items here group into exactly the counts that module produces.
 *
 * **One term is deliberately outside that equality, and it is the only one.** The Alerts badge adds
 * 1 when image moderation has STOPPED — a condition, still true after it has been read, which is
 * why the badge treats it as one rather than as a count of its reports. A bell is a list of
 * arrivals, so it carries no row for it; the Alerts tab's own card is what says the filter stopped.
 * The test asserts the alerts equality against the error term alone and names this.
 *
 * The cost is that an admin notification has no read flag of its own. It does not need one: four of
 * the five are already measured against "when did you last open that tab" (`admin-tab-views.ts`)
 * and the fifth carries `read_by_admin` per message. Opening the tab is the acknowledgement, which
 * is the vocabulary the strip already uses.
 *
 * ── One statement ───────────────────────────────────────────────────────────
 *
 * A UNION ALL rather than five queries, for the reason the badge module states: the database is
 * over the network, ~64ms a crossing regardless of the query, and this runs on a poll.
 *
 * ── What each row has to carry, and why ─────────────────────────────────────
 *
 * `id` is a STABLE, source-prefixed string, and that is what makes the toast dedup work. The
 * `ToastContainer` skips a repeat by `key`, and the admin poller passes this — so a row that is
 * still unread on the next poll re-appears in the feed and does NOT toast a second time. An id
 * built from a row number, or from the poll's own index, would toast the same seller every fifteen
 * seconds until someone opened the tab.
 *
 * `tab` is the panel the click leads to. Held here rather than mapped in the browser for the reason
 * `notification-link.ts` exists on the seller side: where a notification leads is a property of the
 * thing that happened, and a second copy of that mapping in a script is how a click starts landing
 * on the wrong screen.
 */
import { rows } from './db.js';
import { MODERATION_MISSING_MARKER } from './image-moderation.js';
import { CHECKOUT_GROUP_KEY_SQL } from './checkout-group.js';
import type { TabViews } from './admin-tab-views.js';

export interface AdminNotification {
  /** Source-prefixed and stable across polls — the toast dedup key. */
  id: string;
  /** The admin panel this belongs to; the click target. */
  tab: 'sellers' | 'stores' | 'orders' | 'alerts' | 'messages';
  title: string;
  body: string;
  /** ISO. Newest first in the returned list. */
  createdAt: string;
  /** Has the admin seen the tab this arrived on since it arrived? */
  unread: boolean;
}

interface FeedRow {
  id: string;
  tab: AdminNotification['tab'];
  title: string;
  body: string;
  created_at: Date | string;
  unread: boolean;
}

/**
 * How many rows the bell holds at once.
 *
 * Fifty, matching the seller bell's own cap. A bell is a list of what needs attention, not an
 * archive — the tab behind each row is where the full set lives, and a dropdown that pages through
 * a thousand errors is a worse version of the Alerts tab.
 */
export const ADMIN_NOTIFICATION_LIMIT = 50;

/**
 * The feed, newest first.
 *
 * `since` is the poller's cursor: with it, only rows created after that instant come back, which is
 * what turns a poll into "what is new" without re-toasting the backlog. Without it, the most recent
 * `ADMIN_NOTIFICATION_LIMIT` rows, which is what the dropdown renders.
 */
export async function getAdminNotifications(
  newSince: TabViews,
  since?: string,
): Promise<AdminNotification[]> {
  // A single bound parameter for the cursor, compared as a nullable timestamp so the same statement
  // serves both callers — a second query shaped almost like this one is exactly the drift this
  // module exists to avoid.
  const feed = await rows<FeedRow>(
    `WITH feed AS (
       SELECT 'seller:' || s.id::text AS id, 'sellers' AS tab,
              'מוכר חדש נרשם' AS title,
              coalesce(nullif(s.name, ''), s.email::text) AS body,
              s.created_at, (s.created_at > $1::timestamptz) AS unread
         FROM sellers s

       UNION ALL
       SELECT 'store:' || st.id::text, 'stores',
              'חנות חדשה נפתחה', st.name,
              st.created_at, (st.created_at > $2::timestamptz)
         FROM stores st WHERE st.deleted_at IS NULL

       UNION ALL
       -- Grouped by the checkout key, not by order row: the Orders tab lists PURCHASES, so a
       -- five-store cart is one card there and must be one line here. The badge counts the same
       -- way (admin-tab-badges.ts), and a bell that disagreed with the number above it would be
       -- the first thing anybody noticed.
       -- The prefix is 'purchase:', and the obvious one is deliberately avoided: lib/guest-sender.ts
       -- has already claimed it to mark a message sender who has no account, and
       -- tests/guest-sender.test.ts scans the tree for that literal — because one prefix carrying
       -- two meanings is how a reply silently becomes a letter instead of a notification. The guard
       -- caught this on its first run, which is exactly what it is for. (It scans raw source, so
       -- the string is not spelled out even here.)
       SELECT 'purchase:' || ${CHECKOUT_GROUP_KEY_SQL}, 'orders',
              'הזמנה חדשה', max(o.buyer_name),
              min(o.created_at), (min(o.created_at) > $3::timestamptz)
         FROM orders o GROUP BY ${CHECKOUT_GROUP_KEY_SQL}

       UNION ALL
       -- The moderation reports are excluded here for the reason the badge excludes them: one
       -- stopped filter produces one report per uploading session, so a bell listing them would
       -- carry twenty rows about a single condition. The Alerts tab's own card is what says the
       -- filter stopped; that is a condition, not an arrival, and a bell is for arrivals.
       SELECT 'error:' || e.id::text, 'alerts',
              'תקלה נרשמה', e.message,
              e.created_at, (e.created_at > $4::timestamptz)
         FROM error_log e
        -- No resolved filter, and that is the badge's contract rather than an oversight: the tab
        -- counts every error that ARRIVED since it was last opened, resolved or not, so filtering
        -- here would put a number on the tab with no row behind it in the bell. Resolving is not
        -- the same act as reading, and the bell follows the number above it.
        WHERE e.message NOT LIKE $5

       UNION ALL
       -- Compared with <> 'admin', never with = 'seller': the inbox holds buyers and guests too,
       -- and a predicate naming one role stops counting silently the moment a second exists.
       -- (No backticks anywhere inside this SQL, not even in a comment - the whole statement is one
       -- template literal, so one backtick ends it and the rest of the file is parsed as
       -- expressions. Memory project_astro_inline_template_backtick; it cost this file a build.)
       SELECT 'msg:' || m.id::text, 'messages',
              'פנייה חדשה', coalesce(nullif(m.subject, ''), m.content),
              m.created_at, true
         FROM admin_messages m
        WHERE m.from_role <> 'admin' AND NOT m.read_by_admin
     )
     SELECT id, tab, title, body, created_at, unread
       FROM feed
      WHERE $6::timestamptz IS NULL OR created_at > $6::timestamptz
      ORDER BY created_at DESC, id
      LIMIT ${ADMIN_NOTIFICATION_LIMIT}`,
    [newSince.sellers, newSince.stores, newSince.orders, newSince.alerts,
     `${MODERATION_MISSING_MARKER}%`, since ?? null],
  );

  return feed.map((row) => ({
    id: row.id,
    tab: row.tab,
    title: row.title,
    // Trimmed here rather than in the renderer: an error message can be a stack-adjacent paragraph,
    // and a dropdown row that grows to eight lines pushes everything under it off the screen.
    body: String(row.body ?? '').trim().slice(0, 160),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    unread: Boolean(row.unread),
  }));
}

/** How many of the feed's rows are unread — the number on the bell. Counted from the same list the
 *  dropdown shows, so the badge can never disagree with what opening it reveals. */
export function unreadCount(items: readonly AdminNotification[]): number {
  return items.filter((item) => item.unread).length;
}
