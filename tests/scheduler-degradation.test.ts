/**
 * The scheduler under failure: a job that throws, a job that HANGS, and a claim table that is down.
 *
 * `jobs-scheduler.test.ts` covers the schedule working. The property this file pins is narrower and
 * is the one a background trigger actually has to guarantee — **nothing a job does may reach a
 * request, and nothing a job does may make the schedule quietly stop.**
 *
 * The second half is the interesting one, because a hang is not a throw. A throw is caught, logged
 * and released. A promise that never settles used to keep the job's name in the in-flight set for
 * the life of the process (so it never ran again here) while `finishJob` was never called (so its
 * row kept whatever the PREVIOUS run left, very possibly `'ok'`). A job stopped weeks ago and a
 * table saying it is fine is the exact silent failure the merchant-status and custom-domain jobs
 * were written to prevent — happening to the thing that runs them. Nothing blocked, nothing logged,
 * nothing to see: which is why it needs a test rather than an operator.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/lib/jobs/registry.js';

const claimJob = vi.fn();
const finishJob = vi.fn();
const logError = vi.fn();

vi.mock('../src/lib/jobs/job-runs.js', () => ({
  claimJob: (...a: unknown[]) => claimJob(...a),
  finishJob: (...a: unknown[]) => finishJob(...a),
}));
vi.mock('../src/lib/error-log.js', () => ({
  logError: (...a: unknown[]) => logError(...a),
}));

const { runJobIfDue, ensureSchedulerStarted, stopScheduler } = await import('../src/lib/jobs/scheduler.js');

/**
 * `leaseSec` in the hundredths, so the deadline it drives is a REAL one and the suite still runs in
 * milliseconds — the production leases are 5–30 minutes and only the units differ.
 *
 * Each job gets a fresh name unless one is given: the in-flight set is keyed by name and is
 * module-level, so a shared name would let one test's abandoned job silently skip the next.
 */
let nextName = 0;
const job = (over: Partial<Job> = {}): Job => ({
  name: `test-job-${++nextName}`,
  intervalSec: 60,
  leaseSec: 0.05,
  run: () => Promise.resolve('done'),
  ...over,
});

beforeEach(() => {
  claimJob.mockReset().mockResolvedValue(true);
  finishJob.mockReset().mockResolvedValue(undefined);
  logError.mockReset().mockReturnValue(Promise.resolve());
});

describe('a job that hangs', () => {
  it('is abandoned at its lease instead of running until the process restarts', async () => {
    const hanging = job({ run: () => new Promise<string>(() => { /* never settles */ }) });
    const detail = await runJobIfDue(hanging);
    expect(detail).toMatch(/abandoned/);
  });

  it('records the run as FAILED — the row must never keep saying "ok" about a job that stopped', async () => {
    // The whole defect. `finishJob` never being called left `last_status` at whatever the previous
    // successful run wrote, so the one place anybody would look reported health.
    const hanging = job({ run: () => new Promise<string>(() => undefined) });
    await runJobIfDue(hanging);
    expect(finishJob).toHaveBeenCalledTimes(1);
    expect(finishJob.mock.calls[0]![1]).toBe(false);
  });

  it('makes it visible in the Alerts tab', async () => {
    const hanging = job({ run: () => new Promise<string>(() => undefined) });
    await runJobIfDue(hanging);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String((logError.mock.calls[0]![0] as { message: string }).message)).toMatch(/abandoned/);
  });

  it('lets the SAME job run again next tick, rather than wedging its name forever', async () => {
    // The in-flight set is per name and is what makes a slow job delay only itself. A job that never
    // settles used to sit in it permanently — a silent, one-way stop.
    const hanging = job({ run: () => new Promise<string>(() => undefined) });
    await runJobIfDue(hanging);
    const second = await runJobIfDue({ ...hanging, run: () => Promise.resolve('recovered') });
    expect(second).toBe('recovered');
  });

  it('does not let a zombie that eventually rejects surface as an unhandled rejection', async () => {
    // The abandoned promise keeps running; we cannot kill it. Its later rejection must already have
    // a handler, or it lands in `process-errors.ts` minutes after the run was written off, pointing
    // at nothing.
    let boom!: (err: Error) => void;
    const late = job({ run: () => new Promise<string>((_, reject) => { boom = reject; }) });
    await runJobIfDue(late);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    boom(new Error('the zombie finally gave up'));
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('a job that throws', () => {
  it('still releases its lease, so its next run is on schedule rather than on lease expiry', async () => {
    await runJobIfDue(job({ run: () => Promise.reject(new Error('seller feed unreachable')) }));
    expect(finishJob).toHaveBeenCalledTimes(1);
    expect(finishJob.mock.calls[0]![1]).toBe(false);
    expect(String(finishJob.mock.calls[0]![2])).toContain('seller feed unreachable');
  });

  it('is not confused with an abandoned one — the two need different reading', async () => {
    await runJobIfDue(job({ run: () => Promise.reject(new Error('boom')) }));
    expect(String(finishJob.mock.calls[0]![2])).not.toMatch(/abandoned/);
  });
});

describe('the bookkeeping itself failing', () => {
  it('does not turn a successful run into a failed one', async () => {
    // The work is done; only the record is lost. The lease expires on its own clock, so the schedule
    // recovers by itself — and throwing here would report a job that worked as broken.
    finishJob.mockRejectedValue(new Error('claim table unreachable'));
    await expect(runJobIfDue(job({ run: () => Promise.resolve('all good') }))).resolves.toBe('all good');
  });
});

describe('ignition from the request path', () => {
  it('a scheduler that cannot start is never the reason a visitor gets a 500', async () => {
    // `ensureSchedulerStarted()` is called by the middleware on every request and the middleware
    // re-throws what it catches. It must swallow, and it must SETTLE — a retry on every subsequent
    // request would put the failure back in front of every visitor.
    claimJob.mockRejectedValue(new Error('database down'));
    expect(() => ensureSchedulerStarted()).not.toThrow();
    expect(() => ensureSchedulerStarted()).not.toThrow();
    stopScheduler();
  });
});
