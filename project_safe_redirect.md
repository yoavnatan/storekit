---
name: project_safe_redirect
description: All request-supplied redirect destinations go through src/lib/safe-redirect.ts — the check used to be copy-pasted into 4 routes and missing from a 5th (/api/lang trusted Referer)
metadata: 
  node_type: memory
  type: project
  originSessionId: 2d0bfe33-3764-4775-9ba0-d49500507d68
  modified: 2026-07-29T17:57:28.944Z
---

**One helper owns the decision: `src/lib/safe-redirect.ts`** (built 2026-07-29). `safeRedirectPath(raw, fallback, reject[])` for a path from a query param or cookie; `safeRefererPath(referer, origin, fallback)` for a `Referer` header, which arrives as an absolute URL and is only honoured when its origin is ours. Used by `seller/login.astro`, `seller/register.astro`, `seller/logout.ts`, `api/auth/google.ts` (sanitised before the `oauth_next` cookie is written) and `api/auth/google/callback.ts` (re-validated at the point of redirect, deliberately), plus `api/lang.ts`.

**Why it exists — the failure mode, not the bug.** The rule was three lines (`startsWith('/') && !startsWith('//')`) copy-pasted into four routes. `/api/lang` was written later and simply never got them: it 303'd to the raw `Referer`, so any site could POST there and have our own origin bounce the visitor onward. A duplicated check does not rot in the copies — it rots in the file that never received one. Found during an end-of-session docs audit, not by a security pass.

**How to apply:** never hand-roll the check again; `tests/safe-redirect.test.ts` asserts that no file under `src/pages` contains `startsWith('//')` and that no route feeds a `Referer` into a `Location`. If a new flow needs a return-path, import the helper. Recorded in `AI_INSTRUCTIONS.md` under Hard rules → Security review gate.

Related: [[feedback_fix_security_dont_report]], [[feedback_security_priority]], [[project_cart_auth_session]]
