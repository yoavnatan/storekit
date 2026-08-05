/**
 * The half of the error surface `middleware.ts` cannot reach.
 *
 * Astro streams SSR HTML, so `await next()` resolves as soon as the page's own frontmatter is done
 * and rendering has begun. Everything thrown after that — every COMPONENT's frontmatter included,
 * and `BaseLayout` reads the database and issues a CSRF token on every page in the site — throws
 * outside the middleware's `try` block. The adapter writes "Internal server error" onto the open
 * socket and destroys it, and nothing is written to the log at all.
 *
 * Reproduced 2026-08-05 by starting the built server with no `AUTH_SECRET`: `issueCsrfToken()`
 * throws inside `BaseLayout`, every page answers "Internal server error" as raw text, and the
 * Alerts tab stays empty.
 */
import { describe, it, expect, vi } from 'vitest';
import { reportStreamErrors } from '../src/lib/stream-errors.js';

const encoder = new TextEncoder();

/** A body that yields `chunks` and then, optionally, fails — Astro's stream under a component that
 *  throws halfway through rendering. */
function bodyThatFails(chunks: string[], failWith?: unknown): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i++;
        return;
      }
      if (failWith !== undefined) controller.error(failWith);
      else controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

describe('reportStreamErrors', () => {
  it('reports a failure that happens after the response has started', async () => {
    const report = vi.fn();
    const boom = new Error('AUTH_SECRET is not set');
    const wrapped = reportStreamErrors(new Response(bodyThatFails(['<html>', '<body>'], boom)), report);

    await expect(drain(wrapped.body!)).rejects.toThrow('AUTH_SECRET is not set');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toBe(boom);
  });

  it('still fails the stream after reporting, so the adapter behaves exactly as before', async () => {
    // The point is observability, not recovery: by the time this fires the status line and headers
    // are long gone, so there is no error page to substitute. Swallowing the error here would turn
    // a visible failure into a silently truncated page, which is strictly worse.
    const wrapped = reportStreamErrors(new Response(bodyThatFails([], new Error('x'))), () => {});
    await expect(drain(wrapped.body!)).rejects.toThrow('x');
  });

  it('passes a healthy response through byte for byte and reports nothing', async () => {
    const report = vi.fn();
    const wrapped = reportStreamErrors(new Response(bodyThatFails(['<html>', 'hello', '</html>'])), report);
    expect(await drain(wrapped.body!)).toBe('<html>hello</html>');
    expect(report).not.toHaveBeenCalled();
  });

  it('keeps the status, statusText and headers of the response it wraps', async () => {
    const original = new Response(bodyThatFails(['x']), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
    });
    const wrapped = reportStreamErrors(original, () => {});
    expect(wrapped.status).toBe(404);
    expect(wrapped.statusText).toBe('Not Found');
    expect(wrapped.headers.get('content-type')).toBe('text/html');
    expect(wrapped.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('returns a bodiless response untouched', () => {
    // `new Response(stream, { status: 204 })` throws — a null-body status may not carry one — so
    // wrapping unconditionally would turn every redirect and 204 in the app into a 500.
    for (const status of [204, 304]) {
      const original = new Response(null, { status });
      expect(reportStreamErrors(original, () => {})).toBe(original);
    }
    const redirect = Response.redirect('https://example.com/x', 302);
    expect(reportStreamErrors(redirect, () => {})).toBe(redirect);
  });

  it('forwards a cancel to the source, so navigating away stops the renderer', async () => {
    let cancelled: unknown = null;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(encoder.encode('chunk')); },
      cancel(reason) { cancelled = reason; },
    });
    const wrapped = reportStreamErrors(new Response(source), () => {});
    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel('client went away');
    expect(cancelled).toBe('client went away');
  });

  it('a reporter that throws does not replace the error the visitor was already getting', async () => {
    const wrapped = reportStreamErrors(
      new Response(bodyThatFails([], new Error('the real failure'))),
      () => { throw new Error('the reporter is broken too'); },
    );
    await expect(drain(wrapped.body!)).rejects.toThrow('the real failure');
  });
});
