---
name: project_auth_rate_limit
description: "Sign-in throttling built 2026-08-04 — Postgres-backed, two buckets, checked before the password; TRUST_PROXY_IP is the one thing left for launch day"
metadata: 
  node_type: memory
  type: project
  originSessionId: 73a5f086-bbe6-4701-be65-10547826dce9
  modified: 2026-08-04T17:46:41.501Z
---

**Sign-in rate limiting exists since 2026-08-04** — `src/lib/rate-limit.ts` + `auth_attempts` (migration 0009), wired into seller login, seller register and admin login. Before that, all three accepted password guesses at network speed.

**The three design decisions that must not be undone:**
- **The counter is in Postgres, never in module scope.** A per-process `Map` multiplies the ceiling by the number of instances and resets on every deploy — the same argument that moved `checkout-idempotency` off its `Mutex`. The increment is one `INSERT … ON CONFLICT`, so parallel guesses cannot both read the same count.
- **Two buckets per attempt.** Per-account (8/15min) is the primary defence — the attacker cannot dodge it, the account IS the target. Per-origin (30) is loose on purpose: shared NAT puts unrelated real sellers behind one address, so a tight per-IP limit locks out the innocent majority. Admin gets 5 — one shared secret, no second factor.
- **The check runs BEFORE the password is verified.** The cost being defended against is bcrypt's; a limiter that verifies first has already paid it.

**Registration counts every attempt including successes** (enumeration + bulk signup are the behaviours limited) and is keyed to the SOURCE, never the submitted address — keying on the address would let anyone lock a competitor out of ever registering by burning it first.

**The bug the review caught, and its class:** an unbounded `email` in the login POST made the bucket exceed Postgres's 2704-byte btree key limit → `INSERT` throws → 500 on the sign-in page from one unauthenticated request. Length caps on anything that becomes a key are load-bearing, and `'a'.repeat(5000)` does NOT reproduce it (pglz compresses it away) — the test needs incompressible input. Same class as the caps in `lib/email-address.ts` and `lib/client-ip.ts`.

**⚠️ Left for launch day:** set `TRUST_PROXY_IP=1` in the server environment **if and only if** the app is reachable only through a proxy/Cloudflare. Both mistakes are silent — trusting it on an exposed origin means anyone forges a fresh bucket per request; not trusting it behind a proxy means every seller counts as one source. `GO_LIVE_CHECKLIST.md` §1 carries the row; `src/lib/client-ip.ts` carries the reasoning.

`tests/rate-limit.test.ts` also greps `src/` so a future credential surface (a password reset, a second admin door) cannot ship unthrottled. Related: [[project_checkout_idempotency_ownership]], [[feedback_fix_security_dont_report]].
