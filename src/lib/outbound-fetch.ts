/**
 * The one way this application calls a server that is not itself.
 *
 * **Why it exists: `fetch` has no useful timeout, and the failure it lets through is the worst
 * kind.** Node's `fetch` (undici) gives up on *headers* after 300 seconds and on a *body* after
 * another 300 — that is the ceiling, not a budget. A third-party that has not crashed but has
 * stopped answering (the common outage: an overloaded provider holding the socket open) therefore
 * parks the calling request for up to five minutes. Nothing in this codebase would notice: the
 * call sites are `await`ed inside SSR routes and inside `notifyOrderStatusChanged`, so a hung
 * Resend or a hung Cloudflare becomes a hung page for the buyer or the seller. That is exactly the
 * "third-party failure freezes the UI" case, and no amount of `try/catch` at the call site helps,
 * because the call never returns to be caught.
 *
 * So: every outbound call gets a deadline, and the deadline is enforced here rather than trusted to
 * each call site — `tests/outbound-fetch-guard.test.ts` fails the build on a bare `fetch()` to an
 * absolute URL in server code, the same way `lib/request-body.ts` and `lib/cdn.ts` are enforced.
 *
 * **It is not server-only, and the guard test cannot see the browser case.** This module imports
 * nothing, so it runs in a bundle as happily as in Node — and the deadline matters there too, just
 * for a different reason. `tests/outbound-fetch-guard.test.ts` flags a bare `fetch()` handed a
 * literal or a known endpoint constant, which is how every SERVER call site is written; a browser
 * call site is usually `fetch(url)` where `url` came out of an input's value, and that shape is
 * indistinguishable from the same-origin `fetch(url)` calls the rule deliberately allows. So it is
 * a rule rather than a check: **a browser fetch of a third-party URL takes a deadline too.** Both
 * current cases are the dashboard re-fetching a stored image from Cloudinary behind a loading state
 * (`scripts/dashboard/store-image.ts`, `scripts/dashboard/gallery.ts`), where a CDN that accepted
 * the connection and then went quiet left a seller's button spinning with no error and no way out
 * but a reload. They pass 30s, not the default: those download a full-resolution ORIGINAL, whose
 * honest duration is a real megabyte count over a real phone connection. The one browser exemption
 * stays the upload POST in `scripts/dashboard/cloudinary.ts`, and the guard test's header argues it.
 *
 * **What it deliberately does not do.** No retries — a retry policy belongs to the caller, who is
 * the only one who knows whether the request is idempotent (re-POSTing an email send is a second
 * email). No error swallowing: a timeout raises, so a caller that wants "best effort" writes the
 * `catch` and says so, and a caller that does not gets a real failure it can log.
 *
 * **The self-healing plan, when retries do arrive** (relocated here from AI_INSTRUCTIONS.md
 * 2026-08-05 — this is the module a retry policy would be built into, so this is where the thinking
 * belongs; noted 2026-07-15, still unbuilt).
 *
 * The shape: auto-retry with backoff for genuinely transient, idempotent failures, and
 * auto-resolve the log entries they produce, so the admin Alerts tab surfaces only what needs a
 * human. That is the same zero-touch principle the rest of the platform is built on.
 *
 * The old reason to wait was JSON write collisions, and a real database made that moot. The
 * trigger now is having a real external call worth retrying against — the split-payment webhook,
 * Cloudinary, the email provider, ShipOS — plus deadlock and dropped-connection retry on Postgres
 * itself, which is a different mechanism and belongs in `db.ts` beside `connectWithWakeRetry`.
 *
 * **The trap, and it is the reason this is written down rather than left to judgement: never retry
 * a non-idempotent operation blindly.** A checkout retried because the response was slow is a
 * second charge and a second stock decrement. "The request appeared to fail" and "the request did
 * not happen" are not the same claim, and only the caller can tell them apart — which is why the
 * policy cannot live in this function no matter how convenient that would be.
 */

/**
 * Ten seconds, and the number is a judgement about the caller, not about the network.
 *
 * Every current call site sits on a request a human is waiting on — an OAuth callback mid-login, a
 * custom-domain save in the dashboard, an order email inside a status change. Ten seconds is
 * already past the point where that person believes the page is broken, so a longer default would
 * only be choosing a slower failure over a faster one. A caller that is genuinely off the critical
 * path (a background job) can raise it explicitly, which also makes the exception visible.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface OutboundFetchOptions extends RequestInit {
  /** Overrides the 10s default. Pass a bigger number only for a call nobody is waiting on. */
  timeoutMs?: number;
}

/**
 * `fetch` with a deadline. Rejects with a `TimeoutError` (`err.name`) when the deadline passes —
 * distinguishable from a network error, so a caller can report "the provider did not answer"
 * rather than "the provider refused".
 *
 * An `init.signal` supplied by the caller still works: both are honoured, whichever fires first.
 */
export function outboundFetch(input: string | URL | Request, options: OutboundFetchOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...init } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
}
