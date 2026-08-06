---
name: project_graceful_shutdown
description: "SIGTERM drain built 2026-08-04 in src/lib/shutdown.ts — installed from middleware because the node adapter owns the server; it drains, it does not close the listener"
metadata: 
  node_type: memory
  type: project
  originSessionId: 73a5f086-bbe6-4701-be65-10547826dce9
  modified: 2026-08-04T17:46:56.978Z
---

**Graceful shutdown exists since 2026-08-04** — `src/lib/shutdown.ts`. `SIGTERM`/`SIGINT` now drains in-flight requests (10s deadline) and closes the pg pool before exiting. Node's default is to terminate immediately, and that is the signal every host sends to replace a running version, so until then a deploy cut whatever was mid-flight — including a `/api/checkout` POST whose card may already have been charged.

**Why it installs from `middleware.ts` and not from a server entry point:** `@astrojs/node` in `standalone` mode builds and owns the HTTP server (`dist/server/entry.mjs`) and exposes it to nothing in `src/`. Verified against the installed 11.0.2 — it wires `server-destroy` but registers no signal listener, so there is no built-in to defer to and no hook to override. The middleware is the only code guaranteed to run in the built server, which is why `ensureSchedulerStarted` already lives there; this follows that pattern rather than inventing a second one.

**Two limits, both deliberate and both written on the file — do not describe this as full protection:**
1. It **drains, it cannot close the listener** (no server object). In practice the load balancer stops routing on the signal, and the deadline guarantees exit if that assumption is wrong.
2. The slot is released when the middleware returns the `Response`, **not when its body finishes streaming**. So a streaming HTML page can still be cut — a blank tab, and the visitor reloads. Every mutation completes its DB work inside the handler before returning, so the expensive case is covered. That asymmetry is the whole justification.

Production-only (`import.meta.env.PROD`) so Ctrl+C on the dev server stays instant. Upgrade path if the adapter ever exposes the server: `server.destroy()` first, and the counter becomes the wait *after* closing the listener instead of in place of it.

Related: [[project_scheduler]] (same ignition point), [[project_auth_rate_limit]] (built the same session).
