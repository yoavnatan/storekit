-- "דווח על תקלה" — a report a VISITOR writes to the platform, from inside the site.
--
-- Deliberately not a subject line on a `mailto:` (which is what `/contact` offered until today) and
-- deliberately not a row in `error_log`. Both were considered; here is why neither is this table.
--
-- **Why not the mailto.** The three things that make a report actionable are the three a person
-- cannot type: which page they were on, which store or product it was, and who they were when it
-- happened. A mail arrives as "משהו לא עובד" with none of them, and the reply address is the only
-- thing it reliably carries. Everything in the `page_url` / `store_slug` / `reporter_*` columns
-- below is captured by the server from the request, never asked for.
--
-- **Why not `error_log`.** That table is a rolling window — `MAX_ENTRIES` = 500, enforced in the
-- write statement, oldest deleted — because it holds machine-generated 500s where losing the tail
-- costs nothing. A human took the trouble to write here, and a burst of automated errors must not
-- push their report out of existence. Reports are also the only entries with a lifecycle a person
-- drives (`status` below); the error log's `resolved` flag is a triage marker on something that
-- already happened, not a queue.
--
-- **No cap and no purge, on purpose.** The volume ceiling is the rate limiter in front of the
-- endpoint (`lib/rate-limit.ts#reportRules`), not a row count — an abuse report that expires is a
-- report the platform silently stopped honouring. Retention is a privacy decision that belongs with
-- the order-retention one still open in GO_LIVE §4, not a number invented here.

CREATE TABLE IF NOT EXISTS user_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the reporter said this is. The set is short on purpose: it is a triage hint, and a long
  -- menu makes a reporter classify instead of describe. `content` is the one with teeth — it is the
  -- human backstop for anything an automatic filter did not catch (an image the moderation add-on
  -- passed, wording `spam-filter.ts` has no keyword for).
  kind           text NOT NULL CHECK (kind IN ('fault', 'content', 'store', 'other')),
  message        text NOT NULL,
  -- Where they were when they reported, as a SITE-RELATIVE path. Captured from the page, then
  -- re-validated server-side through `safe-redirect.ts#safeRedirectPath` — it is rendered as a link
  -- in the admin panel, so an absolute URL a caller supplied would make this table a way to put an
  -- off-site link in front of the admin.
  page_url       text,
  -- Which store this is about, resolved server-side from `page_url` — never taken from the body.
  -- Not a foreign key: a report about a store that has since been deleted is exactly the report
  -- most worth keeping, and ON DELETE CASCADE would remove it.
  store_slug     text,
  -- Optional. The only way to answer a guest, and the reason the form asks for nothing else.
  reporter_email text,
  -- Server-derived from the session, never from the body: 'seller' and 'buyer' are claims about
  -- identity, and a claim a request makes about itself is not one.
  reporter_role  text CHECK (reporter_role IS NULL OR reporter_role IN ('guest', 'buyer', 'seller')),
  reporter_id    text,
  -- The one technical fact a "the page is broken" report is useless without, and the one nobody
  -- can quote correctly when asked.
  user_agent     text,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  handled_at     timestamptz
);

-- The admin panel's only two reads: the open queue, and the newest-first list. Both are
-- (status, created_at DESC), so they are one index.
CREATE INDEX IF NOT EXISTS user_reports_status_created_idx ON user_reports (status, created_at DESC);
