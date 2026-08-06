---
name: project_request_body_cap
description: "Content-Length is a claim, not a measurement — every API route reads its JSON body through lib/request-body.ts#readJsonBody with a BODY_LIMIT ceiling; request.json() in a route is now blocked by a guard test"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8d61f0ea-6927-4dd7-a66c-9aff25730930
  modified: 2026-08-02T17:45:20.735Z
---

**Found by `review-diff` during the analytics migration (2026-08-02), and it predated that work.** The two unauthenticated POST endpoints capped their body with `Number(request.headers.get('content-length') ?? 0) > MAX → 413`, then `await request.json()`. **A request that omits the header — every chunked request does — reads as `0`, passes the check, and is buffered and parsed in full.** The comment above one of them explicitly claimed this could not happen. Two more unauthenticated routes (`/api/wishlist`, `/api/cart/prices`) had no cap at all, and all 28 `request.json()` call sites across the API were unbounded.

**Why:** an unauthenticated sender choosing how much memory a `JSON.parse` allocates is a denial-of-service with no account and no rate limit in front of it. A size limit that only holds when the sender is honest about the size is worse than none — it makes the endpoint look bounded.

**How to apply:** never call `request.json()` in a route. `src/lib/request-body.ts#readJsonBody(request, BODY_LIMIT.x)` counts the bytes as they arrive and cancels the stream at the ceiling; it returns `{ok:true,value}` or `{ok:false,status:413|400}`, never throws. `BODY_LIMIT` is a four-word vocabulary — `control` (8KB) / `form` (32KB) / `collection` (256KB) / `upload` (5MB) — so 28 sites don't each invent a number; field-level caps still belong in the route. `tests/request-body.test.ts` is a double guard test: no file outside the module may read the `content-length` header, and no API route may call `request.json()`. Same shape as [[project_safe_redirect]] and the email-address guard — the rule only stays a rule while a second copy of it cannot appear.

**One thing the conversion exposed:** `null` is valid JSON, and several routes were relying on a `try/catch` around property reads to turn it into a 400 by accident. Where the try block became dead, use optional chaining and say so, rather than deleting the guard.

Related: [[feedback_fix_security_dont_report]], [[project_redos_regex_class]], [[project_db_migration_indexes]]
