#!/usr/bin/env node
/**
 * Is every picture we PAID FOR actually on the site?
 *
 * `showcase:images` writes URLs into `image-manifest.json`. `seed:showcase` writes them into the
 * DATABASE. They are two commands, and the storefront reads only the second one — so a run that
 * generates images and stops there leaves a manifest full of new pictures and a site still showing
 * the old ones, with nothing anywhere reporting a problem.
 *
 * That is not hypothetical: it happened on 2026-08-17. סהר's catalog was generated and seeded, then
 * the banner was remade, the avatar changed from a generation to a cut-out, and 22 drifted heroes
 * were re-rolled — none of which reached the DB, because the session ended between the two commands.
 * The owner's question when he saw the old shop was "זה היה נשכח לנצח?", and the honest answer was
 * yes: nothing would ever have said so. The generator prints "Now write them into the database",
 * which is a reminder, and a reminder is exactly what this class of bug survives.
 *
 * It is the same shape as the migration gate in `verify.mjs` — written ≠ applied — so it is checked
 * the same way and for the same reason: everything else there reads FILES, and the app reads a
 * DATABASE. Wired to the manifest, so it costs nothing on a run that did not touch imagery.
 *
 * Exits 1 with the count and the first few keys, or 0 with one line. `--quiet` prints only failures.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSeedClient } from './lib/seed-db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, 'lib/showcase/image-manifest.json'), 'utf8'));
const QUIET = process.argv.includes('--quiet');

/** Manifest keys are `<slug>:<product name>` for products and `<slug>:__banner|__logo|__headerlogo`
 *  for the store's own three. Gallery views (`…#detail`) hang off the product's `images` array and
 *  are deliberately not compared: the MAIN shot is what every grid, card and feed row reads, and it
 *  is the one whose staleness is visible. */
const wanted = new Map();
for (const [key, url] of Object.entries(manifest)) {
  const cut = key.indexOf(':');
  const slug = key.slice(0, cut);
  const rest = key.slice(cut + 1);
  if (!slug.startsWith('showcase-')) continue;
  if (!wanted.has(slug)) wanted.set(slug, { brand: {}, products: new Map() });
  const store = wanted.get(slug);
  if (rest.startsWith('__')) store.brand[rest] = url;
  else if (!rest.includes('#')) store.products.set(rest, url);
}

const db = await openSeedClient();
const stale = [];
try {
  for (const [slug, want] of wanted) {
    const { rows: [store] } = await db.query(
      'SELECT id, banner_image, profile_image, header_logo FROM stores WHERE slug = $1', [slug],
    );
    // Not seeded at all is a different situation from seeded-and-stale, and "run the seeder" is the
    // right answer to both — but a missing store must not report every one of its products as well.
    if (!store) { stale.push(`${slug}: the store is not in the database at all`); continue; }

    for (const [key, live] of [['__banner', store.banner_image], ['__logo', store.profile_image],
      ['__headerlogo', store.header_logo]]) {
      if (want.brand[key] && live !== want.brand[key]) stale.push(`${slug}:${key}`);
    }

    // `store_products` holds the row, `product_images` holds the pictures at position 0..n — the
    // shapes the seeder writes (`seed-db.mjs#writeCatalog`). Position 0 IS the main shot.
    const { rows } = await db.query(
      `SELECT p.name, i.url
         FROM store_products p
         LEFT JOIN product_images i ON i.product_id = p.id AND i.position = 0
        WHERE p.store_id = $1`, [store.id],
    );
    const live = new Map(rows.map((r) => [r.name, r.url]));
    for (const [name, url] of want.products) {
      if (live.get(name) !== url) stale.push(`${slug}:${name}`);
    }
  }
} finally {
  await db.end();
}

if (!stale.length) {
  if (!QUIET) console.log('showcase images: the database matches the manifest.');
  process.exit(0);
}

console.error(`\n❌ ${stale.length} showcase image(s) are in the manifest but NOT on the site.`);
console.error('   These were generated (and paid for) and never written to the database:\n');
for (const s of stale.slice(0, 12)) console.error(`     · ${s}`);
if (stale.length > 12) console.error(`     … and ${stale.length - 12} more`);
console.error('\n   Fix:  npm run seed:showcase\n');
process.exit(1);
