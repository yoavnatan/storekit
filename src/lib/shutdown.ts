import { closePool } from './db.js';

/**
 * Graceful shutdown — finish the requests already in flight before the process dies.
 *
 * **What it fixes.** Node's default action for `SIGTERM` is to terminate immediately. Every host
 * that replaces a running version — a deploy, a scale-down, a restart after a crash loop — sends
 * exactly that signal, so until now the old process vanished mid-request. For a page view that is a
 * blank tab; for the POST to `/api/checkout` it is a buyer whose card may have been charged and
 * whose browser got a dropped connection, on a route whose entire idempotency design assumes the
 * client can retry with the same key. `GO_LIVE_CHECKLIST.md` §7 has carried this as a to-do since
 * the deploy-safety section was written.
 *
 * **Why it is installed from the middleware and not from a server entry point.** `@astrojs/node` in
 * `standalone` mode owns the HTTP server: it builds `dist/server/entry.mjs` itself, and nothing in
 * `src/` is handed the server object (checked against the installed adapter, 11.0.2 — it wires
 * `server-destroy` but never listens for a signal, so there is no hook to override and no built-in
 * to defer to). The middleware is the one piece of our code guaranteed to run in the built server,
 * which is why `ensureSchedulerStarted` already installs itself from there; this follows that
 * pattern deliberately rather than inventing a second one.
 *
 * **The consequence of that choice, stated honestly:** without the server object we cannot stop the
 * listener, so this drains rather than closes. In practice the load balancer stops routing to an
 * instance the moment it signals it, so the in-flight count falls to zero and the process exits in
 * milliseconds; the deadline below is what guarantees it exits at all if that assumption is wrong.
 * Upgrade path if the adapter ever exposes the server: call `server.destroy()` first, and this
 * counter becomes the wait AFTER closing the listener rather than instead of it.
 *
 * **What "in flight" actually covers, precisely.** The slot is released when the middleware returns
 * the `Response`, not when its body finishes streaming to the client. So a long streaming HTML
 * response can still be cut at the deadline — which is the cheap failure (a blank tab, and the
 * visitor reloads). The expensive one is covered: `/api/checkout` and every other mutation does all
 * of its database work INSIDE the handler and returns a fully-built response, so the writes are
 * complete before the slot is released. That asymmetry is the reason this is worth having even in
 * its partial form, and the reason it is not described as full protection.
 */

let inFlight = 0;
let installed = false;

/** Milliseconds to wait for in-flight requests before exiting anyway. Well under the 30s most hosts
 *  allow between SIGTERM and SIGKILL — the point is to beat the kill, not to use the whole budget,
 *  and a request still running after ten seconds is not going to be saved by waiting longer. */
const DRAIN_DEADLINE_MS = 10_000;
const POLL_MS = 50;

/**
 * Count one request for the duration of its handling. Returns the function that releases it — call
 * it in a `finally`, or a thrown request leaks a slot and every future shutdown waits out the full
 * deadline.
 */
export function trackRequest(): () => void {
  inFlight++;
  let released = false;
  return () => {
    // Guarded because a double release would drive the counter negative, and a negative counter
    // reads as "nothing in flight" forever after.
    if (released) return;
    released = true;
    inFlight--;
  };
}

/** Test seam only. */
export function inFlightCount(): number {
  return inFlight;
}

async function drain(deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (inFlight > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Wait for in-flight work, release the connection pool, and report whether the drain finished
 * cleanly. Exported so a test can exercise it without terminating the test runner — the signal
 * handler is the only thing that turns this into an exit.
 */
export async function shutdown(deadlineMs: number = DRAIN_DEADLINE_MS): Promise<boolean> {
  await drain(deadlineMs);
  const clean = inFlight === 0;
  // Closing the pool lets Postgres reclaim the connections now instead of waiting for them to time
  // out — it matters on a pooled provider where the slots are a shared, counted resource.
  try { await closePool(); } catch { /* nothing left to do about it at this point */ }
  return clean;
}

/**
 * Install the signal handlers once. Idempotent, and called on every request for the same reason the
 * scheduler is: it is the only place in our code that is guaranteed to run inside the built server.
 *
 * **Production only.** `SIGINT` is Ctrl+C on the dev server, where an added delay is pure friction
 * and nothing needs draining. `import.meta.env.PROD` is a legitimate build-time value (unlike a
 * server secret — see `lib/runtime-env.ts`): dev and production genuinely are different builds.
 */
export function ensureShutdownHookInstalled(): void {
  if (installed || !import.meta.env.PROD) return;
  installed = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown().then((clean) => {
        if (!clean) console.warn(`[shutdown] ${inFlight} request(s) still in flight at the deadline`);
        // 0, not 1: a deploy replacing this process is a normal exit, and a non-zero code makes a
        // host's restart policy treat every routine deploy as a crash.
        process.exit(0);
      });
    });
  }
}
