-- One inbox for everything a PERSON writes to the platform — seller, buyer or guest.
--
-- ── What was wrong (owner, 2026-08-19) ──
-- There were two inbound channels and they were split by the wrong seam. `admin_messages` held
-- real conversations, but only the admin could START one and only with a seller. `user_reports`
-- held everything else — a guest whose checkout broke, a shopper reporting a product photo, a
-- seller asking a question — as a one-way slip on the "התראות ושגיאות" tab, with no way to answer
-- inside the product.
--
-- The owner's ruling was about that tab first: *"המטרה של הלשונית הזאת הייתה לוגים של כשלים
-- באפליקציה, לא פניות ממוכרים. בשביל זה יש את הודעות"*. A tab defined by machine-detected failures
-- had become the place human sentences arrived, which cost twice: the sentences could not be
-- replied to, and the failure log stopped being a failure log.
--
-- So the seam moves to where it belongs — machine events in the log, people in the inbox — and
-- this migration is what lets the inbox hold people who are not sellers.
--
-- ── Why extend this table rather than give reports their own replies ──
-- The alternative was a `user_report_replies` table beside the existing threads, and it was
-- rejected for the reason `admin-messages.ts` already states about its own move: the Messages
-- screen sorts, filters and paginates ACROSS every thread it shows. Two thread models on one list
-- is two sets of rules for "unread", "last message" and "who am I talking to", and they drift the
-- first time only one of them is touched. One model, one set of rules.
--
-- ── Backward compatible, per the zero-downtime rule ──
-- Every column added is nullable, and the only relaxations are relaxations: `seller_id` loses NOT
-- NULL, `from_role` gains two allowed values. The version running during the deploy keeps working —
-- it writes `seller_id` exactly as before, and its reads are all `WHERE seller_id = $1`, which a
-- NULL row simply never matches. It cannot SEE a guest thread, which is correct; it can never be
-- broken by one.

-- A thread's counterparty need not have an account. `seller_id` stays for the ones that do — the
-- seller's own dashboard reads by it, and a foreign key is worth more than a text column whenever
-- there is a real row to point at.
ALTER TABLE admin_messages ALTER COLUMN seller_id DROP NOT NULL;

-- Who wrote THIS message. 'seller' predates this migration and is kept rather than folded into a
-- generic 'party': the existing rows say it, and rewriting history to make a CHECK tidier is how a
-- column stops meaning what the rows in it mean.
ALTER TABLE admin_messages DROP CONSTRAINT IF EXISTS admin_messages_from_role_check;
ALTER TABLE admin_messages ADD CONSTRAINT admin_messages_from_role_check
  CHECK (from_role IN ('admin', 'seller', 'buyer', 'guest'));

-- ── Root-only columns. A reply carries none of them; the thread's identity is its root. ──

-- Who the platform is talking to. Derived from the SESSION on the way in, never from the body —
-- the same rule `user_reports` states and for the same reason: a claim a request makes about its
-- own identity is not one.
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS party_role text
  CHECK (party_role IS NULL OR party_role IN ('seller', 'buyer', 'guest'));
-- The account id when there is one, as TEXT and not a uuid: a guest has no account, and a buyer id
-- and a seller id are not the same namespace. `seller_id` above stays the typed, foreign-keyed
-- answer for the case that has one.
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS party_id text;
-- What to call them on screen, and the only way back to a guest. Both optional: a report is worth
-- more than the way back to its author (`api/report.ts` drops an unusable address rather than
-- refusing the report), and the panel says "ללא כתובת לחזרה" instead of offering a mailto that
-- bounces.
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS party_name text;
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS party_email text;

-- The reporter's own classification — a triage hint, never a routing decision. Same short set
-- `user_reports` used, plus 'question', which is what a seller writing to the platform is doing and
-- what the old form had no word for. Kept short for the reason migration 0025 gives: a long menu
-- makes a reporter classify instead of describe.
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS about_kind text
  CHECK (about_kind IS NULL OR about_kind IN ('fault', 'content', 'store', 'question', 'other'));

