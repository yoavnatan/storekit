import { describe, expect, it, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withWorkerShare, workerBudget } from '../scripts/lib/test-concurrency.mjs';

/**
 * **The budget that lets several sessions run their suites at the same time without starving each
 * other.**
 *
 * What it replaced, and why the replacement needs guarding. Until 2026-08-20 the same problem was
 * solved with a machine-wide lock: one suite at a time, everybody else queued. It did prevent the
 * failure it was built for — six uncapped suites once put a different random subset of
 * database-backed files past the 30s ceiling every run — but it made a session's wall clock the sum
 * of every other session's suite. A measured `verify --all` took 8m40s with a 3m39s critical path
 * and 123% CPU on twelve cores: five minutes of queueing with ten cores idle.
 *
 * So the property under test changed shape. The old file asserted *exclusion*. This one asserts the
 * thing exclusion was only ever a crude way to get: **the shares handed out at any moment sum to no
 * more than the machine can serve**, while every caller keeps running.
 *
 * Two properties, and the second is the one that matters at 2am. It must divide, and a crashed or
 * killed run must not shrink everybody's share forever — a budget that leaks is worse than the
 * contention it replaced, because it degrades silently instead of failing.
 */

/**
 * **A private claims directory, and it is not tidiness — on the real one this file measures
 * itself.** `verify` holds a claim for the whole suite these tests run inside, so a test reading the
 * real path counts that claim and asserts against a number it caused. The module reads the env var
 * per call, so setting it here is enough.
 */
const CLAIMS = path.join(os.tmpdir(), `storekit-claims-test-${process.pid}`);

/**
 * What ONE run gets on an otherwise-idle machine — the per-run ceiling, or the whole budget when the
 * machine is too small to reach it. Derived rather than written as `4`, because the budget is
 * `cores - 2`: on the 12-core machine this was developed on every one of these assertions is 4, and
 * on a 4-core CI box it is 2. A test that hard-codes the developer's machine fails somewhere else
 * for a reason that has nothing to do with the behaviour it is checking.
 */
const CEILING = Math.min(4, workerBudget());

beforeAll(() => { process.env.STOREKIT_TEST_CLAIMS_DIR = CLAIMS; });

afterEach(() => { fs.rmSync(CLAIMS, { recursive: true, force: true }); });

/** A claim belonging to some other live process, at a chosen age. `process.pid` is the only PID a
 *  test can be sure is alive; the file name is what identifies it, so any name will do. */
const plant = (name: string, ageMs = 0) => {
  fs.mkdirSync(CLAIMS, { recursive: true });
  fs.writeFileSync(
    path.join(CLAIMS, `${name}.json`),
    JSON.stringify({ pid: process.pid, at: Date.now() - ageMs }),
  );
};

describe('it divides instead of queueing', () => {
  it('never waits — a second run gets its share immediately, while the first still holds one', async () => {
    const first = await withWorkerShare();

    // The whole point of the change. If this ever starts waiting, the wall-clock regression that
    // cost five minutes of an eight-minute verify is back, and nothing else in the suite would say
    // so — the answers would all still be right.
    const second = await Promise.race([
      withWorkerShare(),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('it queued')), 1000)),
    ]) as Awaited<ReturnType<typeof withWorkerShare>>;

    expect(second.workers).toBeGreaterThanOrEqual(1);
    second.release();
    first.release();
  });

  it('a lone run takes the single-run ceiling, not the whole budget', async () => {
    // Four was measured faster than twelve on this machine (vitest.config.ts): more workers than
    // that spend their time context-switching. So an idle machine does not mean "take everything".
    const only = await withWorkerShare();
    expect(only.workers).toBe(CEILING);
    expect(only.workers).toBeLessThanOrEqual(workerBudget());
    only.release();
  });

  it('shares shrink as runs are added, and the total stays inside the budget', async () => {
    const granted: number[] = [];
    const held: Array<() => void> = [];
    for (let i = 0; i < 6; i++) {
      plant(`other-${i}`);
      const share = await withWorkerShare();
      granted.push(share.workers);
      held.push(share.release);
    }
    // Monotonic: adding a run never gives the next one MORE.
    for (let i = 1; i < granted.length; i++) expect(granted[i]).toBeLessThanOrEqual(granted[i - 1]);
    // And the last one, with six other claims live, is down at the floor rather than still asking
    // for a whole machine — which is the failure the old lock existed to prevent.
    expect(granted.at(-1)).toBeLessThan(CEILING);
    expect(granted.at(-1)).toBeGreaterThanOrEqual(1);
    held.forEach((release) => release());
  });

  it('never grants zero workers, however many runs are live', async () => {
    // `floor(budget / runs)` reaches 0 as soon as the runs outnumber the cores, and a vitest told to
    // use 0 workers does not run the suite — it would report green having tested nothing, which is
    // the one outcome worse than being slow.
    for (let i = 0; i < 40; i++) plant(`crowd-${i}`);
    const share = await withWorkerShare();
    expect(share.workers).toBeGreaterThanOrEqual(1);
    share.release();
  });

  it('says what it granted only when the machine is actually shared', async () => {
    let toldAlone: number | null = null;
    const alone = await withWorkerShare((_w: number, runs: number) => { toldAlone = runs; });
    alone.release();
    expect(toldAlone).toBe(1);            // the caller decides to stay quiet at 1; the module reports honestly

    plant('somebody-else');
    let toldShared: number | null = null;
    const shared = await withWorkerShare((_w: number, runs: number) => { toldShared = runs; });
    shared.release();
    expect(toldShared).toBe(2);
  });
});

