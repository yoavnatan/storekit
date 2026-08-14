-- "שכחתי סיסמה" — the one-time link a seller uses to set a new password.
--
-- Until now the platform had no recovery path at all. `lib/seller-auth.ts` could verify a password
-- and change one for a seller who is already signed in, and that was the whole of it: a seller who
-- forgot theirs was locked out permanently, and the only remedy was the owner editing a hash by
-- hand in the database. That is a launch blocker on its own — a marketplace cannot ask its sellers
-- to never forget.
--
-- ── Why a table, and why this shape ──────────────────────────────────────────
--
-- **The token is not stored.** `token_hash` holds SHA-256 of the value that went out in the mail,
-- and the value itself exists nowhere on our side. A database read — a backup on a laptop, a dump
-- in a support thread — therefore does not hand anybody a working link to any account.
--
-- **SHA-256 here, scrypt for passwords, and the difference is not an oversight.** A password is a
-- short human-chosen string, so a leak is attacked by guessing and the defence is to make each
-- guess expensive; that is what `seller-auth.ts` uses scrypt for. A token here is 32 bytes from
-- `crypto.randomBytes` — 256 bits with no structure to guess — so slow hashing buys nothing and
-- would only add latency to the click. What matters is that the stored form cannot be reversed,
-- and a single SHA-256 gives that.
--
-- **One hour, and one use.** `expires_at` bounds a link left sitting in an inbox (or in a mailbox
-- somebody else later gains access to); `used_at` stops the same link being replayed after the
-- password is already changed. Both are checked in SQL, in the same statement that consumes the
-- row, so two simultaneous clicks cannot both win.
--
-- **`ON DELETE CASCADE`.** A deleted seller's outstanding links must not outlive them; there is
-- nothing here worth keeping once the account is gone.
--
-- ── What this deliberately does NOT do ───────────────────────────────────────
--
-- It does not sign existing sessions out. `seller-auth.ts` issues a SIGNED COOKIE and keeps no
-- server-side session record, so there is no list of live sessions to revoke — a reset changes the
-- password without ending a session already open elsewhere. Stated here rather than left implied,
-- because "reset the password to kick the intruder out" is the natural assumption and it is not
-- true today. Closing it means a session-version column on `sellers` and a check on every request,
-- which is a change to the auth hot path and not something to bolt onto this migration.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id   uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  -- SHA-256 hex of the emailed token. UNIQUE so a lookup is an index hit and a collision is a
  -- constraint violation rather than two accounts sharing a link.
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  -- NULL until the link is spent. The redeem statement sets it in the same UPDATE that checks it.
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Issuing a new link invalidates the seller's older ones, and the purge deletes by seller too.
-- Both are `WHERE seller_id = $1`, so they are one index.
CREATE INDEX IF NOT EXISTS password_reset_tokens_seller_idx ON password_reset_tokens (seller_id);

-- The housekeeping sweep: everything already expired, regardless of owner.
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx ON password_reset_tokens (expires_at);
