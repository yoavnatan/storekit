---
name: project_error_capture_surface
description: The four places an error can happen and which reporter owns each; the middleware try/catch only covers page frontmatter
metadata: 
  node_type: memory
  type: project
  originSessionId: bd82f38e-4192-4631-8b9e-e144e6c3dfde
  modified: 2026-08-05T18:28:57.442Z
---

Audited and closed 2026-08-05. Four surfaces, four owners — a new error path belongs to exactly one:

1. **Page frontmatter** → `middleware.ts` try/catch → `logError` (status 500).
2. **Anything rendered after that** → `lib/stream-errors.ts`. **This is the one that surprises.**
   Astro streams, so `await next()` resolves when the page frontmatter finishes and rendering
   *begins* — every COMPONENT's frontmatter (including `BaseLayout`, which reads the DB and issues a
   CSRF token on every page) throws outside the try block. It used to reach the socket as a bare
   "Internal server error" with nothing logged. The wrapper reports and re-raises; it cannot recover,
   the headers are already gone. Entries carry a `resolutionHint` saying to look at a component.
   Related: `http-compress.ts` uses `pipeline`, not `.pipe()` — `.pipe()` swallows a source error and
   the socket HANGS instead of ending, which no browser or monitor can tell from a slow page.
3. **Browser** → `scripts/error-reporter.ts` (`error` + `unhandledrejection`, 5/page-load,
   `keepalive`), loaded by BaseLayout, which every page but `500.astro` uses.
4. **Fire-and-forget promises** → `lib/process-errors.ts`. Re-throws to preserve Node's default
   crash — installing a listener would otherwise suppress it. No `uncaughtException` handler on
   purpose.

**Two rate limits, deliberately independent:** `MAX_CONCURRENT_WRITES` (2) bounds pool usage at an
instant; `MAX_CLIENT_WRITES_PER_WINDOW` (60/min, per process) bounds the rate for `source: 'client'`
only, because `/api/log-client-error` is unauthenticated. Server entries stay uncapped — a storm of
500s is what you want recorded. Test the 500-row table ceiling with `source: 'server'` or you are
measuring the rate cap instead.

**Reproduce a mid-stream error cheaply:** run the BUILT server with no `AUTH_SECRET` —
`issueCsrfToken()` throws inside BaseLayout on every page. Related: [[project_error_pages_and_health]],
[[project_external_monitoring_decision]], [[project_error_severity]].