describe('it cannot leak the machine away', () => {
  it('releasing frees the claim, so the next run sees the machine as it really is', async () => {
    const first = await withWorkerShare();
    first.release();
    const second = await withWorkerShare();
    expect(second.workers).toBe(CEILING);       // not 2 — the released claim is gone, not merely ignored
    second.release();
  });

  it('ignores and sweeps a claim whose process is dead', async () => {
    // A crashed session, a killed terminal, a closed laptop: the file outlives the run.
    fs.mkdirSync(CLAIMS, { recursive: true });
    fs.writeFileSync(path.join(CLAIMS, 'ghost.json'), JSON.stringify({ pid: 2 ** 30, at: Date.now() }));

    const share = await withWorkerShare();
    expect(share.workers).toBe(CEILING);  // the ghost took nothing
    expect(fs.existsSync(path.join(CLAIMS, 'ghost.json'))).toBe(false);
    share.release();
  });

  it('ignores a claim a live process has held past the stale window', async () => {
    // Our own pid, so it is genuinely alive — only the age can free this one. Anything shorter and a
    // suite that honestly runs long would have its share taken mid-run.
    plant('stuck', 20 * 60 * 1000);
    const share = await withWorkerShare();
    expect(share.workers).toBe(CEILING);
    expect(fs.existsSync(path.join(CLAIMS, 'stuck.json'))).toBe(false);
    share.release();
  });

  it('does NOT sweep a live claim inside the window', async () => {
    // The mirror of the test above, and the one that matters more: sweeping early hands the same
    // cores to two runs at once, which is the over-subscription this whole file exists to bound.
    // Asserted on the claim rather than on the number, because at two runs on a large machine the
    // share is still the ceiling — `floor(10 / 2)` is 5, clamped to 4 — so the count alone cannot
    // tell "counted it" from "swept it".
    plant('working', 30_000);
    const share = await withWorkerShare();
    expect(fs.existsSync(path.join(CLAIMS, 'working.json'))).toBe(true);
    share.release();

    // And once there are enough of them to matter, the number moves too.
    for (let i = 0; i < 5; i++) plant(`working-${i}`, 30_000);
    const crowded = await withWorkerShare();
    expect(crowded.workers).toBeLessThan(CEILING);
    crowded.release();
  });

  it('releasing twice cannot delete a claim a recycled pid has since written', async () => {
    const first = await withWorkerShare();
    first.release();
    const second = await withWorkerShare();   // same pid, so the same file name
    first.release();                          // the stale handle fires again
    expect(fs.readdirSync(CLAIMS)).toHaveLength(1);
    second.release();
  });

  it('runs at the single-run ceiling rather than refusing when the claims directory is unusable', async () => {
    // The budget is an optimisation. A machine that cannot write the claims directory must still be
    // able to run its tests — degrading to "no coordination" is correct here, refusing is not.
    fs.mkdirSync(path.dirname(CLAIMS), { recursive: true });
    fs.writeFileSync(CLAIMS, 'not a directory');
    const share = await withWorkerShare();
    expect(share.workers).toBe(4);
    share.release();
    fs.rmSync(CLAIMS, { force: true });
  });
});
