-- A hostname may be CLAIMED by anyone and SERVED by only one store.
--
-- `custom_domain_hostname citext UNIQUE` (0001) enforced the wrong one of those two. A seller types
-- a hostname into their settings and it stores as `pending` — an assertion, nothing more; the field
-- takes any string and every logged-in seller has one. Making that assertion globally exclusive
-- handed every seller a free, permanent squat on any hostname they liked: it can never verify (they
-- do not control the DNS), so it sits pending forever, and the party who DOES own the domain is
-- answered `domain-taken` every time they try to connect it, with no way to see why or by whom.
-- Found in the area-audit of domains + the origin boundary, 2026-08-16.
--
-- Two pending claims on one hostname conflict over nothing: `getStoreByCustomDomain` matches
-- `'active'` only, so neither routes, and whichever one verifies is the one that becomes real.
-- ACTIVE is where ambiguity would be a live defect — two stores answering to one host, and which
-- one a visitor gets decided by row order — so that is what stays unique.
--
-- Not additive in the usual sense (a constraint is dropped), but zero-downtime SAFE in the
-- direction that matters: the old code refuses strictly MORE than the new constraint does, so a
-- deployed old version running against this schema still rejects everything it rejected before. It
-- simply keeps refusing a duplicate pending claim it no longer has to. Nothing reads the constraint.
--
-- The application refuses the same thing one step earlier and with a readable message
-- (`isCustomDomainTaken`, now scoped to active), and the promotion re-asks before writing
-- `'active'` (`custom-domain-verify.ts`) so this index is the floor under that check rather than
-- the thing users meet.
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_custom_domain_hostname_key;

CREATE UNIQUE INDEX IF NOT EXISTS stores_custom_domain_active_uniq
  ON stores (custom_domain_hostname)
  WHERE custom_domain_status = 'active' AND custom_domain_hostname IS NOT NULL;

-- The lookup path is unchanged in shape but no longer rides the dropped constraint's index: every
-- request on a custom host resolves Host → store through `custom_domain_hostname`, including the
-- pending rows the settings screen reads back. The partial index above cannot serve those.
CREATE INDEX IF NOT EXISTS stores_custom_domain_hostname_idx
  ON stores (custom_domain_hostname)
  WHERE custom_domain_hostname IS NOT NULL;
