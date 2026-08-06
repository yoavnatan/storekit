---
name: project_error_pages_and_health
description: "500.astro must import nothing that can fail, and /api/health must be short-circuited in middleware or it breaks in the only outage it exists for"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd82f38e-4192-4631-8b9e-e144e6c3dfde
  modified: 2026-08-05T15:56:07.113Z
---

Built 2026-08-05. `src/pages/500.astro` + `/api/health`, and both carry a constraint that looks like
a detail and is the whole point.

**`500.astro` is standalone — never put it on `BaseLayout`.** BaseLayout reads the database
(`getUnreadCountForUser`) and issues a CSRF token, so an error page built on it throws for the exact
reason it is being rendered — a DB outage is what produces most 500s — and Astro falls back to its
bare English default. It imports only build-time values: `main.css` (which carries the @font-face
rules), `store.config`, `i18n`, `safe-redirect`. Astro 7 SSR does use `500.astro`; before this there
was none, and the 404 page was still hard-coded English on a Hebrew-first site.
The retry link runs through `safeRedirectPath` — `Astro.url.pathname` is `//evil.example` for a
request to `//evil.example`, i.e. protocol-relative, i.e. an open redirect an attacker triggers by
making any request fail.

**`/api/health` needs its `HEALTH_PATH` short-circuit in `middleware.ts`, below the CSRF gate.**
Everything else the middleware does touches the DB, so without it the endpoint answers a 500 HTML
page during a database outage — broken in exactly and only the situation it was built for, and
invisible anywhere the DB works (found by pointing `DATABASE_URL` at a dead host). Below the gate,
not above: the gate is a set lookup + HMAC, no DB, and an exemption there would be inherited by any
POST handler added later. A 5s answer cache is what makes an unauthenticated, unrated, DB-touching
route safe to expose.

**Why it exists:** every other signal reports from inside the thing that broke — middleware catches
a 500, `error-log.ts` writes it to Postgres, the admin Alerts tab reads it. That chain is blind to a
dead process and to an unreachable database. See [[project_external_monitoring_decision]].
