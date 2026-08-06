---
name: project_outbound_fetch
description: Every call to a third-party server goes through lib/outbound-fetch.ts; a bare fetch to an absolute URL fails a guard test
metadata: 
  node_type: memory
  type: project
  originSessionId: bd82f38e-4192-4631-8b9e-e144e6c3dfde
  modified: 2026-08-05T15:55:26.056Z
---

Built 2026-08-05. `src/lib/outbound-fetch.ts` is the only way this app calls a server that is not
itself — Resend, Cloudflare custom-hostnames, Google OAuth, IndexNow, Cloudinary derivations.
10s default deadline; a caller off the critical path raises it explicitly (`image-derive.ts` keeps
20s and says why). `isTimeout(err)` distinguishes the deadline from a network refusal.

**Why:** Node's `fetch` (undici) waits up to 300s for headers. That is the ceiling, not a budget, so
a provider that stops answering without crashing parks the buyer's or seller's request behind it for
five minutes. No `try/catch` at the call site helps — the call never returns to be caught.

**How to apply:** `tests/outbound-fetch-guard.test.ts` fails the build on a bare `fetch()` whose
first argument is absolute — it also recognises `fetch(ENDPOINT)` and `` fetch(`${API}/x`) `` by
reading each file's module-level endpoint consts, because that is how every real call site here is
written. Two documented exemptions only: the wrapper itself, and the browser Cloudinary upload
(no server request is held, and a fixed deadline would abort real 10MB uploads on a bad mobile
link). Same "one module owns it + grep guard" family as [[project_request_body_cap]],
[[project_safe_redirect]] and [[feedback_image_optimization]].
