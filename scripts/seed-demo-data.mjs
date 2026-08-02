#!/usr/bin/env node
/**
 * Demo-data seeder — builds realistic Hebrew-branded stores stocked with REAL
 * products (photo + title + description + price + rating) pulled from DummyJSON,
 * a free keyless catalog API. Every product image matches its product, on a
 * clean e-commerce background — so the storefront looks like a real shop, and
 * every dashboard surface (revenue, analytics, orders) has data to render.
 *
 *   npm run seed:demo             # seed (needs internet for images)
 *   npm run seed:demo -- --clean  # remove all demo data, keep real
 *
 * Idempotent: everything it creates is tagged to demo sellers (email @demo.local).
 * A re-run purges the previous demo set first; real seller data is never touched.
 * Demo sellers all share the password `demo1234` — log in as any of them.
 *
 * **Half database, half files, and that split is the migration's own.** Sellers, stores,
 * categories, products, orders and — since the page-view modules moved — store traffic are Postgres
 * rows (DB_MIGRATION_PLAN.md stage 2, DATABASE_URL required); the favourite / wishlist counters are
 * still `data/*.json` because their modules have not moved yet, and they are seeded there so the
 * demo dashboard keeps rendering. Each half moves when its module does.
 * Until this was translated the seeder wrote four files nobody reads any more —
 * it ran, printed "✅ Demo seed complete", and created nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openSeedClient, purge, purgeOrdersOfStores, writeCatalog } from './lib/seed-db.mjs';

const ROOT = process.cwd();
const DATA = (f) => path.join(ROOT, 'data', f);
const read = (f, def) => { try { return JSON.parse(fs.readFileSync(DATA(f), 'utf8')); } catch { return def; } };
const write = (f, v) => fs.writeFileSync(DATA(f), JSON.stringify(v, null, 2));
const uuid = () => crypto.randomUUID();
const iso = (d) => new Date(d).toISOString();

const DEMO_EMAIL_SUFFIX = '@demo.local';
const DEMO_PASSWORD = 'demo1234';
const NOW = Date.now();
const DAY = 86_400_000;

let _s = 1234567;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const hashPassword = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.createHmac('sha256', salt).update(pw).digest('hex')}`; };
const slugify = (s) => s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
const comboKey = (sel) => Object.keys(sel).sort((a, b) => a.localeCompare(b)).map((k) => `${k}=${sel[k]}`).join(',');

// Variant rubrics (synthesized — DummyJSON has no variants, but we need them to
// exercise the storefront's size/colour picker + per-combo stock logic).
const V = {
  apparel: [{ name: 'מידה', options: ['S', 'M', 'L', 'XL'] }, { name: 'צבע', options: ['שחור', 'לבן', 'כחול', 'אדום'] }],
  shoes: [{ name: 'מידה', options: ['38', '39', '40', '41', '42', '43', '44'] }],
  none: [],
};
function buildVariantStock(variants) {
  if (!variants.length) return null;
  const combos = variants.reduce((acc, dim) => acc.flatMap((sel) => dim.options.map((o) => ({ ...sel, [dim.name]: o }))), [{}]);
  const out = {};
  for (const c of combos) out[comboKey(c)] = rnd() < 0.12 ? 0 : int(2, 20);
  return out;
}

// Each vertical → a Hebrew-branded set of stores + the DummyJSON categories that
// stock them. All of a vertical's categories pool together, so a store draws a
// coherent, on-theme range of real products.
//
// `tag` is the STORE-level label (Store.categories) — distinct from `hebCats`,
// which are the store's own internal product categories. It's what the /stores
// filter chips list and what the homepage groups its category shelves by; that
// grouping needs 2+ stores sharing one tag (home-feed.ts), which is why the tag
// is per-vertical and every vertical has at least two stores. Without it the
// homepage's whole middle section silently never rendered.
const VERTICALS = [
  { key: 'fashion', tag: 'אופנה', variant: 'apparel', djCats: ['mens-shirts', 'tops', 'womens-dresses'], hebCats: ['נשים', 'גברים', 'קולקציה חדשה'], stores: ['אורבן סטייל', 'קפסולה', 'לוק בוק'] },
  { key: 'shoes', tag: 'הנעלה', variant: 'shoes', djCats: ['mens-shoes', 'womens-shoes'], hebCats: ['גברים', 'נשים', 'ספורט'], stores: ['סטפ אפ', 'סול', 'פוטוור'] },
  { key: 'tech', tag: 'אלקטרוניקה', variant: 'none', djCats: ['smartphones', 'laptops', 'tablets'], hebCats: ['סמארטפונים', 'מחשבים', 'טאבלטים'], stores: ['גאדג׳ט האב', 'טק פוינט', 'פיקסל'] },
  { key: 'gadgets', tag: 'אביזרים', variant: 'none', djCats: ['mobile-accessories', 'sunglasses'], hebCats: ['אביזרים', 'משקפי שמש', 'חדש'], stores: ['אקססורי', 'סטייל אפ'] },
  { key: 'home', tag: 'לבית', variant: 'none', djCats: ['furniture', 'home-decoration'], hebCats: ['ריהוט', 'עיצוב הבית', 'טקסטיל'], stores: ['בית ונוי', 'הום דקו', 'ליבינג'] },
  { key: 'kitchen', tag: 'מטבח', variant: 'none', djCats: ['kitchen-accessories'], hebCats: ['כלי בישול', 'אחסון', 'הגשה'], stores: ['שף בית', 'קוצ׳ינה', 'טעם'] },
  { key: 'beauty', tag: 'טיפוח', variant: 'none', djCats: ['beauty', 'skin-care', 'fragrances'], hebCats: ['איפור', 'טיפוח פנים', 'בשמים'], stores: ['גלואו', 'סקין לאב', 'אורה'] },
  { key: 'jewelry', tag: 'תכשיטים', variant: 'none', djCats: ['womens-jewellery', 'mens-watches', 'womens-watches'], hebCats: ['תכשיטים', 'שעונים', 'מתנות'], stores: ['לומייר', 'אבן חן'] },
  { key: 'sports', tag: 'ספורט', variant: 'none', djCats: ['sports-accessories'], hebCats: ['כושר', 'ריצה', 'אביזרים'], stores: ['אקטיב', 'פיט זון', 'מומנטום'] },
  { key: 'bags', tag: 'תיקים', variant: 'none', djCats: ['womens-bags'], hebCats: ['תיקים', 'קלאץ׳', 'חדש'], stores: ['תיק וחצי', 'בג בוטיק'] },
  { key: 'gourmet', tag: 'מזון', variant: 'none', djCats: ['groceries'], hebCats: ['מזווה', 'טרי', 'מארזים'], stores: ['רוסט', 'טעמים', 'מכולת השכונה'] },
  { key: 'auto', tag: 'רכב', variant: 'none', djCats: ['vehicle', 'motorcycle'], hebCats: ['רכב', 'דו-גלגלי', 'אביזרים'], stores: ['מוטו', 'גראז׳'] },
  // Department stores: draw 100 distinct products from the whole catalog, so the
  // storefront's pagination (24/page) and large-grid rendering get exercised.
  { key: 'dept', tag: 'כלבו', variant: 'none', big: 100, djCats: [], hebCats: ['אלקטרוניקה', 'אופנה', 'לבית ולמטבח', 'מבצעים'], stores: ['MegaMart', 'City Market', 'The Bazaar'] },
];

const FIRST = ['נועה', 'איתי', 'שירה', 'יונתן', 'מאיה', 'דניאל', 'תמר', 'עומר', 'ליאור', 'רוני', 'אורי', 'גל', 'הדר', 'אריאל', 'ניר'];
const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'פרידמן', 'שפירא', 'אזולאי', 'דהן', 'גבאי', 'ברק'];
const CITIES = ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע', 'רעננה', 'הרצליה', 'נתניה', 'מודיעין', 'רמת גן', 'פתח תקווה'];
const STREETS = ['הרצל', 'ויצמן', 'ביאליק', 'רוטשילד', 'דיזנגוף', 'בן גוריון', 'ז׳בוטינסקי', 'הנשיא'];
const PALETTES = [['#111827', '#f97316'], ['#0f172a', '#06b6d4'], ['#1e293b', '#e11d48'], ['#14532d', '#22c55e'], ['#4c1d95', '#a855f7'], ['#7c2d12', '#f59e0b'], ['#831843', '#ec4899']];
const fullName = () => `${pick(FIRST)} ${pick(LAST)}`;

// ----------------------------------------------------------------------------
// Real products from DummyJSON (keyless). One fetch per category, cached.
// ----------------------------------------------------------------------------
const djCache = new Map();
let _warned = false;
const warn = (m) => { if (!_warned) { _warned = true; console.log(`\n⚠️  ${m}\n`); } };

// A few demo stores get a coloured product background (instead of the default
// clean white) purely for visual variety. Done via Cloudinary's on-the-fly
// `fetch` — it grabs the DummyJSON image and swaps its white for a pastel, with
// no upload. Only stores whose products aren't themselves white are tinted, so
// the make_transparent swap stays clean. Requires Cloudinary's "Fetched URL"
// delivery to be enabled (Settings → Security); if it's off we skip tinting.
const CLOUD = 'dwlzouwok';
const TINT = { 'פיקסל': 'f3e8ff', 'אבן חן': 'fbe3ef', 'בג בוטיק': 'e6efff', 'ליבינג': 'e7f5ec', 'סטייל אפ': 'fff0e3' };
const cldyTint = (url, hex) => `https://res.cloudinary.com/${CLOUD}/image/fetch/e_make_transparent:25,b_rgb:${hex},f_auto/${url}`;
async function tintWorks() {
  const sample = cldyTint('https://cdn.dummyjson.com/product-images/tops/short-frock/1.webp', 'f3e8ff');
  try { return (await fetch(sample, { method: 'GET' })).ok; } catch { return false; }
}
const SELECT = 'title,description,price,rating,stock,tags,images,thumbnail';
async function djProducts(slug) {
  if (djCache.has(slug)) return djCache.get(slug);
  let out = [];
  try {
    const r = await fetch(`https://dummyjson.com/products/category/${slug}?limit=40&select=${SELECT}`);
    if (r.ok) out = (await r.json()).products.filter((p) => p.images?.length);
    else warn(`DummyJSON HTTP ${r.status} for ${slug}`);
  } catch (e) { warn(`DummyJSON fetch failed (${e.message}) — check internet connection`); }
  djCache.set(slug, out);
  return out;
}

// The whole catalog (all ~194 products, every category) — what "department"
// stores draw from, so they can carry a large, varied range no single category
// could fill. Distinct products only; no repeats.
let _fullCatalog = null;
async function fullCatalog() {
  if (_fullCatalog) return _fullCatalog;
  try {
    const r = await fetch(`https://dummyjson.com/products?limit=0&select=${SELECT}`);
    if (r.ok) _fullCatalog = (await r.json()).products.filter((p) => p.images?.length);
  } catch (e) { warn(`DummyJSON full-catalog fetch failed (${e.message})`); }
  return (_fullCatalog ||= []);
}

// ----------------------------------------------------------------------------
const MAX_PER_STORE = 24;

/** Everything a demo run creates hangs off a `@demo.local` account, which is what makes "remove
 *  the demo set and keep every real row" one predicate rather than a judgement call. */
