// Marks the database in DATABASE_URL as one that must not be migrated by accident, or lifts that
// mark again.
//
//   npm run db:protect              mark it
//   npm run db:protect -- --remove  lift it
//   npm run db:protect -- --status  say which it is, change nothing
//
// The mark is a row in `app_settings`, so it is a property of the DATABASE and not of a shell, an
// `.env` or a person's memory — `lib/protected-db.mjs` explains why that distinction is the whole
// point. Run it once against the connection that serves the live demonstration, and every later
// `npm run db:migrate` against that connection refuses until somebody types `--live`.
//
// The live demonstration is usually already covered without this: `seed-portfolio.mjs --claim`
// writes `demo_database`, which counts. This exists for the other case — a production database,
// when there is one, that no seeder ever claimed.
import { createClient, requireDatabaseUrl } from './lib/pg-connect.mjs';
import { PROTECTED_CLAIM_KEY, protectedDatabaseReason } from './lib/protected-db.mjs';

const remove = process.argv.includes('--remove');
const statusOnly = process.argv.includes('--status');
const client = createClient(requireDatabaseUrl());

async function main() {
  await client.connect();

  const before = await protectedDatabaseReason(client);

  if (statusOnly) {
    console.log(
      before === 'demo'
        ? 'protected — this is the live demonstration (app_settings.demo_database).'
        : before === 'protected'
          ? 'protected — marked with db:protect (app_settings.protected_database).'
          : 'not protected — db:migrate will apply to this database without asking.',
    );
    return;
  }

  if (remove) {
    if (before === 'demo') {
      // Refusing rather than deleting somebody else's row: this script did not write
      // `demo_database` and the seeder's own claim means something different from ours.
      console.error(
        '\nRefused: this database is the live demonstration, claimed by seed:portfolio, and that\n' +
          'claim is not this script\'s to remove.\n',
      );
      process.exitCode = 1;
      return;
    }
    const { rowCount } = await client.query('DELETE FROM app_settings WHERE key = $1', [PROTECTED_CLAIM_KEY]);
    console.log(rowCount ? 'Protection lifted.' : 'Nothing to lift — it was not protected.');
    return;
  }

  await client.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PROTECTED_CLAIM_KEY, JSON.stringify({ protectedAt: new Date().toISOString() })],
  );
  console.log('Protected. `npm run db:migrate` against this database now needs --live.');
}

main()
  .catch((err) => { console.error(`\n${err.message}\n`); process.exitCode = 1; })
  .finally(() => client.end());
