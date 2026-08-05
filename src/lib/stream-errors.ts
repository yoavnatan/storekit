/**
 * Catch the errors that happen AFTER the response has started, which is the whole class
 * `middleware.ts`'s `try/catch` structurally cannot see.
 *
 * **Why there is a hole at all.** Astro streams SSR HTML. `await next()` resolves as soon as the
 * page's own frontmatter is done and rendering has BEGUN — the returned `Response` carries a
 * `ReadableStream` that is still being produced. So the middleware's `catch` covers exactly one
 * half of a page: the frontmatter. Anything thrown while the template renders — and that includes
 * every COMPONENT's frontmatter, `BaseLayout` among them, which reads the database and issues a
 * CSRF token on every page in the site — throws long after the `try` block has been left. The
 * adapter (`@astrojs/node`) is what finally catches it: it writes the string "Internal server
 * error" onto the open socket and destroys it. Our `logError` never runs, so the Alerts tab shows
 * nothing at all and the error exists only in the process's stderr.
 *
 * Reproduced 2026-08-05 by starting the built server without `AUTH_SECRET`: `issueCsrfToken()`
 * throws inside `BaseLayout`, every page answers "Internal server error" as raw text, and the log
 * stays empty. Under a database outage the same shape appears — the page frontmatter throws first
 * and IS caught, but any page whose data all comes from components would not be.
 *
 * **What this does.** Sits between Astro's stream and the adapter's reader, forwards every chunk
 * untouched, and reports the read rejection before re-raising it. It is deliberately a pass-through
 * and not a recovery: by the time it fires the status line and headers are long gone, so there is
 * no 500 page to substitute and nothing to do but tell the truth to the socket. The value is
 * entirely that the failure stops being invisible.
 */

/** Called with whatever the stream rejected with. Must not throw and must not be awaited — this
 *  runs on a response that is already failing, and it may not make that worse. */
export type StreamErrorReporter = (error: unknown) => void;

/**
 * `response`, with its body wrapped so a mid-stream failure is reported. Returned unchanged when
 * there is no body to wrap (a redirect, a 204, a HEAD) — `new Response(body, { status: 204 })`
 * would itself throw, and an absent body cannot fail halfway.
 */
export function reportStreamErrors(response: Response, report: StreamErrorReporter): Response {
  const source = response.body;
  if (!source) return response;

  const reader = source.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        // Report first, then fail the stream exactly as it would have failed without us: the
        // adapter's own handler still writes "Internal server error" and destroys the socket, so
        // the visitor's experience is unchanged and only the observability is new.
        try { report(error); } catch { /* a reporter that throws must not replace the real error */ }
        controller.error(error);
      }
    },
    // A visitor who navigates away mid-response cancels this stream, and without forwarding it the
    // renderer upstream would keep producing HTML for a socket nobody is reading.
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
