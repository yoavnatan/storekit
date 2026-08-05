/**
 * The last net: a rejected promise that no `catch` anywhere owned.
 *
 * Everything else in this codebase reports an error that happened *inside a request* — the
 * middleware's `try/catch` for a page's frontmatter, `lib/stream-errors.ts` for the half that
 * renders after the headers went out, `/api/log-client-error` for the browser. None of them can see
 * a rejection with no request behind it: the fire-and-forget work this application deliberately
 * runs unawaited (`void logError(…)`, `void pingIndexNow(…)`, `warmBannerDerivations(…)`, the
 * scheduler's job runs). Every one of those has its own `catch` today — this is not covering a
 * known hole, it is making sure the next `void` someone writes cannot fail in total silence.
 *
 * **It does not change what happens next, and that is deliberate.** Node's default for an
 * unhandled rejection is to crash the process, and that default is right: a promise nobody was
 * waiting on has failed, so the state it was maintaining is now unknown, and a web server that
 * keeps serving from unknown state is worse than one that restarts. Installing a handler would
 * normally SUPPRESS that crash — so this one re-throws, which turns the rejection into an uncaught
 * exception and lets Node do exactly what it would have done anyway. The only thing that changed
 * is that a labelled line went to stderr first.
 *
 * `uncaughtException` deliberately gets no handler at all. Node already prints the stack, and any
 * handler there would suppress the exit — buying nothing and risking a zombie process.
 *
 * **stderr, not the database.** The process is about to die; an async insert would lose the race,
 * and pretending otherwise would be worse than not trying. stderr is where the host keeps logs and
 * where an external log drain would read from, which is the same reasoning `error-log.ts` gives for
 * its own dropped entries.
 */

let installed = false;

/**
 * Install once. Called from `middleware.ts` alongside the scheduler and shutdown hooks, for the
 * same reason they are: the node adapter owns the HTTP server and hands `src/` no "server started"
 * hook, so the first served request is the earliest point guaranteed to run exactly once in a
 * process that is actually serving.
 */
export function ensureProcessErrorHandlersInstalled(): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error('[unhandled-rejection] a promise failed with nobody awaiting it:', detail);
    // Restore Node's default. See the module note: suppressing the crash is the one thing this
    // must not do.
    throw reason;
  });
}

/** Test seam: the guard above is module state, and a second test must be able to install again. */
export function resetProcessErrorHandlers(): void {
  installed = false;
}
