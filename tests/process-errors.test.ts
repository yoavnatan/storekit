/**
 * The net under every fire-and-forget promise — and, just as importantly, the proof that it does
 * not change what Node does next.
 *
 * This application deliberately runs work unawaited (`void logError(…)`, `void pingIndexNow(…)`,
 * `warmBannerDerivations(…)`, the scheduler's job runs). Each of those has its own `catch` today,
 * so this covers no known hole — it makes sure the next `void` someone writes cannot fail in total
 * silence, since a rejection with no request behind it is invisible to the middleware, to
 * `stream-errors.ts` and to the browser reporter alike.
 *
 * The handler is invoked directly rather than by producing a real unhandled rejection, because a
 * real one would do exactly what this file asserts it still does: take the process down, test
 * runner included.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ensureProcessErrorHandlersInstalled,
  resetProcessErrorHandlers,
} from '../src/lib/process-errors.js';

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

/** The listeners this module added, isolated from anything vitest itself has registered. */
function installAndCapture(): RejectionListener[] {
  const before = new Set(process.listeners('unhandledRejection'));
  ensureProcessErrorHandlersInstalled();
  return process.listeners('unhandledRejection').filter((l) => !before.has(l)) as RejectionListener[];
}

let added: RejectionListener[] = [];

afterEach(() => {
  for (const listener of added) process.off('unhandledRejection', listener);
  added = [];
  resetProcessErrorHandlers();
  vi.restoreAllMocks();
});

describe('process error handlers', () => {
  it('logs the stack of a rejection nobody was awaiting', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    added = installAndCapture();
    expect(added).toHaveLength(1);

    const boom = new Error('nobody caught me');
    expect(() => added[0]!(boom, Promise.resolve())).toThrow(boom);

    expect(stderr).toHaveBeenCalledWith(
      '[unhandled-rejection] a promise failed with nobody awaiting it:',
      expect.stringContaining('nobody caught me'),
    );
  });

  it('re-throws, so Node still crashes exactly as it would have without a handler', () => {
    // This is the assertion that matters most. Installing ANY listener for `unhandledRejection`
    // suppresses Node's default crash, and a web server that keeps serving after a promise it was
    // maintaining state with has failed is worse than one that restarts. Logging must be the only
    // thing that changed.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    added = installAndCapture();

    const boom = new Error('still fatal');
    expect(() => added[0]!(boom, Promise.resolve())).toThrow('still fatal');
  });

  it('survives a rejection that is not an Error', () => {
    // `Promise.reject('a string')` and `Promise.reject(undefined)` are both legal and both reach
    // here; reading `.stack` off them unguarded would throw inside the handler itself.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    added = installAndCapture();

    expect(() => added[0]!('just a string', Promise.resolve())).toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.any(String), 'just a string');

    stderr.mockClear();
    expect(() => added[0]!(undefined, Promise.resolve())).toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.any(String), 'undefined');
  });

  it('installs once however many requests call it', () => {
    added = installAndCapture();
    const before = process.listeners('unhandledRejection').length;
    for (let i = 0; i < 10; i++) ensureProcessErrorHandlersInstalled();
    expect(process.listeners('unhandledRejection')).toHaveLength(before);
  });

  it('leaves uncaughtException alone', () => {
    // Deliberate: Node already prints that stack, and a handler there would suppress the exit,
    // buying nothing and risking a zombie process.
    const before = process.listeners('uncaughtException').length;
    added = installAndCapture();
    expect(process.listeners('uncaughtException')).toHaveLength(before);
  });
});
