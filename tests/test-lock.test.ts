import { describe, expect, it, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withTestLock } from '../scripts/lib/test-lock.mjs';

/**
 * **The lock that lets several sessions run at once without turning each other's tests red.**
 *
 * The failure it exists for, measured 2026-08-17 with six sessions live: six DIFFERENT
 * database-backed test files timed out at ~32s against the 30s per-test ceiling, a different random
 * subset every run, every one passing in ~2s alone. Nothing failed an assertion — `vitest` sizes its
 * worker pool from the CPU count, so six suites asked for six machines, and a wall-clock deadline
 * under a fraction of a core is a red that says nothing about the code.
 *
 * Two properties have to hold, and the second is the one that matters at 2am: it must exclude, and
 * it must never be able to wedge the machine. A lock a crashed session can hold forever is worse
 * than the contention it was added to fix.
 */

/**
 * **A private lock path, and it is not tidiness — on the real one this file deadlocks.** `verify`
 * takes the machine-wide lock for the whole test run, so a test calling `withTestLock` on that path
 * waits for the suite it is itself running inside, and dies at the 30s ceiling. Found exactly that
 * way. The module reads the env var per call, so setting it here is enough.
 */
const LOCK_DIR = path.join(os.tmpdir(), `storekit-lock-test-${process.pid}.lock`);
const OWNER = path.join(LOCK_DIR, 'owner.json');

beforeAll(() => { process.env.STOREKIT_TEST_LOCK_DIR = LOCK_DIR; });

afterEach(() => {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
});

describe('it excludes', () => {
  it('a second caller waits until the first releases, and does not run alongside it', async () => {
    const order: string[] = [];
    const releaseFirst = await withTestLock();

    let waited = false;
    const second = withTestLock(() => { waited = true; }).then((release) => {
      order.push('second-acquired');
      release();
    });

    // Give the waiter real time to acquire if the lock were not holding it.
    await new Promise((r) => setTimeout(r, 250));
    order.push('first-still-holding');
    releaseFirst();
    await second;

    expect(order).toEqual(['first-still-holding', 'second-acquired']);
    // …and it announced the wait rather than appearing to hang.
    expect(waited).toBe(true);
  });

  it('says nothing when the lock is free — the single-session case stays silent', async () => {
    let announced = false;
    const release = await withTestLock(() => { announced = true; });
    release();
    expect(announced).toBe(false);
  });

  it('releasing twice cannot delete a lock somebody else now holds', async () => {
    const release = await withTestLock();
    release();
    const otherRelease = await withTestLock();          // a different session takes it
    const ownerNow = fs.readFileSync(OWNER, 'utf8');
    release();                                          // the stale handle fires again
    expect(fs.existsSync(LOCK_DIR)).toBe(true);
    expect(fs.readFileSync(OWNER, 'utf8')).toBe(ownerNow);
    otherRelease();
  });
});

describe('it cannot wedge the machine', () => {
  it('steals a lock whose holder is dead', async () => {
    // A crashed session, a killed terminal, a closed laptop: the directory outlives the process.
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(OWNER, JSON.stringify({ pid: 2 ** 30, at: Date.now() }));

    const release = await Promise.race([
      withTestLock(),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('did not steal')), 3000)),
    ]) as () => void;

    expect(typeof release).toBe('function');
    expect(JSON.parse(fs.readFileSync(OWNER, 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('steals a lock a live holder has held past the stale window', async () => {
    // Our own pid, so `kill(pid, 0)` says alive — only the age can free this one. Anything else and
    // a suite that genuinely runs long would be stolen from mid-run.
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(OWNER, JSON.stringify({ pid: process.pid, at: Date.now() - 20 * 60 * 1000 }));

    const release = await Promise.race([
      withTestLock(),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('did not steal')), 3000)),
    ]) as () => void;

    expect(JSON.parse(fs.readFileSync(OWNER, 'utf8')).at).toBeGreaterThan(Date.now() - 10_000);
    release();
  });

  it('does NOT steal from a live holder inside the window', async () => {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(OWNER, JSON.stringify({ pid: process.pid, at: Date.now() }));

    const stolen = await Promise.race([
      withTestLock().then(() => true),
      new Promise((r) => setTimeout(() => r(false), 800)),
    ]);
    expect(stolen).toBe(false);
  });

  it('recovers from a lock directory with no owner file once it is old enough', async () => {
    // Half-written (killed between mkdir and write) or hand-deleted. It must not be trusted forever,
    // and must not be stolen instantly either — that would race a holder mid-acquire.
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(LOCK_DIR, old, old);

    const release = await Promise.race([
      withTestLock(),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('did not recover')), 3000)),
    ]) as () => void;
    expect(typeof release).toBe('function');
    release();
  });
});
