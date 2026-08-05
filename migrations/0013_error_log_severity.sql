-- 0013_error_log_severity — how loud each entry is, decided when it is written.
--
-- The log had one bucket. A failed checkout and a JavaScript error from one visitor's ad-blocker
-- sat in the same list, in the same colour, distinguished only by whichever happened to be newer.
-- That is survivable while a person reads every line, and it is exactly what stops working at the
-- moment the log becomes useful — a bad deploy fires hundreds of entries and buries the one that
-- costs money underneath the ones that do not.
--
-- It is also the prerequisite for anything that NOTIFIES. An alerting rule needs a predicate to fire
-- on, and without a severity the only available predicates are "any error" (which means being paged
-- for a browser extension, and then muting the channel within a week — the failure mode that makes
-- alerting worse than no alerting) or a hand-maintained list of message substrings, which rots.
--
-- **Stored, not derived on read, and that is the decision this file makes.** The value could be
-- computed in the query from `route` + `status_code` + `source`, and that would let the rule evolve
-- retroactively. Stored wins for two reasons. An alerting hook will read this column with a plain
-- `WHERE severity = 'critical'` — a predicate a future notifier, a future index, and a psql session
-- can all use identically, which a rule living in TypeScript cannot offer. And retroactive evolution
-- is a misfeature here: what a route MEANT when the entry was written is the historical fact worth
-- keeping. `/api/checkout` moving off the money path later must not silently rewrite last month's
-- triage.
--
-- The rule itself lives in `lib/error-severity.ts`, alone and pure, so that it is testable without a
-- database and so that there is exactly one answer to "is this critical" in the codebase.
--
-- NOT NULL with a default, and the default is deliberately the middle value rather than the loudest:
-- every row already in the table was written before anything computed a severity, so 'error' is the
-- honest label for "a server-side failure nobody classified". Backfilling them as 'critical' would
-- put a fake emergency at the top of the first screen this feature ever shows; backfilling as
-- 'warning' would hide real 500s. The one refinement worth making is the client rows, which we know
-- were client-side and which the rule would classify as warnings anyway.
ALTER TABLE error_log
  ADD COLUMN severity text NOT NULL DEFAULT 'error'
    CHECK (severity IN ('critical', 'error', 'warning'));

UPDATE error_log SET severity = 'warning' WHERE source = 'client';

-- The Alerts tab's severity filter reads `WHERE severity = ANY(...) ORDER BY seq DESC`, and the
-- future notifier will read `WHERE severity = 'critical' AND seq > $1`. Both are this index. It
-- carries `seq DESC` as the second key so the filtered list needs no separate sort — the table is
-- capped at 500 rows (error-log.ts) so this costs almost nothing either way, but a filter that
-- degrades into a sort is the kind of thing that only shows up once the cap is raised.
CREATE INDEX error_log_severity_idx ON error_log (severity, seq DESC);