-- The three facts that make a report actionable and that nobody can type: where they were, which
-- store it was about, and — when the complaint is about a published review — which review. All
-- captured server-side.
--
-- `page_url` is site-RELATIVE and re-validated through `safe-redirect.ts` before it is stored,
-- because the panel renders it as a link.
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS page_url text;
-- Not a foreign key, exactly as in 0025: a complaint about a store that has since been deleted is
-- the complaint most worth keeping, and ON DELETE CASCADE would remove it.
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS store_slug text;
-- **This one IS a foreign key, and ON DELETE SET NULL rather than CASCADE.** The complaint must
-- outlive the review — that is the whole point of a takedown record — but a dangling id would have
-- the panel try to render a review that is gone. Reviews are never hard-deleted by the product
-- today (`setReviewBlocked` hides), so this is the floor under a manual cleanup, not a routine path.
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS review_id uuid
  REFERENCES product_reviews(id) ON DELETE SET NULL;

-- The lifecycle a person drives, which `admin_messages` never had — it only had "read". Read is
-- about attention; this is about the work. A thread the admin has read and not acted on is the one
-- that used to disappear from view.
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'handled'));
ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS handled_at timestamptz;

-- The inbox's own read: roots only, newest first, and the open ones first when the toolbar asks.
-- Partial on `reply_to_id IS NULL` because a reply is never a row in that list.
CREATE INDEX IF NOT EXISTS admin_messages_inbox_idx
  ON admin_messages (status, created_at DESC)
  WHERE reply_to_id IS NULL;

-- ── The reports that already exist become threads ──
--
-- They are demo data today (memory `project_all_data_is_demo`), so this could have been a DELETE.
-- It is a copy instead because the shape has to be proved on real rows at least once, and because
-- the day this runs against a live database is the day it must not lose somebody's report.
--
-- `user_reports` is NOT dropped here. Two deploys, per the zero-downtime rule: the version being
-- replaced still reads that table, and a table removed in the same deploy that stops writing it is
-- the breaking change the rule exists to prevent. Its own migration comes after this one has
-- shipped, and GO_LIVE §4 carries the reminder.
INSERT INTO admin_messages (
  id, seller_id, from_role, subject, content, reply_to_id,
  read_by_admin, read_by_seller, created_at,
  party_role, party_id, party_email, about_kind, page_url, store_slug, status, handled_at
)
SELECT
  gen_random_uuid(),
  -- A seller's own report becomes a thread that seller can see in their dashboard, which is the
  -- upgrade this whole change is about. `::uuid` is guarded by the regex: `reporter_id` is text and
  -- holds pre-uuid ids on old rows.
  CASE WHEN r.reporter_role = 'seller' AND r.reporter_id ~ '^[0-9a-fA-F-]{36}$'
       THEN r.reporter_id::uuid ELSE NULL END,
  COALESCE(r.reporter_role, 'guest'),
  -- No subject was ever asked for, so the kind becomes one. A thread with no subject renders as
  -- `DEFAULT_ADMIN_SUBJECT` and would tell the admin nothing about which report it was.
  CASE r.kind
    WHEN 'fault'   THEN 'דיווח על תקלה'
    WHEN 'content' THEN 'דיווח על תוכן'
    WHEN 'store'   THEN 'פנייה בנוגע לחנות'
    ELSE 'פנייה'
  END,
  r.message,
  NULL,
  -- An untouched report arrives unread; one already marked handled has plainly been read.
  (r.status = 'handled'),
  false,
  r.created_at,
  COALESCE(r.reporter_role, 'guest'),
  r.reporter_id,
  r.reporter_email,
  r.kind,
  r.page_url,
  r.store_slug,
  r.status,
  r.handled_at
FROM user_reports r
-- Idempotent: re-running must not double the inbox. Matched on the pair that cannot collide
-- between two distinct reports.
WHERE NOT EXISTS (
  SELECT 1 FROM admin_messages m
   WHERE m.reply_to_id IS NULL
     AND m.created_at = r.created_at
     AND m.content = r.message
);
