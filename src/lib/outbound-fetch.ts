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
 * **What it deliberately does not do.** No retries — a retry policy belongs to the caller, who is
 * the only one who knows whether the request is idempotent (re-POSTing an email send is a second
 * email). No error swallowing: a timeout raises, so a caller that wants "best effort" writes the
 * `catch` and says so, and a caller that does not gets a real failure it can log.
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
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface OutboundFetchOptions extends RequestInit {
  /** Overrides `DEFAULT_TIMEOUT_MS`. Pass a bigger number only for a call nobody is waiting on. */
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

/** True when a rejection from `outboundFetch` is the deadline rather than the network or the peer.
 *  Exported so a call site can log the two differently without string-matching a message. */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}
