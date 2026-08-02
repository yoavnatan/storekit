/**
 * Seller boost campaigns against a real Postgres — the first of the three money modules in "the
 * rest" (DB_MIGRATION_PLAN.md §8).
 *
 * **Written from scratch, and the measurement says why.** Before this file, stubbing
 * `ad-campaigns.ts`'s file I/O to return nothing left **1784 of 1785 tests green**: the only
 * existing test file for this module (`ad-campaigns.test.ts`) covers the two pure request coercers
 * and nothing else, `ad-campaign-health.test.ts` replaces the whole module with `vi.doMock`, and
 * `store-lifecycle.test.ts` stubs `node:fs`. A swap that returned an empty list for every store
 * would have been reported as a clean migration. That is the sixth module in a row measured this
 * way and the sixth time the answer was "everything stays green" — so what is pinned here is
 * behaviour, not the fact that the module still imports.
 *
 * The other half of the file is the four things the move was supposed to gain: a budget that is an
 * integer number of agorot rather than a floating shekel (§7.7), a history guard that is a
 * predicate the database evaluates rather than a read-then-write, an ownership check on every
 * by-id mutation (`project_checkout_idempotency_ownership` — an id is not a permission), and a
 * CHECK constraint that turns a value the JSON file stored in silence into a rejected write.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { getDatabase, query, setDatabase, type Database, type Queryable } from '../src/lib/db.js';
import {
  archiveCampaign,
  archiveCampaigns,
  archiveCampaignsForStore,
  createCampaign,
  getAllCampaigns,
  getArchivedByStoreId,
  getCampaignsByStoreId,
  updateCampaign,
  updateCampaigns,
  type CreateCampaignInput,
} from '../src/lib/ad-campaigns.js';

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const SEEDED = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; // 300 ₪ in the fixture → 30,000 agorot

/** A store of this test's own, so archiving sweeps in one test cannot disturb another. */
let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `boost-test-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

function input(storeId: string, extra: Partial<CreateCampaignInput> = {}): CreateCampaignInput {
  return {
    storeId, storeSlug: 'boost-test', scope: 'store', platform: 'both',
    monthlyBudgetAgorot: 50_000, ...extra,
  };
}

describe('reading what the import wrote', () => {
  it('gives a store its own live campaigns, and nobody else\'s', async () => {
    const campaigns = await getCampaignsByStoreId(KERAMIKA);
    expect(campaigns.map((c) => c.id)).toEqual([SEEDED]);
  });

  it('converts the imported ILS budget to integer agorot', async () => {
    const [campaign] = await getCampaignsByStoreId(KERAMIKA);
    // 300 ₪ in the file. Reading 300 here would mean the column holds shekels and every figure
    // derived from it is a hundredth of what the seller committed.
    expect(campaign!.monthlyBudgetAgorot).toBe(30_000);
    expect(Number.isInteger(campaign!.monthlyBudgetAgorot)).toBe(true);
  });

  it('reads an id that is not a uuid as "no campaigns" rather than raising', async () => {
    // Postgres REJECTS a malformed uuid literal instead of failing to match it, so a stale
    // dashboard URL would be a 500 on the page rather than an empty list.
    expect(await getCampaignsByStoreId('store-1')).toEqual([]);
    expect(await updateCampaign('camp-1', KERAMIKA, { status: 'paused' })).toBeUndefined();
    expect(await archiveCampaign('camp-1', KERAMIKA)).toBeUndefined();
  });
});

describe('creating one', () => {
  it('round-trips every field, and leaves an unset list UNDEFINED rather than empty', async () => {
    const storeId = await freshStore();
    const created = await createCampaign(input(storeId, {
      scope: 'products', productIds: ['p1', 'p2'], productNames: ['a', 'b'],
      durationDays: 7, audience: { gender: 'women', age: 'kids' },
    }));

    const [read] = await getCampaignsByStoreId(storeId);
    expect(read).toEqual(created);
    expect(read!.productIds).toEqual(['p1', 'p2']);
    expect(read!.status).toBe('active');
    expect(read!.durationDays).toBe(7);
    expect(read!.audience).toEqual({ gender: 'women', age: 'kids' });
    // The columns are `NOT NULL DEFAULT '{}'`, so these come back as `[]` from the row. Every
    // reader was written against the file's shape, where an unused scope list was absent —
    // `campaignHealth` falls back to the flat `productId` on `categoryIds ?? []`, and an empty
    // array is not the same answer as a missing one for a caller testing truthiness.
    expect(read!.categoryIds).toBeUndefined();
    expect(read!.categoryNames).toBeUndefined();
    expect(read!.pausedAt).toBeUndefined();
    expect(read!.archivedAt).toBeUndefined();
  });

  it('refuses a negative budget at the column, not in a branch someone can forget', async () => {
    const storeId = await freshStore();
    // `monthly_budget_agorot bigint NOT NULL CHECK (>= 0)`. The JSON file stored whatever it was
    // handed; here the write fails, which is the point of moving it.
    await expect(createCampaign(input(storeId, { monthlyBudgetAgorot: -1 }))).rejects.toThrow();
  });

  it('refuses a budget too large for the column instead of storing a wrapped number', async () => {
    const storeId = await freshStore();
    // The seller-facing cap is 100,000 ₪ (ad-budget.ts) and this is far past it — what this pins
    // is that a hand-built request reaching the module is a rejected write and not a 500 later,
    // when something reads a value the column could not hold.
    await expect(createCampaign(input(storeId, { monthlyBudgetAgorot: 1e30 }))).rejects.toThrow();
  });
});

describe('an id is not a permission', () => {
  it('will not let one store re-budget, pause or cancel another store\'s campaign', async () => {
    const mine = await freshStore();
    const theirs = await freshStore();
    const campaign = await createCampaign(input(theirs));

    expect(await updateCampaign(campaign.id, mine, { monthlyBudgetAgorot: 999_00 })).toBeUndefined();
    expect(await updateCampaign(campaign.id, mine, { status: 'paused' })).toBeUndefined();
    expect(await archiveCampaign(campaign.id, mine)).toBeUndefined();

    // And the row is untouched — a refused write that half-applied would be worse than one that
    // reported success.
    const [after] = await getCampaignsByStoreId(theirs);
    expect(after).toEqual(campaign);
  });
});

describe('the pause moment, which is what freezes the money', () => {
  it('stamps pausedAt on a real active → paused transition', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    const paused = await updateCampaign(campaign.id, storeId, { status: 'paused' });
    expect(paused!.status).toBe('paused');
    expect(paused!.pausedAt).toBeTruthy();
  });

  it('does NOT move it when a paused campaign is merely re-budgeted', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    const paused = await updateCampaign(campaign.id, storeId, { status: 'paused' });
    const rebudgeted = await updateCampaign(campaign.id, storeId, { monthlyBudgetAgorot: 80_000 });

    // `pausedAt` bounds the run period (ad-metrics.ts#runPeriod). Moving it on an edit would
    // stretch the period to the day of the correction and report spend for weeks it never ran.
    expect(rebudgeted!.pausedAt).toBe(paused!.pausedAt);
    expect(rebudgeted!.monthlyBudgetAgorot).toBe(80_000);
    expect(rebudgeted!.status).toBe('paused');
  });

  it('does not re-stamp a campaign that was already paused', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    const first = await updateCampaign(campaign.id, storeId, { status: 'paused' });
    const again = await updateCampaign(campaign.id, storeId, { status: 'paused' });
    expect(again!.pausedAt).toBe(first!.pausedAt);
  });

  it('clears it AND the reason on resume, so the campaign runs to today again', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    await updateCampaign(campaign.id, storeId, { status: 'paused', pausedReason: 'out-of-stock' });
    const resumed = await updateCampaign(campaign.id, storeId, { status: 'active' });

    expect(resumed!.pausedAt).toBeUndefined();
    // The reason has to go with it: it is what tells the resume guard which pauses a click may
    // undo, and a running campaign carrying 'out-of-stock' would resume itself forever.
    expect(resumed!.pausedReason).toBeUndefined();
  });

  it('re-stamps only the reason when the platform escalates a stock pause', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    const paused = await updateCampaign(campaign.id, storeId, { status: 'paused', pausedReason: 'out-of-stock' });
    const escalated = await updateCampaign(campaign.id, storeId, { pausedReason: 'unavailable' });

    expect(escalated!.pausedReason).toBe('unavailable');
    expect(escalated!.status).toBe('paused');
    expect(escalated!.pausedAt).toBe(paused!.pausedAt);
  });
});

describe('history is closed, not editable', () => {
  it('moves a cancelled campaign out of the live list and into history, paused', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    const archived = await archiveCampaign(campaign.id, storeId);

    expect(archived!.archivedAt).toBeTruthy();
    expect(archived!.status).toBe('paused');
    // Archiving stamps the pause too — without it the cancelled campaign's metrics would go on
    // accruing forever, since `pausedAt` is what bounds the run period.
    expect(archived!.pausedAt).toBeTruthy();
    expect(await getCampaignsByStoreId(storeId)).toEqual([]);
    expect((await getArchivedByStoreId(storeId)).map((c) => c.id)).toEqual([campaign.id]);
  });

  it('refuses to re-budget or resume a campaign that is already history', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    await archiveCampaign(campaign.id, storeId);

    // The guard is `WHERE archived_at IS NULL` inside the statement rather than an `if` after a
    // read: re-budgeting a closed campaign rewrites a figure that has already been reported, and
    // resuming it puts a row nobody can see back into circulation.
    expect(await updateCampaign(campaign.id, storeId, { monthlyBudgetAgorot: 90_000 })).toBeUndefined();
    expect(await updateCampaign(campaign.id, storeId, { status: 'active' })).toBeUndefined();

    const [still] = await getArchivedByStoreId(storeId);
    expect(still!.monthlyBudgetAgorot).toBe(50_000);
    expect(still!.status).toBe('paused');
  });

  it('cancels once however many times the button is clicked', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    const first = await archiveCampaign(campaign.id, storeId);
    const second = await archiveCampaign(campaign.id, storeId);

    // A double click must not move `archived_at` forward — that date bounds the frozen metrics,
    // so a second cancel would un-freeze them and re-open a window that had closed.
    expect(second!.archivedAt).toBe(first!.archivedAt);
    expect(second!.pausedAt).toBe(first!.pausedAt);
  });
});

describe('cancelling in bulk — one statement, not one per campaign', () => {
  it('archives every live campaign a closing store still has', async () => {
    const storeId = await freshStore();
    await createCampaign(input(storeId));
    await createCampaign(input(storeId));
    const alreadyDone = await createCampaign(input(storeId));
    await archiveCampaign(alreadyDone.id, storeId);

    // Two were live; the third was already closed and must not be counted or re-stamped.
    expect(await archiveCampaignsForStore(storeId)).toBe(2);
    expect(await getCampaignsByStoreId(storeId)).toEqual([]);
    expect(await archiveCampaignsForStore(storeId)).toBe(0);
  });

  it('archives only the named ones when the sweep hands it a list', async () => {
    const storeId = await freshStore();
    const ending = await createCampaign(input(storeId));
    const running = await createCampaign(input(storeId));

    expect(await archiveCampaigns(storeId, [ending.id])).toBe(1);
    expect((await getCampaignsByStoreId(storeId)).map((c) => c.id)).toEqual([running.id]);
  });

  it('will not archive another store\'s campaigns even when handed their ids', async () => {
    const mine = await freshStore();
    const theirs = await freshStore();
    const victim = await createCampaign(input(theirs));

    expect(await archiveCampaigns(mine, [victim.id])).toBe(0);
    expect((await getCampaignsByStoreId(theirs)).map((c) => c.id)).toEqual([victim.id]);
  });

  it('pauses a whole batch in one statement, and skips ids that are not this store\'s', async () => {
    const mine = await freshStore();
    const theirs = await freshStore();
    const a = await createCampaign(input(mine));
    const b = await createCampaign(input(mine));
    const outsider = await createCampaign(input(theirs));

    const paused = await updateCampaigns(mine, [a.id, b.id, outsider.id], {
      status: 'paused', pausedReason: 'unavailable',
    });
    expect(paused.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(paused.every((c) => c.status === 'paused' && c.pausedReason === 'unavailable')).toBe(true);
    expect((await getCampaignsByStoreId(theirs))[0]!.status).toBe('active');
  });

  it('ignores a budget it cannot store rather than raising on the constraint', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    // The brand twin has always ignored one (`updateBrandCampaign`); this one used to hand a
    // negative straight to the column, where the CHECK turns it into a 500 on the dashboard
    // instead of a field the update declined. The twins agree now — `project_brand_boost_twin_drift`.
    const edited = await updateCampaign(campaign.id, storeId, { monthlyBudgetAgorot: -5 });
    expect(edited!.monthlyBudgetAgorot).toBe(50_000);
    const nan = await updateCampaign(campaign.id, storeId, { monthlyBudgetAgorot: Number.NaN });
    expect(nan!.monthlyBudgetAgorot).toBe(50_000);
  });

  it('does nothing at all — including to updatedAt — when there is nothing to change', async () => {
    const storeId = await freshStore();
    const campaign = await createCampaign(input(storeId));
    expect(await updateCampaigns(storeId, [campaign.id], {})).toEqual([]);
    const [after] = await getCampaignsByStoreId(storeId);
    expect(after!.updatedAt).toBe(campaign.updatedAt);
  });
});

describe('ordering is stable, because the database has none of its own', () => {
  it('breaks a same-instant tie on id rather than leaving it to the planner', async () => {
    const storeId = await freshStore();
    const at = '2026-03-01T10:00:00.000Z';
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      await query(
        `INSERT INTO ad_campaigns (id, store_id, store_slug, scope, platform, monthly_budget_agorot, status, created_at)
         VALUES ($1, $2, 's', 'store', 'both', 10000, 'active', $3)`,
        [id, storeId, at],
      );
    }
    // §7.13: `ORDER BY created_at` alone would return these in whatever order the scan produced,
    // so the seller's campaign list would reshuffle itself between loads for no reason.
    const first = (await getCampaignsByStoreId(storeId)).map((c) => c.id);
    const second = (await getCampaignsByStoreId(storeId)).map((c) => c.id);
    expect(first).toEqual([...ids].sort());
    expect(second).toEqual(first);
  });
});

/**
 * The bigint boundary, and why it needs a stub rather than the database above.
 *
 * `monthly_budget_agorot` is `bigint`, which arrives as a **string** from `pg` and as a **number**
 * from PGlite. The suite runs on PGlite, so every budget assertion in this file passes whether or
 * not the module converts — verified by sabotage: dropping `bigIntOf` left the file green.
 *
 * The failure it hides is arithmetic and silent, and there IS something in this application that
 * adds these: `admin-ads.ts` sums a store's active budgets for the owner's advertising overview.
 * `'30000' + '20000'` is `'3000020000'` — no type error, no exception, a figure five orders of
 * magnitude wrong on the one screen that reports committed spend.
 */
describe('a budget that arrives as a string from the real driver', () => {
  const row = (id: string, agorot: string) => ({
    id, store_id: KERAMIKA, store_slug: 's', scope: 'store',
    product_id: null, product_name: null,
    product_ids: [], product_names: [], category_ids: [], category_names: [],
    platform: 'both', monthly_budget_agorot: agorot, duration_days: null,
    audience_gender: null, audience_age: null, status: 'active',
    paused_at: null, paused_reason: null, archived_at: null,
    created_at: '2026-03-01T00:00:00.000Z', updated_at: '2026-03-01T00:00:00.000Z',
  });

  const strings: Database = {
    query: async <Row>() => ({
      rows: [row('11111111-1111-4111-8111-00000000000a', '30000'),
             row('11111111-1111-4111-8111-00000000000b', '20000')] as Row[],
      rowCount: 2,
    }),
    transaction: async <T>(run: (tx: Queryable) => Promise<T>) => run(strings),
    close: async () => {},
  };

  it('adds up, instead of concatenating', async () => {
    const real = getDatabase();
    setDatabase(strings);
    try {
      const campaigns = await getAllCampaigns();
      const total = campaigns.reduce((sum, c) => sum + c.monthlyBudgetAgorot, 0);
      expect(total).toBe(50_000);
    } finally {
      setDatabase(real);
    }
  });
});
