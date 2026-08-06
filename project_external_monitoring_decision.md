---
name: project_external_monitoring_decision
description: "External monitoring — uptime pinger recommended, Sentry deliberately deferred; his signup is the open step"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd82f38e-4192-4631-8b9e-e144e6c3dfde
  modified: 2026-08-05T15:56:29.641Z
---

Asked 2026-08-05: is a free external monitor (Sentry / Logtail) worth adding? Answer after auditing
what exists — **yes, but not the tool he named, and not yet the one he named second.**

The two jobs are different and conflating them is the mistake:

1. **"Is the site up?"** — only an outside pinger can answer, because a dead process and an
   unreachable DB both take the admin Alerts tab down with them. `/api/health` was built for this
   ([[project_error_pages_and_health]]). **⚠️ His step, ~5 minutes: sign up for a free uptime
   monitor (UptimeRobot / Better Stack) and point it at `https://dezabin.co.il/api/health` once the
   domain is live.** Highest value per effort of anything in this area, and the only part that
   actually reaches his phone. Blocked on the domain, like most of GO_LIVE §1.
   Side effect worth deciding with GO_LIVE §6: a 5-minute ping keeps Neon's compute awake, which
   also removes the cold-start 500 — at the cost of compute hours.
2. **"What broke and where?"** — already covered at his scale by `error-log.ts` + the Alerts tab
   (server 500s with store/actor context, plus client JS errors via `/api/log-client-error`).

**Sentry: deferred, not rejected.** It adds stack-trace grouping, release tracking and breadcrumbs —
real value at several servers or for a bug that can't be reproduced from a stack trace, neither of
which is true yet. And its browser SDK is ~30KB gz on every page, straight against
[[project_seo_priority]] and [[project_cloudinary_cold_render_lcp]]. If adopted later: server-side
only. **Logtail/Better Stack log drain: check what the host already retains first** — likely
redundant.

**No longer open:** severity levels exist ([[project_error_severity]]) AND the alerting they were
the prerequisite for is built ([[project_critical_alert_email]]) — a critical error mails him,
rate-limited so the channel stays believed. The uptime pinger and that mail answer different
questions: "the site is down" vs "a buyer could not pay". Both are needed; neither replaces the other.

**Written down, not just planned (2026-08-05):** the uptime step is in `GO_LIVE_CHECKLIST.md` §1 and
in its summary table, on the same row as the DNS work it shares a day with — including the reason it
cannot be skipped and the instruction NOT to sign up before the domain is live.
