#!/usr/bin/env node
/**
 * The demonstration's "first day" shop, on its own.
 *
 *   npm run demo:first-day
 *
 * **Why this exists as a command of its own, and it is not tidiness.** `seed:portfolio` builds the
 * whole demonstration, and the first thing it does is DELETE every store that is not a showcase
 * store and rebuild the four from scratch — which throws away the owner's edits to their names,
 * pictures and descriptions. Those edits are the reason the hourly rebuild was turned off in the
 * first place (`jobs/registry.ts`), so "run the seeder again" is not an answer for anything that
 * has to be added to a demonstration already in use.
 *
 * This runs the one step, and it is safe to run at any time: it writes one seller, one shop and one
 * product, all `ON CONFLICT` no-ops the second time, and it deletes nothing. A demonstration that
 * already has them is unchanged.
 *
 * The claim gate is deliberately NOT here. That gate exists to stop a DESTRUCTIVE script running
 * against the wrong database, and there is nothing destructive to stop — the worst a wrong
 * `DATABASE_URL` can do is add one unpublished shop nobody can see.
 */
import { openSeedClient } from './lib/seed-db.mjs';
import { seedFirstDayShop } from './seed-portfolio.mjs';

const db = await openSeedClient();
try {
  const { store, seller } = await seedFirstDayShop(db);
  console.log(`first-day shop ready — store ${store}, seller ${seller}`);
  console.log('The header\'s "סיור באתר" control now has a working "מוכר חדש" row.');
} finally {
  await db.end();
}