const DEMO_SELLERS = `email LIKE '%' || $1`;
/** @param {string} storeAlias table alias the predicate is written against ('' for an unaliased DELETE). */
const demoStores = (storeAlias = '') => `${storeAlias}seller_id IN (SELECT id FROM sellers WHERE ${DEMO_SELLERS})`;
const DEMO_STORES = demoStores();

async function main() {
  const db = await openSeedClient();
  try {
    await run(db);
  } finally {
    await db.end();
  }
}

async function run(db) {
  // What survives a purge: the stores of real sellers, and their products' slugs. Read as a query
  // rather than derived from the files, because sellers/stores/products are rows now — the JSON
  // leftovers below (orders, page views, counters) are what still has to be filtered by hand.
  const { rows: realStoreRows } = await db.query(
    `SELECT slug::text AS slug FROM stores WHERE deleted_at IS NULL AND NOT (${DEMO_STORES})`, [DEMO_EMAIL_SUFFIX],
  );
  const realSlugs = new Set(realStoreRows.map((r) => r.slug));
  const { rows: realProductRows } = await db.query(
    `SELECT p.slug::text AS slug FROM store_products p JOIN stores s ON s.id = p.store_id
      WHERE s.deleted_at IS NULL AND NOT (${demoStores('s.')})`, [DEMO_EMAIL_SUFFIX],
  );
  const realWishKeys = new Set(realProductRows.map((r) => r.slug));

  // Orders are rows now (DB_MIGRATION_PLAN.md §8 — `orders`), so the seeder no longer carries the
  // real ones through a read/filter/rewrite of `data/orders.json`. `writeCatalog` deletes exactly
  // the demo stores' orders and leaves every other order untouched, which is the same guarantee
  // the filter used to provide and one the database can actually enforce.
  const orders = [];
  // Traffic is rows now, keyed by store id — deleting the demo stores cascades to it, so unlike the
  // counters below there is nothing to carry across and rewrite.
  const pageViews = [];
  const favCounts = {}, wishCounts = {};
  for (const [k, v] of Object.entries(read('store-favorite-counts.json', {}))) if (realSlugs.has(k)) favCounts[k] = v;
  for (const [k, v] of Object.entries(read('wishlist-counts.json', {}))) if (realWishKeys.has(k)) wishCounts[k] = v;

  if (process.argv.includes('--clean')) {
    // Orders first, while the demo stores still exist to identify them by slug.
    const removedOrders = await purgeOrdersOfStores(db, DEMO_STORES, [DEMO_EMAIL_SUFFIX]);
    const removed = await purge(db, { storeWhere: DEMO_STORES, sellerWhere: DEMO_SELLERS, params: [DEMO_EMAIL_SUFFIX] });
    write('store-favorite-counts.json', favCounts); write('wishlist-counts.json', wishCounts);
    console.log(`\n🧹 Demo data removed — ${removed.stores} store(s), ${removed.sellers} account(s), ${removedOrders} order(s). Real (non-@demo.local) data preserved.\n`);
    return;
  }

  const sellers = [];
  const stores = [];
  const products = [];
  const categories = [];
  const pwHash = hashPassword(DEMO_PASSWORD);
  const usedStoreSlugs = new Set(realSlugs);
  let sellerN = 0, storeN = 0, prodTotal = 0, orderTotal = 0;
  const totalStores = VERTICALS.reduce((n, v) => n + v.stores.filter(Boolean).length, 0);
  const canTint = await tintWorks();
  console.log(`\n🌱 Seeding ${totalStores} demo stores with real product photos from DummyJSON...`);
  console.log(canTint
    ? `   ${Object.keys(TINT).length} stores get coloured product backgrounds (Cloudinary fetch is on).\n`
    : `   Coloured backgrounds skipped — enable Cloudinary "Fetched URL" (Settings → Security) to turn them on. All stores stay clean white for now.\n`);

  for (const vert of VERTICALS) {
    const catalog = vert.big ? await fullCatalog() : (await Promise.all(vert.djCats.map(djProducts))).flat();
    const limit = vert.big || MAX_PER_STORE;
    const storeNames = vert.stores.filter(Boolean);
    for (let si = 0; si < storeNames.length; si++) {
      const storeName = storeNames[si];
      process.stdout.write(`   [${storeN + 1}/${totalStores}] ${storeName} (${catalog.length} products)\n`);
      const createdAt = iso(NOW - int(30, 300) * DAY);
      const seller = { id: uuid(), email: `seller${++sellerN}${DEMO_EMAIL_SUFFIX}`, passwordHash: pwHash, createdAt, name: fullName() };
      sellers.push(seller);

      let storeSlug = slugify(storeName) || `${vert.key}-${si + 1}`;
      if (usedStoreSlugs.has(storeSlug)) storeSlug = `${vert.key}-${si + 1}`;
      usedStoreSlugs.add(storeSlug);
      const storeId = uuid();
      const [primary, accent] = pick(PALETTES);
      const priceJitter = 0.9 + rnd() * 0.3;

      // Staged, not pushed: a store with no fetched products is skipped below, and a category
      // left behind for a store that was never written is a foreign-key violation now that these
      // are rows rather than lines in a file.
      const storeCategories = vert.hebCats.map((name, order) => (
        { id: uuid(), storeId, name, parentId: null, order, createdAt }
      ));
      const catIds = storeCategories.map((c) => c.id);

      const tintHex = canTint ? TINT[storeName] : null;
      const chosen = shuffle(catalog).slice(0, limit);
      const storeProducts = [];
      chosen.forEach((dj, n) => {
        const variants = V[vert.variant];
        const price = Math.max(5, Math.round(dj.price * priceJitter));
        const images = dj.images.slice(0, 4).map((u) => tintHex ? cldyTint(u, tintHex) : u);
        const p = {
          id: uuid(), storeId, slug: `${slugify(dj.title) || 'product'}-${n + 1}`,
          name: dj.title, description: dj.description || '', price,
          stock: variants.length ? 0 : Math.max(0, dj.stock ?? int(3, 40)),
          images, categoryId: pick(catIds),
          tags: (dj.tags || []).slice(0, 5), createdAt: iso(NOW - int(1, 200) * DAY),
        };
        if (variants.length) { p.variants = variants; p.variantStock = buildVariantStock(variants); }
        storeProducts.push(p); prodTotal++;
      });
      if (!storeProducts.length) { storeN++; continue; }
      products.push(...storeProducts);
      categories.push(...storeCategories);

      stores.push({
        id: storeId, sellerId: seller.id, slug: storeSlug, name: storeName,
        tagline: pick(['איכות שפשוט מרגישים', 'הבחירה החכמה', 'קולקציה חדשה כל שבוע', 'ישר מהיצרן אליך', 'עיצוב שמדבר בעדו']),
        description: `${storeName} — מבחר ${vert.hebCats.join(', ')} באיכות גבוהה ובמשלוח מהיר לכל הארץ.`,
        colors: { primary, accent }, createdAt, categories: [vert.tag],
        bannerImage: storeProducts[0].images[0], profileImage: (storeProducts[1] || storeProducts[0]).images[0],
        shipping: { flatRate: pick([0, 19, 25, 29]), freeAbove: pick([null, 199, 249, 299]), processingDays: int(1, 3) },
        address: `${pick(STREETS)} ${int(1, 90)}, ${pick(CITIES)}`, addressVisible: true,
        hours: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, d === 'sat' ? { closed: true, open: '09:00', close: '18:00' } : { closed: false, open: '09:00', close: d === 'fri' ? '14:00' : '18:00' }])),
        hoursVisible: true,
      });
      storeN++;

      // One row per day: total loads plus the distinct visitor ids behind them. A per-store pool of
      // ids is re-sampled each day so the same visitor recurs across days — which is what makes
      // unique-over-the-month meaningfully lower than the summed daily visits, the split the
      // performance tab exists to show.
      const visitorPool = Array.from({ length: int(250, 1200) }, () => uuid().replace(/-/g, '').slice(0, 20));
      for (let d = 0; d < 30; d++) {
        if (rnd() >= 0.8) continue;
        const total = int(2, 220);
        const unique = Math.max(1, Math.min(total, Math.round(total * (0.5 + rnd() * 0.35))));
        pageViews.push({
          storeId, day: iso(NOW - d * DAY).slice(0, 10), total,
          visitors: shuffle(visitorPool).slice(0, unique),
        });
      }
      favCounts[storeSlug] = int(0, 180);
      for (const p of storeProducts) if (rnd() < 0.5) wishCounts[p.slug] = int(1, 40);

      const nOrders = int(2, 8);
      for (let o = 0; o < nOrders; o++) {
        const items = shuffle(storeProducts).slice(0, int(1, 3)).map((p) => ({ productId: p.id, productName: p.name, productSlug: p.slug, storeSlug, storeName, price: p.price, qty: int(1, 3), image: p.images[0] }));
        const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
        const shipping = subtotal > 249 ? 0 : pick([0, 25, 29]);
        const created = NOW - int(1, 120) * DAY;
        const shipped = pick(['pending', 'processing', 'shipped', 'delivered']);
        orders.push({
          buyerName: fullName(), buyerEmail: `buyer${orderTotal + 1}@example.com`, buyerPhone: `05${int(0, 9)}${int(1000000, 9999999)}`,
          buyerAddress: { city: pick(CITIES), street: `${pick(STREETS)} ${int(1, 90)}`, zip: `${int(10000, 99999)}` },
          items, storeSubtotals: { [storeSlug]: { storeName, subtotal, shipping } },
          shippingAmount: shipping, totalAmount: subtotal + shipping,
          id: uuid(), paymentStatus: 'paid', shippingStatus: shipped,
          createdAt: iso(created), updatedAt: iso(created + int(0, 5) * DAY),
          trackingNumber: shipped === 'shipped' || shipped === 'delivered' ? `IL${int(100000000, 999999999)}` : '',
        });
        orderTotal++;
      }
    }
  }

  if (!prodTotal) { console.error('\n❌ No products fetched — is there internet access? Nothing written.\n'); process.exit(1); }

  // Purge + write as one transaction (seed-db.mjs#writeCatalog): everything above was network
  // work, and a run that failed after deleting the previous set would leave the dev environment
  // with no demo data at all.
  await writeCatalog(db, {
    purge: { storeWhere: DEMO_STORES, sellerWhere: DEMO_SELLERS, params: [DEMO_EMAIL_SUFFIX] },
    sellers, stores, categories, products, orders, pageViews,
  });

  write('store-favorite-counts.json', favCounts);
  write('wishlist-counts.json', wishCounts);

  console.log(`\n✅ Demo seed complete — real product photos from DummyJSON.`);
  console.log(`   stores: +${storeN}   products: +${prodTotal}   orders: +${orderTotal}`);
  console.log(`   login as any demo seller — email sellerN@demo.local  /  password ${DEMO_PASSWORD}`);
  console.log(`   remove it all later with:  npm run seed:demo -- --clean\n`);
}

main().catch((e) => { console.error('seed failed:', e); process.exit(1); });
