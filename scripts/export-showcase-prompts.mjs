#!/usr/bin/env node
/**
 * Export every showcase product's image prompt to a CSV the owner can work through by hand.
 *
 *   npm run showcase:prompts                 # all four stores
 *   npm run showcase:prompts -- --store=showcase-tech
 *   npm run showcase:prompts -- --missing    # only what has no picture yet
 *
 * ── Why this exists (owner, 2026-08-12) ─────────────────────────────────────
 * "יש לי הרגשה שאני זה שצריך להוריד תמונות אחת אחת מג׳מיני ולא אתה בצורה עיוורת."
 * He is right. Generating 400 pictures from a script means nobody looks at them until they are all
 * paid for, and every correction costs another full run — which is exactly how this went. Him
 * pasting a prompt into the Gemini web app, looking at the result, and uploading the one he likes
 * is slower per image and far faster overall, because the feedback loop is one image long instead
 * of four hundred. It also costs nothing: the web app is included with his Google account, while
 * the API bills per image.
 *
 * So the API pipeline stays for whoever wants a bulk run, and this is the other door. The prompts
 * are identical either way — both call `imagePrompt()`, so the art direction cannot drift between
 * them.
 *
 * ── The columns are ordered for the job, not for the data ───────────────────
 * store · category · product · view · WHERE TO PASTE IT · prompt · dashboard link. A person doing
 * this for an hour wants the prompt and the place to put the result next to each other, and wants
 * to be able to sort by store and tick rows off. CSV rather than JSON for the same reason: it
 * opens in Sheets and it can be marked up.
 */
import { writeFileSync } from 'node:fs';
import { SHOWCASE_STORES, imagePrompt, bannerPrompt, PRODUCT_VIEWS, viewsForProduct } from './lib/showcase/identity.mjs';
import { FASHION_PRODUCTS } from './lib/showcase/catalog-fashion.mjs';
import { HOME_PRODUCTS } from './lib/showcase/catalog-home.mjs';
import { TECH_PRODUCTS } from './lib/showcase/catalog-tech.mjs';
import { PLANT_PRODUCTS } from './lib/showcase/catalog-plants.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'lib/showcase/image-manifest.json');
const OUT = join(HERE, '..', 'showcase-prompts.csv');

const CATALOGS = {
  'showcase-fashion': FASHION_PRODUCTS,
  'showcase-home': HOME_PRODUCTS,
  'showcase-tech': TECH_PRODUCTS,
  'showcase-plants': PLANT_PRODUCTS,
};

const argv = process.argv.slice(2);
const ONLY_STORE = argv.find((a) => a.startsWith('--store='))?.split('=')[1];
const MISSING_ONLY = argv.includes('--missing');

const manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {};

/** RFC-4180 quoting. A prompt contains commas and the Hebrew copy contains quotes, and a CSV that
 *  breaks on its own content is worse than no CSV. */
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const rows = [[
  'חנות', 'קטגוריה', 'מוצר', 'תמונה', 'סטטוס', 'איפה להעלות', 'פרומפט להדבקה בג׳מיני',
].map(cell)];

let n = 0;
for (const store of SHOWCASE_STORES) {
  if (ONLY_STORE && store.slug !== ONLY_STORE) continue;

  const bannerDone = !!manifest[`${store.slug}:__banner`];
  if (!MISSING_ONLY || !bannerDone) {
    rows.push([
      store.name, '—', 'באנר החנות', 'banner',
      bannerDone ? 'קיים' : 'חסר',
      `דשבורד → החנות → הגדרות → תמונת באנר`,
      bannerPrompt(store),
    ].map(cell));
    n++;
  }

  const catalog = CATALOGS[store.slug];
  for (const [i, p] of catalog.entries()) {
    const slug = `${store.slug.replace('showcase-', '')}-${i + 1}`;
    for (const [vi, view] of viewsForProduct(p.n).entries()) {
      const key = vi === 0 ? `${store.slug}:${p.n}` : `${store.slug}:${p.n}#${view.key}`;
      const done = !!manifest[key];
      if (MISSING_ONLY && done) continue;
      rows.push([
        store.name,
        `${store.categories[p.c]}${p.sub ? ` › ${p.sub}` : ''}`,
        p.n,
        vi === 0 ? 'ראשית' : view.key,
        done ? 'קיים' : 'חסר',
        `/${store.slug}/${slug}`,
        imagePrompt(store, p.s, view, p.n),
      ].map(cell));
      n++;
    }
  }
}

// BOM: without it Excel opens a UTF-8 CSV as Latin-1 and every Hebrew column is mojibake. Sheets
// does not need it and does not mind it.
writeFileSync(OUT, `\uFEFF${rows.map((r) => r.join(',')).join('\r\n')}\r\n`, 'utf8');

const views = PRODUCT_VIEWS.map((v) => v.key).join(', ');
console.log(`\n✅ ${n} prompt(s) → ${OUT}`);
console.log(`   Views per product vary by product (${views}) — most carry one, some carry more.`);
console.log('   Columns: store · category · product · view · status · where to upload · prompt.');
console.log('   Paste the prompt into the Gemini web app, save the image, and upload it on the');
console.log('   product row named in "איפה להעלות".\n');
