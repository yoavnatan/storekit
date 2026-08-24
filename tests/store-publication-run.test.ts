/**
 * The half-hourly sweep that ends a seller's wait.
 *
 * It exists because the callback that is SUPPOSED to end that wait has never once been received:
 * PayMe post it to a public URL and this platform has no host yet (`docs/payme-sandbox-notes.md`).
 * So for the first real seller the timer is not a safety net, it is the mechanism — and the failure
 * it has to survive is silent by construction. A shop that stays dark because one lookup threw is
 * indistinguishable, from the seller's chair, from a shop still under review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rig = vi.hoisted(() => ({
  creds: { clientKey: 'k', baseUrl: 'https://sandbox.payme.io/api/' } as unknown,
  waiting: [] as string[],
  refreshed: [] as string[],
  synced: [] as string[],
  /** seller id → what `syncStorePublication` does for him: the slugs published, or a throw. */
  publishes: {} as Record<string, string[] | Error>,
  refreshThrows: new Set<string>(),
}));

vi.mock('../src/lib/payment-payme.js', () => ({ activePaymeCredentials: () => rig.creds }));
vi.mock('../src/lib/seller-subscription.js', () => ({
  refreshSubscription: async (sellerId: string) => {
    rig.refreshed.push(sellerId);
    if (rig.refreshThrows.has(sellerId)) throw new Error('payme down');
    return null;
  },
}));
vi.mock('../src/lib/store-publication.js', () => ({
  sellersAwaitingPublication: async () => rig.waiting,
  syncStorePublication: async (sellerId: string) => {
    rig.synced.push(sellerId);
    const out = rig.publishes[sellerId] ?? [];
    if (out instanceof Error) throw out;
    return out;
  },
}));

const { runStorePublicationSweep } = await import('../src/lib/store-publication-run.js');

beforeEach(() => {
  rig.creds = { clientKey: 'k', baseUrl: 'https://sandbox.payme.io/api/' };
  rig.waiting = [];
  rig.refreshed = [];
  rig.synced = [];
  rig.publishes = {};
  rig.refreshThrows = new Set();
});

describe('runStorePublicationSweep', () => {
  // Not an error and not silence. With no gateway `publishHoldsFor` answers "nothing is blocked",
  // so a sweep that ran anyway would publish every waiting shop on a developer's machine — the one
  // outcome this job must never produce by accident.
  it('does nothing at all when PayMe are not configured', async () => {
    rig.creds = null;
    rig.waiting = ['seller-1'];
    expect(await runStorePublicationSweep()).toContain('not configured');
    expect(rig.refreshed).toEqual([]);
    expect(rig.synced).toEqual([]);
  });

  it('costs one query when nobody is waiting', async () => {
    expect(await runStorePublicationSweep()).toBe('no store waiting to be published');
    expect(rig.refreshed).toEqual([]);
  });

  // The subscription is re-read from PayMe FIRST, because it is the hold that moves without anyone
  // telling us — a card that expires between iterations changes `sub_status` and no callback of ours
  // fires. Reading the approval flag alone would publish a shop whose seller has stopped paying.
  it('re-reads the subscription before deciding, for every seller', async () => {
    rig.waiting = ['a', 'b'];
    rig.publishes = { a: ['shop-a'], b: [] };
    const line = await runStorePublicationSweep();
    expect(rig.refreshed).toEqual(['a', 'b']);
    expect(rig.synced).toEqual(['a', 'b']);
    expect(line).toContain('2 seller(s) waiting');
    expect(line).toContain('1 store(s) published');
  });

  // The whole platform's go-live path runs in this one loop. One seller whose PayMe lookup times out
  // must not hold back everyone behind him in the list — that is a single failure becoming an
  // outage, and nothing downstream would report it as one.
  it('carries on past a seller whose lookup fails, and counts him', async () => {
    rig.waiting = ['a', 'bad', 'c'];
    rig.refreshThrows.add('bad');
    rig.publishes = { a: ['shop-a'], c: ['shop-c', 'shop-c2'] };
    const line = await runStorePublicationSweep();
    expect(rig.synced).toEqual(['a', 'c']);
    expect(line).toContain('3 store(s) published');
    // Named on the row rather than swallowed: a systematic outage looks like a rising number here,
    // and looks like nothing at all if the count is dropped.
    expect(line).toContain('1 failed');
  });

  it('survives a publish that throws, not only a lookup that does', async () => {
    rig.waiting = ['a', 'b'];
    rig.publishes = { a: new Error('db'), b: ['shop-b'] };
    const line = await runStorePublicationSweep();
    expect(line).toContain('1 store(s) published');
    expect(line).toContain('1 failed');
  });

  // Publication is DERIVED from the holds and `published_at` is written once, so the second pass
  // finds the same shops already live. The scheduler's lease makes a double-run unlikely rather than
  // impossible, and `jobs/registry.ts` requires every job to mean the same thing twice.
  it('says nothing new on a second pass over the same sellers', async () => {
    rig.waiting = ['a'];
    rig.publishes = { a: ['shop-a'] };
    expect(await runStorePublicationSweep()).toContain('1 store(s) published');
    rig.publishes = { a: [] };   // already live — `syncStorePublication` publishes nothing twice
    expect(await runStorePublicationSweep()).toContain('0 store(s) published');
  });

  // It runs inside the scheduler's catch, but a throw there aborts the run's own bookkeeping. The
  // contract is a STRING, always.
  it('never throws', async () => {
    rig.waiting = ['a'];
    rig.refreshThrows.add('a');
    await expect(runStorePublicationSweep()).resolves.toContain('1 failed');
  });
});
