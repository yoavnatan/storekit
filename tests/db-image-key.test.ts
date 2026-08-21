import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * **The test database image is cached on what it was built FROM, and this is the guard on that
 * list** (2026-08-21).
 *
 * `tests/helpers/db-global-setup.ts` hashes the migrations, the fixture and the importer. Until
 * today it hashed every `.mjs` in `scripts/lib`, which was correct-but-wide: it could not go stale,
 * and it threw a 5MB Postgres image away whenever an unrelated helper was edited. Narrowing it to
 * `db-import.mjs` — the one file `test-db.ts` actually pulls in — removes that waste and takes on
 * one obligation in exchange: **if the importer ever imports a sibling, the key must grow with it.**
 *
 * A stale image is the worst failure this project's test setup has. It means a migration that was
 * edited but not applied leaves every test passing against a schema that no longer exists, and
 * nothing reports a problem. So the narrowing is not left to be remembered.
 */
const ROOT = process.cwd();
const IMPORTER = path.join(ROOT, 'scripts/lib/db-import.mjs');
const SETUP = path.join(ROOT, 'tests/helpers/db-global-setup.ts');

describe('the test-db image cache key covers everything the image is built from', () => {
  it('the importer still pulls in no other file from scripts/lib', () => {
    const source = fs.readFileSync(IMPORTER, 'utf8');
    // Relative imports are the only way it could reach a sibling; a bare specifier is a package.
    const local = [...source.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/gu)].map((m) => m[1]);
    expect(
      local,
      'db-import.mjs gained a local import. The image is built from it, so tests/helpers/' +
        'db-global-setup.ts must hash that file too — otherwise editing it leaves a stale database ' +
        'image and the whole suite passes against a schema that no longer exists.',
    ).toEqual([]);
  });

  it('the key still hashes the migrations, the fixture and the importer', () => {
    const setup = fs.readFileSync(SETUP, 'utf8');
    // Named literally rather than by running sourceKey(), because what is being guarded is that
    // nobody quietly drops one of the three inputs — a hash of the wrong list still returns a hash.
    expect(setup).toContain("dir('migrations', '.sql')");
    expect(setup).toContain("dir('tests/fixtures/db-data', '.json')");
    expect(setup).toContain("scripts/lib/db-import.mjs");
  });
});
