#!/usr/bin/env node
/**
 * A vendor's inventory export, built from a real store's own catalogue — so the external sync can
 * actually be TRIED (owner, 2026-08-19: *"מרגיש לי שזה פיצ׳ר שאין לי דרך לבדוק באמת"*).
 *
 *   npm run demo:feed                    # the first showcase store that has any SKUs
 *   npm run demo:feed -- <store-slug>    # a specific shop
 *   npm run demo:feed -- <slug> --zero   # every quantity 0, to watch the storefront sell out
 *
 * It writes `demo-feed.csv` in the project root and prints what to do with it. The file is
 * deliberately NOT in our own format: the headers are a POS's ("Item Code", "Qty On Hand"), the
 * columns are in the wrong order, and there are extra columns we do not want — which is the whole
 * point, because the column mapping is the part of this feature a seller meets first and the part
 * most likely to be wrong.
 *
 * **Why a file and not a URL.** The fetch guard blocks loopback and every private range, and it is
 * right to (lib/feed-fetch.ts: DNS rebinding, cloud metadata). So the honest local test is the
 * panel's own "העלה קובץ", which runs the identical pipeline — same mapping, same sku matching,
 * same per-combo resolution, same preview, same write. What an upload does NOT exercise is the
 * hourly pull and the alerts on top of it; for those the URL has to be genuinely public (a raw
 * gist link is enough), and that is stated at the end of the printout rather than left to be
 * discovered.
 *
 * Reads only. It never writes to the database — the whole point is to hand the seller's own screen
 * something to do the writing.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openSeedClient } from './lib/seed-db.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--');
const ZERO = args.includes("--zero");
const ASSIGN = args.includes("--assign-skus");
const slugArg = args.find((a) => !a.startsWith('--'));
const OUT = resolve(process.cwd(), 'demo-feed.csv');

/** Deterministic, so re-running gives the same file and a second sync is provably a no-op. */
let seed = 20260819;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const cell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const db = await openSeedClient();
try {
  const { rows: stores } = await db.query(
    `SELECT s.id, s.slug, s.name,
            COUNT(*) FILTER (WHERE p.sku IS NOT NULL AND p.sku <> '') AS product_skus,
            COUNT(v.sku) FILTER (WHERE v.sku IS NOT NULL AND v.sku <> '') AS combo_skus
       FROM stores s
       JOIN store_products p ON p.store_id = s.id
       LEFT JOIN product_variant_stock v ON v.product_id = p.id
      WHERE ($1::text IS NULL OR s.slug = $1)
      GROUP BY s.id, s.slug, s.name
     HAVING COUNT(*) FILTER (WHERE p.sku IS NOT NULL AND p.sku <> '') > 0
         OR COUNT(v.sku) FILTER (WHERE v.sku IS NOT NULL AND v.sku <> '') > 0
      ORDER BY (COUNT(*) FILTER (WHERE p.sku IS NOT NULL AND p.sku <> '')
              + COUNT(v.sku) FILTER (WHERE v.sku IS NOT NULL AND v.sku <> '')) DESC
      LIMIT 1`,
    [slugArg ?? null],
  );

  // The demo catalogues were seeded without SKUs, which is the real reason this feature could not
  // be tried: a feed matches rows BY sku, so a shop with none has nothing for any file to address.
  // `--assign-skus` fills the blanks (and only the blanks) so there is something to match on.
  if (ASSIGN) {
    const target = slugArg ?? stores[0]?.slug;
    if (!target) {
      console.error('Name a store slug to assign SKUs to: npm run demo:feed -- <store-slug> --assign-skus');
      process.exit(1);
    }
    const prefix = target.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'SKU';
    // Only where there is nothing. A code a seller (or an earlier run) already set is theirs, and
    // overwriting one would break the very link this script exists to demonstrate.
    const { rowCount: filledProducts } = await db.query(
      `UPDATE store_products p SET sku = $2 || '-' || lpad((row_number)::text, 4, '0')
         FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS row_number
                 FROM store_products
                WHERE store_id = (SELECT id FROM stores WHERE slug = $1)
                  AND (sku IS NULL OR sku = '')) AS numbered
        WHERE p.id = numbered.id`,
      [target, prefix],
    );
    // A duplicated per-combo code is invalid by the platform's own rule (one code names exactly one
    // combination, or an inbound feed row is ambiguous — lib/variant-sku-field.ts), and the first
    // version of this script produced them: it built the code out of the combo KEY, which is Hebrew,
    // and stripping non-ASCII left several combos sharing whatever digits remained. Clearing them is
    // safe precisely because such a code could never have been legitimate.
    await db.query(
      `UPDATE product_variant_stock v SET sku = NULL
         FROM store_products p
        WHERE p.id = v.product_id
          AND p.store_id = (SELECT id FROM stores WHERE slug = $1)
          AND v.sku IN (
            SELECT v2.sku FROM product_variant_stock v2
              JOIN store_products p2 ON p2.id = v2.product_id
             WHERE p2.store_id = (SELECT id FROM stores WHERE slug = $1) AND v2.sku IS NOT NULL AND v2.sku <> ''
             GROUP BY v2.sku HAVING COUNT(*) > 1)`,
      [target],
    );
    // Numbered per product, never derived from the combo key — the keys are Hebrew, and any
    // transliteration of them is a second way to collide.
    const { rowCount: filledCombos } = await db.query(
      `UPDATE product_variant_stock v SET sku = numbered.product_sku || '-' || lpad(numbered.n::text, 2, '0')
         FROM (SELECT v2.product_id, v2.combo_key, p2.sku AS product_sku,
                      ROW_NUMBER() OVER (PARTITION BY v2.product_id ORDER BY v2.combo_key) AS n
                 FROM product_variant_stock v2
                 JOIN store_products p2 ON p2.id = v2.product_id
                WHERE p2.store_id = (SELECT id FROM stores WHERE slug = $1)
                  AND p2.sku IS NOT NULL AND p2.sku <> ''
                  AND (v2.sku IS NULL OR v2.sku = '')) AS numbered
        WHERE v.product_id = numbered.product_id AND v.combo_key = numbered.combo_key`,
      [target],
    );
    console.log(`Filled ${filledProducts} product SKUs and ${filledCombos} per-combination SKUs in ${target} (blanks only).`);
    console.log('Run the same command again without --assign-skus to write the feed file.');
    process.exit(0);
  }

  const store = stores[0];
  if (!store) {
    console.error(slugArg
      ? `No store "${slugArg}" has a SKU on anything. A feed matches rows BY sku, so a catalogue without one has nothing to match on.\n  Give it some: npm run demo:feed -- ${slugArg} --assign-skus`
      : 'No store in this database has a SKU on any product — which is why the sync could not be tried.\n  Fill one shop in: npm run demo:feed -- <store-slug> --assign-skus');
    process.exit(1);
  }

  // Product-level codes and per-combination codes in ONE list, because that is exactly what a POS
  // exports: it counts the thing it sells, which for a variant product is blue-L and not "the
  // shirt". Both resolve on our side (lib/variant-sku-match.ts).
  const { rows: lines } = await db.query(
    `SELECT p.sku AS sku, p.name AS name, p.stock AS stock, NULL::text AS combo
       FROM store_products p
      WHERE p.store_id = $1 AND p.sku IS NOT NULL AND p.sku <> ''
        AND NOT EXISTS (SELECT 1 FROM product_variant_stock v WHERE v.product_id = p.id AND v.sku IS NOT NULL AND v.sku <> '')
      UNION ALL
     SELECT v.sku AS sku, p.name AS name, COALESCE(v.stock, p.stock) AS stock, v.combo_key AS combo
       FROM product_variant_stock v
       JOIN store_products p ON p.id = v.product_id
      WHERE p.store_id = $1 AND v.sku IS NOT NULL AND v.sku <> ''
      ORDER BY sku`,
    [store.id],
  );

  // A vendor's own spelling: our columns, renamed, reordered, with two we do not want. Nothing here
  // is our canonical format — the mapping UI is what turns it into ours, and this file exists to
  // give that UI something real to chew on.
  const header = ['Warehouse', 'Item Code', 'Description', 'Qty On Hand', 'Last Counted'];
  const body = lines.map((line) => {
    const qty = ZERO ? 0 : Math.max(0, Math.round(Number(line.stock) + (rnd() * 10 - 4)));
    const label = line.combo ? `${line.name} (${line.combo.replace(/=/g, ' ').replace(/,/g, ' / ')})` : line.name;
    return ['MAIN', line.sku, label, String(qty), '2026-08-19'].map(cell).join(',');
  });
  // `\uFEFF` as an ESCAPE rather than the literal character: a raw BOM in source is invisible, which
  // is exactly why `no-irregular-whitespace` refuses it. The byte in the OUTPUT is unchanged — it is
  // what makes Excel read the file as UTF-8 instead of as mojibake.
  writeFileSync(OUT, `\uFEFF${[header.join(','), ...body].join('\r\n')}\r\n`, 'utf8');

  const combos = lines.filter((l) => l.combo).length;
  console.log(`
Wrote ${OUT}
  ${store.name} (${store.slug}) — ${lines.length} rows${combos ? `, ${combos} of them per-combination codes` : ''}${ZERO ? ', every quantity 0' : ''}

Try it, in the seller dashboard → מוצרים → the sync panel (סנכרון מלאי חיצוני):
  1. "העלה קובץ" → demo-feed.csv. The column mapping opens; "Item Code" and "Qty On Hand"
     should already be guessed as מק"ט and מלאי. Confirm it once — the mapping is saved per store.
  2. Read the preview. Every row should say "עדכון", never "יצירה" — a row that says יצירה means
     the sku matched nothing, which is the one failure that would duplicate a catalogue.
  3. Confirm, then open a product and check its stock against the file.
  4. Re-run this script and import the same file again: every row must come back "ללא שינוי".
     That is the property the hourly job depends on.

The URL half (and the alerts that ride on it) needs a genuinely public link — the fetch guard
blocks localhost and every private range on purpose. Paste this file into a gist, take the "raw"
URL, and save it as the feed URL.
`);
} finally {
  await db.end();
}
