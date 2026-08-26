-- Why a seller left — asked at the moment he leaves, and kept.
--
-- ── The gap (owner, סשן א׳ §6, 2026-08-26) ──
-- *"ביטול המנוי צריך לפתוח שם אפשרות לשאלות: למה אתה רוצה לבטל את המנוי? אפשרות לכתוב מלל חופשי,
-- אפשרות לבחור מסלול אחר או לבטל את המנוי בכל זאת."*
--
-- The cancel panel already offered the two alternatives that are genuinely cheaper than leaving —
-- a lower plan, and taking one shop off the site instead of all of them. What it never did was
-- ASK. So the one moment where a seller is both motivated and specific about what went wrong
-- passed with nothing written down, and the only thing the platform learned from a churn was that
-- it happened.
--
-- ── Two columns and not one ──
-- `cancel_reason` is one of a fixed, translated set — the thing that can be counted across sellers
-- without anybody reading prose. `cancel_note` is the free text he typed, which is where the
-- actual answer usually is and which no fixed list can anticipate. Counting the first and reading
-- the second are two different jobs, and merging them makes both worse.
--
-- ── Nullable, and it stays nullable ──
-- The dialog does not require an answer. A cancellation that is refused until a reason is picked is
-- a retention dark pattern, which is the one thing this panel was explicitly built not to be
-- (`SubscriptionCard.astro`: the cancel button is the same size as the alternatives beside it). So
-- NULL means "he did not say", which is a real and permitted answer, and every reader has to treat
-- it as one.
--
-- Additive, like every change to this table: old code that never selects these columns keeps
-- working through a deploy (AI_INSTRUCTIONS → Hard rules, zero-downtime).

ALTER TABLE seller_subscriptions ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE seller_subscriptions ADD COLUMN IF NOT EXISTS cancel_note   text;

COMMENT ON COLUMN seller_subscriptions.cancel_reason IS
  'One of CANCEL_REASONS (lib/subscription-cancel.ts) — the countable half. NULL is "he did not
   say", which the dialog permits on purpose: requiring a reason to stop paying is a dark pattern.';
COMMENT ON COLUMN seller_subscriptions.cancel_note IS
  'The free text the seller typed when cancelling. Where the real answer usually is; never parsed,
   only read.';

-- Cleared on a RESUME, in the same statement that restores the subscription, so a seller who came
-- back does not carry last time''s reason into a future cancellation report. There is no index:
-- this is read by an admin looking at churn over a whole table that holds one row per seller.
