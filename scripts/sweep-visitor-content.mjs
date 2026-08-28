#!/usr/bin/env node
/**
 * Clear out what visitors left on the demonstration, and nothing the owner made.
 *
 *   npm run demo:sweep        # or the `demo-sweep` job, which runs this on a timer
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * The demonstration lets anybody press "פתח חנות" and build a real shop — that is one of the two
 * flows it exists to show, and it is deliberately not blocked (`lib/demo-viewer.ts`). The cost is
 * that every visitor who tries it leaves a shop behind, and a recruiter opening the site next month
 * would find the four curated shops among thirty abandoned ones called "test" and "אאאא".
 *
 * The owner's requirement, in his words (2026-08-27): *"שהקיים יהיה זמני, יימחק לאחר זמן מה אבל
 * שהשינויים שאני עורך כן יתפסו"*. Two halves, and the second is why the hourly rebuild had to be
 * turned off: he edits the showcase shops through the dashboard like any seller, and a job that
 * reseeds them throws his work away.
 *
 * So this sweeps by AGE and by OWNERSHIP, never by rebuilding: a visitor's shop lives a full day —
 * long enough to build it, show somebody, and come back the next morning — and then goes. The
 * showcase shops are excluded by the same clause that has always excluded them, so nothing here can
 * reach his edits no matter how long it runs.
 *
 * ── Why it is a script and not a query in the job ───────────────────────────
 *
 * Every DELETE on this codebase lives in `scripts/lib/seed-db.mjs`, behind the purge gate, and
 * `tests/seed-purge-gate.test.ts` fails if one appears anywhere else. That gate is the reason a
 * widened constant cannot quietly delete a real seller's catalogue, and a scheduled job is the last
 * place that should get its own private DELETE. So the rule stays in `SEED_SCOPES.visitor` with the
 * other three, and this file is a thin runner the job shells out to — the same shape `demo-reset`
 * uses, so the manual path and the automatic one cannot drift apart.
 */
import { openSeedClient, isDemoDatabase, purge, purgeOrdersOfStores, purgeVisitorOrders, VISITOR_CONTENT_HOURS } from './lib/seed-db.mjs';
import { pathToFileURL } from 'node:url';

export async function sweep(db) {
  // The same gate `purge` applies to this scope, asked first so the refusal explains itself in one
  // line instead of arriving as a thrown error from two calls deeper.
  if (!(await isDemoDatabase(db))) {
    throw new Error(
      'sweep refused: this database has not been claimed as the portfolio demonstration. Check '
      + 'DATABASE_URL, then `npm run demo:claim` against the DEMO connection.',
    );
  }

  // Orders first, and this is the ordering the schema forces rather than a preference: an order
  // names its store by SLUG, not by foreign key, so deleting the stores first would strand every
  // order pointing at a slug nothing answers to (seed-db.mjs → purgeOrdersOfStores).
  const orders = await purgeOrdersOfStores(db, 'visitor');
  const { stores, sellers } = await purge(db, 'visitor');
  // And the other half, which the store-shaped purge above cannot reach: a purchase a visitor made
  // in a SHOWCASE shop belongs to a store that stays, so nothing removed it and the order list grew
  // by every stranger who tried the checkout.
  const bought = await purgeVisitorOrders(db);
  return {
    stores, sellers,
    orders: (orders.deleted ?? 0) + (bought.deleted ?? 0),
    kept: orders.keptShared ?? 0,
    note: bought.reason,
  };
}

async function main() {
  const db = await openSeedClient();
  try {
    const result = await sweep(db);
    console.log(
      `swept visitor content older than ${VISITOR_CONTENT_HOURS}h — `
      + `stores ${result.stores}, accounts ${result.sellers}, orders ${result.orders}`
      + (result.kept ? `, kept ${result.kept} shared with a store that stays` : '')
      + (result.note ? ` — ${result.note}` : ''),
    );
  } finally {
    await db.end();
  }
}

/** Only when RUN, never when imported — `tests/` drives `sweep()` directly against a real schema. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
