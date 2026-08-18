#!/usr/bin/env node
/**
 * Showcase-store seeder — the four platform-owned "חנות לדוגמה" stores
 * (GO_LIVE_CHECKLIST.md §6.2, src/lib/demo-stores.ts).
 *
 *   npm run seed:showcase             # create/refresh all four
 *   npm run seed:showcase -- --clean  # remove them
 *
 * Different from scripts/seed-demo-data.mjs in kind, not just in size: that one
 * builds a big fake catalog for DEVELOPMENT and gets wiped before launch. These
 * are meant to be LIVE on the real site on day one, so that the first seller has
 * a finished store to look at and the homepage spotlight has more than one slide
 * to rotate. They carry `demo: true`, which keeps them out of the index, out of
 * the feeds, out of every store-count threshold and out of checkout — the whole
 * rule set is in lib/demo-stores.ts and pinned by tests/demo-store-isolation.
 *
 * ── What this file is NOT any more (rewritten 2026-08-12) ───────────────────
 * It used to BE the catalog: 30 products a store, a Hebrew translation table
 * inline, and photographs fetched from DummyJSON at seed time — which meant real
 * photographs of real Nike, Apple and Prada goods on a live commercial domain,
 * and a seeder that needed the internet to work at all.
 *
 * Now it is only a writer. Who the stores are lives in `lib/showcase/identity.mjs`,
 * what they sell in the four `catalog-*.mjs` files, and their pictures in
 * `image-manifest.json`, produced by `generate-showcase-images.mjs`. This file
 * turns those into rows. The split is what lets the images be generated once,
 * expensively, and the database be reseeded any number of times for free.
 *
 * **Writes to Postgres** (DATABASE_URL required). Idempotent: a re-run replaces
 * the previous showcase set inside one transaction, matched on `demo = true` plus
 * the platform seller account, so it never accumulates duplicates and can never
 * touch a real seller's data (THE PURGE GATE in seed-db.mjs).
 */
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedShowcaseReviews } from './seed-reviews.mjs';
import {
  SEED_SCOPES, SHOWCASE_OWNER_EMAIL,
  openSeedClient, purge, writeCatalog,
} from './lib/seed-db.mjs';
import { SHOWCASE_STORES, PRODUCT_VIEWS } from './lib/showcase/identity.mjs';
import { variantsFor } from './lib/showcase/variants.mjs';
import { FASHION_PRODUCTS } from './lib/showcase/catalog-fashion.mjs';
import { HOME_PRODUCTS } from './lib/showcase/catalog-home.mjs';
import { TECH_PRODUCTS } from './lib/showcase/catalog-tech.mjs';
import { PLANT_PRODUCTS } from './lib/showcase/catalog-plants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'lib/showcase/image-manifest.json');

const CATALOGS = {
  'showcase-fashion': FASHION_PRODUCTS,
  'showcase-home': HOME_PRODUCTS,
  'showcase-tech': TECH_PRODUCTS,
  'showcase-plants': PLANT_PRODUCTS,
};

const uuid = () => crypto.randomUUID();

/** The platform's own seller account. Every showcase store hangs off this one record so the whole
 *  set has a single owner to log in as and to clean up by. Defined in `seed-db.mjs`, because the
 *  purge gate there has to know it in order to allow this set to be deleted. */
const OWNER_EMAIL = SHOWCASE_OWNER_EMAIL;
const OWNER_PASSWORD = 'showcase1234';
const OWNER_NAME = 'Dezabin';

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * The four products a store's homepage card leads with, dated so that they actually do.
 *
 * `getStorePreviews` draws the four NEWEST visible products that carry a photo — `ORDER BY
 * created_at DESC, id`. Nothing in the product chooses this and no seller can, so for these stores
 * it was decided by `int(1, 45)` and, for the products that landed on the same day, by a `uuid()`
 * minted fresh on every seed. That last part is the sharp edge: **the card reshuffled between two
 * reseeds an hour apart** (measured 2026-08-14 — a belt moved from third to first), so a showcase
 * store's own shop window was not the same picture twice, and no amount of choosing which product
 * to stage would have stuck.
 *
 * `cardProducts` in `identity.mjs` names them in the order the card should show them. Each gets a
 * timestamp newer than anything the random path can produce (which bottoms out at NOW - 1 day) and
 * a distinct hour, so the ordering is total and the `id` tie-break is never reached.
 *
 * A store without the field keeps the old behaviour exactly. This is deliberately NOT a general
 * "featured product" mechanism: real sellers have no such control today (the gap the owner found
 * on 2026-08-14 and the reason this exists), and inventing one here in a demo seeder would be the
 * wrong place — it belongs in the schema and the dashboard, as its own decision.
 */
