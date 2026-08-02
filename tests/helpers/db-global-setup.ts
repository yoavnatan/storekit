/**
 * Builds the test database image once per `npm test`, and only when something it depends on moved.
 *
 * Vitest runs each test file in its own worker, so without this the schema and the import would run
 * ~20 times per suite. Here they run once; every file then loads the result (`test-db.ts`).
 *
 * **The cache key is content, never a timestamp.** A stale image is the worst possible failure for
 * this file — a migration that was edited but not applied makes tests pass against a schema that no
 * longer exists, and nothing reports a problem. Hashing what the image is built FROM (the
 * migrations, the import script, the data) means an edit to any of them rebuilds, and an edit that
 * happens to preserve mtime and size cannot slip through the way it would with a metadata key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildImage, IMAGE_PATH } from './test-db.js';

const ROOT = process.cwd();
const STAMP = `${IMAGE_PATH}.key`;

function sourceKey(): string {
  const hash = crypto.createHash('sha256');
  const add = (file: string) => hash.update(fs.readFileSync(file));
  const dir = (rel: string, ext: string) => {
    const full = path.join(ROOT, rel);
    for (const name of fs.readdirSync(full).filter((f) => f.endsWith(ext)).sort()) {
      hash.update(name);
      add(path.join(full, name));
    }
  };
  dir('migrations', '.sql');
  dir('tests/fixtures/db-data', '.json');
  dir('scripts/lib', '.mjs');
  return hash.digest('hex');
}

export async function setup(): Promise<void> {
  const key = sourceKey();
  const cached = fs.existsSync(STAMP) && fs.existsSync(IMAGE_PATH) && fs.readFileSync(STAMP, 'utf8') === key;
  if (cached) return;
  await buildImage();
  fs.writeFileSync(STAMP, key);
}
