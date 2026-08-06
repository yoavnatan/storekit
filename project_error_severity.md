---
name: project_error_severity
description: "Three severity levels on the error log, derived server-side and stored; the predicate a future notifier fires on"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd82f38e-4192-4631-8b9e-e144e6c3dfde
  modified: 2026-08-05T18:52:49.801Z
---

Built 2026-08-05 (migration 0013, `lib/error-severity.ts`, chips + badge in the admin Alerts tab).

**Three levels, and the question they answer is "would you want to be interrupted", not "how bad
does this look".** `critical` = a buyer could not complete a purchase or money/stock may be wrong ·
`error` = a real server failure that cost someone their page · `warning` = happened in one browser.

Two judgements that will look wrong later and are not:
- `/api/seller/orders` is **critical** despite looking like dashboard CRUD — a status change drives
  restock on cancellation and the buyer's "shipped" mail.
- **Every** client report is `warning`, including on `/checkout`. One report can't be told apart
  from an ad-blocker; VOLUME distinguishes a real outage and that isn't a property of one entry.
  Promoting them would page him for a browser extension, and a muted channel doesn't deliver the
  real alert either.

**Derived in `logError`, never accepted from the caller** (a severity a call site can set drifts
between call sites), and computed only from source + route + status — **not the message**, because
an attacker who can influence an error string could otherwise influence how loudly it is reported.

**Stored, not computed on read**, so a notifier / index / psql session all use
`WHERE severity = 'critical'` identically, and so what a route MEANT when written stays fixed.
Entries with no severity fall back to `'error'` everywhere — the filter must narrow, never hide.

Adding a filter param to an admin tab? It must also go in `lib/admin-nav.ts`'s per-tab whitelist or
it is stripped before the parser sees it. Related: [[project_error_capture_surface]],
[[project_external_monitoring_decision]].