const cardAt = (spec, name) => {
  const rank = spec.cardProducts?.indexOf(name) ?? -1;
  return rank < 0 ? null : iso(NOW - rank * 3600_000 - 60_000);
};

// Deterministic pseudo-random: a re-seed produces the same prices and stock, so a screenshot or a
// bug report from one run still matches the next.
let _s = 20260812;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.createHmac('sha256', salt).update(pw).digest('hex')}`;
};
const comboKey = (sel) => Object.keys(sel).sort((a, b) => a.localeCompare(b)).map((k) => `${k}=${sel[k]}`).join(',');

/** A latin, URL-safe slug. Product names here are Hebrew and `toSlug` would yield an empty string,
 *  so the slug is positional. It stays stable across re-seeds because the catalogs are ordered
 *  files — which matters, since a shopper's bookmark and any indexed URL are built from it. */
const productSlug = (storeSlug, index) => `${storeSlug.replace('showcase-', '')}-${index + 1}`;

/** Opening hours: a normal Israeli week — short Friday, closed Saturday. */
function weekHours() {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return Object.fromEntries(days.map((d) => [
    d,
    d === 'sat'
      ? { closed: true, open: '09:00', close: '18:00' }
      : { closed: false, open: '09:00', close: d === 'fri' ? '14:00' : '19:00' },
  ]));
}

/**
 * Stock for one product.
 *
 * Deliberately varied, including zeros. A showcase catalog where everything is comfortably in stock
 * never shows the seller what "אזל מהמלאי" looks like on their own shelf, and never exercises the
 * storefront's out-of-stock card, the disabled buy button or the greyed-out variant chip — three
 * behaviours a prospective seller is entitled to see working before they trust the platform with a
 * real catalogue.
 */
function buildVariantStock(variants) {
  const combos = variants.reduce(
    (acc, dim) => acc.flatMap((sel) => dim.options.map((o) => ({ ...sel, [dim.name]: o }))),
    [{}],
  );
  const out = {};
  for (const c of combos) out[comboKey(c)] = rnd() < 0.15 ? 0 : int(3, 24);
  return out;
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return {};
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); } catch { return {}; }
}

async function main() {
  const clean = process.argv.includes('--clean');
  const db = await openSeedClient();
  try {
    await seed(db, clean);
  } finally {
    await db.end();
  }
}

async function seed(db, clean) {
  const STALE_STORES = SEED_SCOPES.showcase.stores;

  if (clean) {
    const removed = await purge(db, 'showcase');
    console.log(`\n🧹 Removed ${removed.stores} showcase store(s) + ${removed.sellers} platform seller account(s). Real data untouched.\n`);
    return;
  }

  const manifest = loadManifest();
  const manifestCount = Object.keys(manifest).length;
  if (!manifestCount) {
    console.log('\n⚠️  image-manifest.json is empty — the stores will be written WITHOUT pictures.');
    console.log('   Run `npm run showcase:images` first (it needs GEMINI_API_KEY; see .env.example).\n');
  }

  // Reuse the existing platform account when there is one — its password, and anything filed
  // against it, survives a re-seed. Created on the first run only.
  const { rows: existingOwner } = await db.query('SELECT id FROM sellers WHERE email = $1', [OWNER_EMAIL]);
  const ownerId = existingOwner[0]?.id ?? uuid();
  const sellers = existingOwner[0] ? [] : [{
    id: ownerId, email: OWNER_EMAIL, passwordHash: hashPassword(OWNER_PASSWORD),
    name: OWNER_NAME, createdAt: iso(NOW),
  }];

  // Slugs a REAL store holds. The set about to be replaced is excluded, or a re-seed would find its
  // own previous stores in the way and skip every one of them.
  const { rows: takenRows } = await db.query(
    `SELECT slug::text AS slug FROM stores WHERE deleted_at IS NULL AND NOT (${STALE_STORES})`,
  );
  const taken = new Set(takenRows.map((r) => r.slug));

  const stores = [];
  const products = [];
  const categories = [];
  let missingImages = 0;

  console.log(`\n🏬 Seeding ${SHOWCASE_STORES.length} showcase stores (demo: true), ${manifestCount} images in the manifest…`);

  for (const spec of SHOWCASE_STORES) {
    if (taken.has(spec.slug)) {
      console.log(`   ⚠️  slug "${spec.slug}" is taken by a real store — skipping this showcase store.`);
      continue;
    }
    const rows = CATALOGS[spec.slug];
    const storeId = uuid();
    const createdAt = iso(NOW - int(20, 60) * DAY);

    // ── Categories, up to THREE levels ─────────────────────────────────────
    // Top level comes from the store's own list. The levels below it are DERIVED from the catalog:
    // a row may name a `sub`, and a row may additionally name a `sub2`. Deriving beats declaring —
    // a subcategory with no products in it is an empty shelf a shopper can click into, and that is
    // exactly what a hand-written list drifts into the moment a product moves.
    //
    // Not every category is subdivided, on purpose (owner: "לפחות בחלק מהקטגוריות"), and only ONE
    // shelf per store goes to the third level (owner, 2026-08-13: "לפחות קטגוריה אחת שיש לה תת
    // קטגוריה ב׳, כדי למצות את מה שהאתר יודע לעשות"). Both restraints are the same point: a real
    // shop splits the shelves that are big enough to need it, and `MAX_CATEGORY_DEPTH` is 3, so a
    // catalogue that never goes past 2 leaves a built feature undemonstrated. Subdividing
    // everything is what makes a catalogue feel like a filing cabinet.
    const storeCategories = spec.categories.map((name, order) => (
      { id: uuid(), storeId, name, parentId: null, order, createdAt }
    ));
    /** parentCategoryId → (childName → childId), for both derived levels. */
    const childIdByParent = new Map();
    const childOf = (parent, name) => {
      if (!childIdByParent.has(parent.id)) childIdByParent.set(parent.id, new Map());
      const kids = childIdByParent.get(parent.id);
      const existing = kids.get(name);
      if (existing) return storeCategories.find((c) => c.id === existing);
      const child = { id: uuid(), storeId, name, parentId: parent.id, order: kids.size, createdAt };
      kids.set(name, child.id);
      storeCategories.push(child);
      return child;
    };
    for (const row of CATALOGS[spec.slug]) {
      if (!row.sub) continue;
      const sub = childOf(storeCategories[row.c], row.sub);
      if (row.sub2) childOf(sub, row.sub2);
    }

    /** The LEAF a product is filed on — the deepest level it names. Filing it on a parent as well
     *  would have `countProductsPerCategory` count it twice and show it under both shelves. */
    const leafFor = (row) => {
      const top = storeCategories[row.c];
      if (!row.sub) return top.id;
      const subId = childIdByParent.get(top.id).get(row.sub);
      if (!row.sub2) return subId;
      return childIdByParent.get(subId).get(row.sub2);
    };

    const storeProducts = rows.map((row, n) => {
      // The whole gallery, in view order, skipping any that has not been generated yet. `main`
      // carries the bare key and must stay FIRST: it is what the grid cell, the cart line, the
      // order row and the ad feed all use, so it is the one that has to be legible on its own.
      const gallery = [
        manifest[`${spec.slug}:${row.n}`],
        ...PRODUCT_VIEWS.slice(1).map((v) => manifest[`${spec.slug}:${row.n}#${v.key}`]),
      ].filter(Boolean);
      if (!gallery.length) missingImages++;
      const p = {
        id: uuid(),
        storeId,
        slug: productSlug(spec.slug, n),
        name: row.n,
        description: row.d,
        price: row.p,
        // Overwritten below for a variant product, where the app's invariant is that `stock` is the
        // SUM of variantStock (see /api/product.ts patch-variant-stock). Leaving it at 0 makes every
        // storefront card read "אזל מהמלאי" while the combo picker shows plenty in stock.
        stock: rnd() < 0.06 ? 0 : int(4, 40),
        images: gallery,
        categoryId: leafFor(row),
        weightGrams: row.w,
        createdAt: cardAt(spec, row.n) ?? iso(NOW - int(1, 45) * DAY),
      };
      const variants = variantsFor(row.v);
      if (variants) {
        p.variants = variants;
        p.variantStock = buildVariantStock(variants);
        p.stock = Object.values(p.variantStock).reduce((a, b) => a + b, 0);
      }
      return p;
    });

    products.push(...storeProducts);
    categories.push(...storeCategories);

    const banner = manifest[`${spec.slug}:__banner`];
    /**
     * The generated logo IS used now (owner, 2026-08-13), and this reverses the note that stood
     * here — correctly, because what it rejected is not what exists.
     *
     * The old objection was real: asked for "a minimal abstract emblem", the model returned a
     * PHOTOGRAPH of an object — a terracotta arch, a leaf — which in a 56px circle read as a smudge
     * rather than a mark, so `StoreAvatar`'s vector monogram was strictly better. What changed is
     * the ASK. Each store now specifies a mark and a MEDIUM of its own (`identity.mjs`'s
     * `logoConcept` + `logoStyle`): a flat vector crescent, a painted panel photographed flat, a
     * rendered monogram, a brush drawing. Those are pictures OF a logo, and they hold up small.
     *
     * `StoreAvatar` keeps its monogram fallback for any store without one, so a real seller who
     * uploads nothing still gets something deliberate.
     */
    const logo = manifest[`${spec.slug}:__logo`];
    /**
     * The header lock-up — mark and name side by side, for the top bar (`identity.mjs`'s
     * `lockupUrl`). Only some stores have one, and that asymmetry is the demonstration:
     * `headerStyle` is a real seller's choice between his name as text and his own logo, so a set
     * of showcase stores where all four chose the same thing shows one of the two options.
     *
     * The pair is written together and never separately. `stores.ts#storeHeaderLogo` only returns
     * the image when `headerStyle === 'logo'`, so seeding the URL alone would store a picture that
     * nothing renders, and seeding the style alone would select an option with nothing behind it —
     * which is the state `HeaderStyleCard` disables its own radio for.
     */
    const headerLogo = manifest[`${spec.slug}:__headerlogo`];

    stores.push({
      id: storeId,
      sellerId: ownerId,
      slug: spec.slug,
      name: spec.name,
      tagline: spec.tagline,
      description: spec.description,
      colors: spec.colors,
      categories: [spec.tag],
      demo: true,
      // Both are ordinary image URLs, exactly like a real seller's upload — which is the property
      // that makes a showcase store editable from the dashboard rather than a special case. The
      // store's NAME is not baked into the banner picture; it is drawn over it as vector text by
      // StoreDemoBanner.astro, so it stays crisp at every width and survives a rename.
      bannerImage: banner,
      profileImage: logo,
      ...(headerLogo ? { headerLogo, headerStyle: 'logo' } : {}),
      shipping: { selfPickup: spec.selfPickup },
      address: spec.address,
      addressVisible: true,
      hours: weekHours(),
      hoursVisible: true,
      createdAt,
    });
    taken.add(spec.slug);

    const withImages = storeProducts.filter((p) => p.images.length).length;
    const totalShots = storeProducts.reduce((n, p) => n + p.images.length, 0);
    console.log(`   ✓ ${spec.name} (/${spec.slug}) — ${storeProducts.length} products, ${withImages} with a picture, `
      + `${totalShots} shots (${(totalShots / Math.max(1, withImages)).toFixed(1)} per product)`
      + `${banner ? '' : ', NO BANNER'}${logo ? '' : ', NO LOGO'}`);
  }

  if (!stores.length) {
    console.error('\n❌ Nothing seeded — every showcase slug is taken by a real store. Database unchanged.\n');
    process.exit(1);
  }


  await writeCatalog(db, {
    // `includeSellers: false` — the owner row is reused when it already exists, so this purge must
    // not delete it out from under the stores about to be written.
    purge: { scope: 'showcase', includeSellers: false },
    sellers, stores, categories, products,
  });

  // The ratings, last — they hang off the products this run has just written, and a reseed
  // cascade-deletes the previous set with the old products (scripts/seed-reviews.mjs says why this
  // stopped being a separate manual step). Never fatal: showcase stores with no ratings is a
  // recoverable state, stores that failed to write is not.
  try {
    await seedShowcaseReviews(db, { quiet: true });
  } catch (e) {
    console.warn(`   ⚠️  ratings not seeded (${e.message}) — run \`npm run seed:reviews\``);
  }

  console.log(`\n✅ ${stores.length} showcase store(s), ${products.length} products.`);
  if (missingImages) {
    console.log(`   ⚠️  ${missingImages} product(s) have no picture yet — run \`npm run showcase:images\` and re-seed.`);
  }
  console.log('   They are noindex, out of the sitemap/feed/IndexNow, uncheckoutable, and');
  console.log('   leave the shopper surfaces on their own once there are 5 real stores.');
  console.log(`   Platform account: ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
  console.log('   Remove with:  npm run seed:showcase -- --clean\n');
}

main().catch((e) => { console.error('showcase seed failed:', e); process.exit(1); });
