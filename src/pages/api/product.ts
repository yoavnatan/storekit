export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
// One definition of "is this store / this product this seller's" — shared with the dashboard's
// no-JS fallback handlers, which is where it was missing entirely (lib/store-ownership.ts).
import { ownedProduct, ownedStore } from '../../lib/store-ownership.js';
import { createProduct, updateProduct, deleteProduct, getProductsByStoreId, isSkuTaken, countStockAlerts, type StoreProduct } from '../../lib/store-products.js';
import { LOW_STOCK_THRESHOLD, generateCombos, comboKey, comboStockRows, isFullyPerCombo, sumComboOverrides } from '../../lib/variant-combo.js';
import { parseImages, parseCategoryId, parseSku, parseBrand, parseWeight, parseTags, parseSpecs, parseSellerNote, parseVariantsPayload, parseProductDiscount } from '../../lib/product-form.js';
import { normalizeProductDiscount } from '../../lib/discount-input.js';
import { getCategoryById, getCategoriesByStoreId, categoryPath } from '../../lib/store-categories.js';
import { deleteNotificationsByRelatedIds } from '../../lib/notifications.js';
import { findSpamKeyword, spamRejectionMessage, findKeywordStuffing, stuffingRejectionMessage } from '../../lib/spam-filter.js';
import { productFieldsOverLimit, fieldLimitRejectionMessage } from '../../lib/field-limits.js';
import { pingProductChange, pingProductsChanged } from '../../lib/indexnow.js';
import { warmImageDerivations } from '../../lib/image-derive.js';
import { deriveAutoTags } from '../../lib/tag-suggest.js';
import { productEditRev, mergeByFieldRev, PRODUCT_REV_FIELDS } from '../../lib/record-rev.js';

// Auto-tag a product from its structured, curated fields (category path +
// variant option values) at save time — the seller's explicit tags always come
// first and win on de-dupe; auto tags only ADD. Runs AFTER the spam/stuffing
// gate (which guards the seller's own text) since these sources are already
// validated structured data, so they can't trip a false stuffing rejection.
function withAutoTags(sellerTags: string[], categoryPathStr: string, variantValues: string[]): string[] {
  const auto = deriveAutoTags({ categoryPath: categoryPathStr, variantValues, existingTags: sellerTags });
  return [...sellerTags, ...auto];
}

function allVariantValues(variants: { options: string[] }[]): string[] {
  return variants.flatMap((v) => v.options);
}

// Values in `next` not already present in `prev` (case-insensitive) — the
// variant options genuinely NEW to an edit, so auto-tagging only fires for
// them. This is what lets a seller REMOVE an auto tag on edit and have it stay
// removed: a source that hasn't changed contributes no auto tag the second time.
function newVariantValues(prev: string[], next: string[]): string[] {
  const seen = new Set(prev.map((v) => v.trim().toLowerCase()));
  return next.filter((v) => !seen.has(v.trim().toLowerCase()));
}

/**
 * The product's overall `stock`, given what the form submitted and the per-combo buckets.
 *
 * Two meanings, and which one applies is decided by the data, not by the caller:
 *
 *  · **Every combo has its own bucket** → the shared pool sells nothing, so the total IS the sum of
 *    the buckets and the submitted field is ignored. The dashboard already shows it that way
 *    (`syncTotalStockField` locks the input and live-sums the rows); add and full-edit were the
 *    paths that still trusted the field, which is how a product could store a total contradicting
 *    its own breakdown — reachable by a hand-made POST, and by any client rendering the form
 *    without that script.
 *  · **Some combo has no bucket** → those combos sell from the shared pool, and the submitted
 *    number IS that pool. It is a real quantity the seller owns and nothing else records it.
 *
 * `variantStock` is deliberately partial (variant-combo.ts#comboStockRows) — that is what lets a
 * seller count the combos they actually know and leave the rest pooled.
 */
function resolveTotalStock(
  submitted: number,
  variants: { name: string; options: string[] }[],
  variantStock: Record<string, number>,
): number {
  if (variants.length && isFullyPerCombo(variants, variantStock)) return sumComboOverrides(variantStock);
  return Number.isNaN(submitted) ? 0 : Math.max(0, submitted);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Never trust a client-supplied categoryId at face value — confirm it's a real
// node belonging to this exact store before it's allowed onto the product.
async function resolveCategoryId(raw: string, storeId: string): Promise<string | undefined> {
  if (!raw) return undefined;
  const category = await getCategoryById(raw);
  return category && category.storeId === storeId ? category.id : undefined;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const form = await request.formData();
  const action = String(form.get('_action') || '');

  if (action === 'add-product') {
    const storeId = String(form.get('storeId') || '');
    const ownerStore = await ownedStore(sellerId, storeId);
    if (!ownerStore) return json({ ok: false, error: 'Not authorized' }, 403);

    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();
    const price = parseFloat(String(form.get('price') || '0'));
    const stock = parseInt(String(form.get('stock') || '0'), 10);
    const images = parseImages(form);
    const categoryId = await resolveCategoryId(parseCategoryId(form), storeId);
    const tags = parseTags(form);
    const sku = parseSku(form);
    const brand = parseBrand(form);
    const specs = parseSpecs(form);
    const sellerNote = parseSellerNote(form);
    const discount = parseProductDiscount(form, price);
    const { variants, variantStock, variantImages, error: variantsError } = parseVariantsPayload(form);

    if (variantsError) return json({ ok: false, error: variantsError }, 400);
    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);
    if (sku && await isSkuTaken(storeId, sku)) return json({ ok: false, error: 'This SKU is already used by another product.' }, 400);
    // `brand` joins the gate for the same reason name/description/tags are in it: it is seller
    // free text that reaches a public surface (Product JSON-LD + the ad feed), so it is one more
    // place to stuff keywords onto the shared domain.
    // Length, before content. The spam and stuffing filters below judge what the text SAYS; this
    // bounds how much of it there is, which nothing did until 2026-08-12 (lib/field-limits.ts).
    // It runs first so a megabyte of text is refused without being scanned word by word.
    const tooLong = productFieldsOverLimit({ name, description, brand, tags, sku, sellerNote });
    if (tooLong) return json({ ok: false, error: fieldLimitRejectionMessage(tooLong) }, 400);
    const spamHit = findSpamKeyword(name, description, brand, ...tags);
    if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
    const stuffingHit = findKeywordStuffing(name, description, brand, ...tags);
    if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);

    const catPathStr = categoryId ? categoryPath(await getCategoriesByStoreId(storeId), categoryId) : '';
    const finalTags = withAutoTags(tags, catPathStr, allVariantValues(variants));

    const product = await createProduct(storeId, {
      name, description, price, stock: resolveTotalStock(stock, variants, variantStock),
      images: images.length ? images : undefined,
      categoryId,
      tags: finalTags.length ? finalTags : undefined,
      sku: sku || undefined,
      brand: brand || undefined,
      weightGrams: parseWeight(form),
      specs: specs.length ? specs : undefined,
      discount,
      sellerNote: sellerNote || undefined,
      variants: variants.length ? variants : undefined,
      variantStock: Object.keys(variantStock).length ? variantStock : undefined,
      variantImages: Object.keys(variantImages).length ? variantImages : undefined,
    });
    // A brand-new public page — the highest-value IndexNow signal (fire-and-forget).
    pingProductChange(ownerStore, product.slug);
    // Every image here is new, so render them at the widths buyers will ask for
    // now rather than making the first one to open the gallery wait for it.
    warmImageDerivations(images);
    return json({ ok: true, product: { ...product, rev: productEditRev(product) }, stockAlerts: await countStockAlerts(storeId, LOW_STOCK_THRESHOLD) });
  }

  if (action === 'edit-product') {
    const productId = String(form.get('productId') || '');
    const claim = await ownedProduct(sellerId, productId);
    if (!claim.ok) return claim.reason === 'not-found'
      ? json({ ok: false, error: 'Product not found.' }, 404)
      : json({ ok: false, error: 'Not authorized.' }, 403);
    const { product, store: productStore } = claim;

    const submittedPrice = parseFloat(String(form.get('price') || '0'));
    const submittedStock = parseInt(String(form.get('stock') || '0'), 10);
    // Destructured rather than spread: a rejection is not a FIELD of the product, and spreading it
    // into `submitted` would hand `mergeByFieldRev` a key that has no stored counterpart. Rejected
    // before the merge, so an over-limit payload never reaches the conflict machinery either.
    const { variants: submittedVariants, variantStock: submittedVariantStock, variantImages: submittedVariantImages, error: variantsError } = parseVariantsPayload(form);
    if (variantsError) return json({ ok: false, error: variantsError }, 400);
    // Shaped exactly like the stored record (empty → absent), because these values are
    // compared field-by-field against it below — a difference in shape alone would read
    // as an edit the seller never made.
    const submitted = {
      name: String(form.get('name') || '').trim(),
      description: String(form.get('description') || '').trim(),
      price: submittedPrice,
      stock: isNaN(submittedStock) ? 0 : submittedStock,
      images: parseImages(form),
      categoryId: await resolveCategoryId(parseCategoryId(form), product.storeId),
      tags: parseTags(form),
      sku: parseSku(form) || undefined,
      brand: parseBrand(form) || undefined,
      weightGrams: parseWeight(form),
      specs: parseSpecs(form),
      discount: parseProductDiscount(form, submittedPrice),
      sellerNote: parseSellerNote(form) || undefined,
      variants: submittedVariants,
      variantStock: submittedVariantStock,
      variantImages: submittedVariantImages,
    };

    // The form submits every field, so a stale tab would revert whatever a second tab
    // saved meanwhile. Merge instead of overwrite: fields this tab actually edited win,
    // fields it merely carried keep what is stored, and only a field BOTH sides changed
    // is worth interrupting the seller for (record-rev.ts).
    // The single-field inline edits below need none of this — each expresses one explicit
    // intent ("set stock to 4"), with no untouched fields riding along.
    const { merged, conflicts } = mergeByFieldRev({
      fields: PRODUCT_REV_FIELDS,
      submitted,
      stored: product,
      baseline: form.get('baseRev'),
      force: String(form.get('force') || '') === '1',
    });
    if (conflicts.length) {
      return json({ ok: false, conflict: true, conflictFields: conflicts, error: 'המוצר עודכן במקום אחר מאז שפתחת את הטופס.' }, 409);
    }

    const name = String(merged.name ?? '');
    const description = String(merged.description ?? '');
    const price = Number(merged.price);
    const stock = Number(merged.stock);
    const images = (merged.images ?? []) as string[];
    const categoryId = merged.categoryId as string | undefined;
    const tags = (merged.tags ?? []) as string[];
    const sku = (merged.sku ?? '') as string;
    const brand = (merged.brand ?? '') as string;
    const specs = (merged.specs ?? []) as ReturnType<typeof parseSpecs>;
    const sellerNote = (merged.sellerNote ?? '') as string;
    const discount = merged.discount as StoreProduct['discount'];
    const variants = (merged.variants ?? []) as ReturnType<typeof parseVariantsPayload>['variants'];
    const variantStock = (merged.variantStock ?? {}) as Record<string, number>;
    const variantImages = (merged.variantImages ?? {}) as Record<string, string>;

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);
    if (sku && await isSkuTaken(product.storeId, sku, productId)) return json({ ok: false, error: 'This SKU is already used by another product.' }, 400);
    // Same gate as add-product. It has to be repeated here rather than hoisted: this path validates
    // the MERGED record (per-field rev merge above), which is what actually gets written — an
    // oversized field can arrive on an edit that did not itself send that field.
    const tooLong = productFieldsOverLimit({ name, description, brand, tags, sku, sellerNote });
    if (tooLong) return json({ ok: false, error: fieldLimitRejectionMessage(tooLong) }, 400);
    const spamHit = findSpamKeyword(name, description, brand, ...tags);
    if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
    const stuffingHit = findKeywordStuffing(name, description, brand, ...tags);
    if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);

    // Per-combo SKUs are set only via CSV import; the editor doesn't render them, so preserve the
    // product's existing ones — but drop any whose combo no longer exists after an options edit
    // (a renamed/removed option changes the comboKey), so a stale code can't leak onto a new combo.
    const validComboKeys = new Set(generateCombos(variants).map(comboKey));
    const keptVariantSku = Object.fromEntries(
      Object.entries(product.variantSku ?? {}).filter(([key]) => validComboKeys.has(key)),
    );

    // On edit, auto-tag only from sources NEW since the last save — a category
    // that just changed, and variant options just added — so a seller who
    // removed an auto tag whose source is unchanged keeps it removed.
    const catChanged = (categoryId ?? '') !== (product.categoryId ?? '');
    const catPathStr = catChanged && categoryId ? categoryPath(await getCategoriesByStoreId(product.storeId), categoryId) : '';
    const freshVariantValues = newVariantValues(allVariantValues(product.variants ?? []), allVariantValues(variants));
    const finalTags = withAutoTags(tags, catPathStr, freshVariantValues);

    const updates: Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>> = {
      name, description, price, stock: resolveTotalStock(stock, variants, variantStock),
      images,
      categoryId,
      tags: finalTags.length ? finalTags : [],
      sku: sku || undefined,
      brand: brand || undefined,
      // From the merge, not from the form: another tab may have set a weight this tab never saw,
      // and re-sending this tab's blank would silently clear it (record-rev.ts).
      weightGrams: (merged.weightGrams as number | undefined) || undefined,
      specs: specs.length ? specs : [],
      discount,
      sellerNote: sellerNote || undefined,
      variants: variants.length ? variants : [],
      variantStock: Object.keys(variantStock).length ? variantStock : undefined,
      variantSku: Object.keys(keptVariantSku).length ? keptVariantSku : undefined,
      variantImages: Object.keys(variantImages).length ? variantImages : undefined,
    };

    const updated = await updateProduct(productId, updates);
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    // Only the images this edit ADDED — a re-save that didn't touch the gallery
    // must not re-request renders the CDN already holds.
    warmImageDerivations(images.filter((u) => !(product.images ?? []).includes(u)));
    // The seller just reviewed/re-entered this product's stock as part of the
    // full edit form — treat that as acknowledging any low-stock/out-of-stock
    // alert for it, same as an order's status change clearing its own notification.
    await deleteNotificationsByRelatedIds([productId], sellerId);
    // The public page's title, description, price and images just changed — the same reason a
    // brand-new product is submitted. Missing here until 2026-08-05 while the docs claimed every
    // product update pinged: the feed and sitemap self-refresh (built per request), but nothing
    // TOLD anyone, so an edit waited for an organic crawl. The slug is `updated`'s, not the
    // stored one — a rename moves the page.
    pingProductChange(productStore, updated.slug);
    const categoryPathStr = updated.categoryId ? categoryPath(await getCategoriesByStoreId(product.storeId), updated.categoryId) : '';
    // The edit row stays in the DOM after a save, so it gets the revision it now
    // holds — otherwise a second save from the same open row would report a conflict
    // against the seller's own first one.
    return json({ ok: true, rev: productEditRev(updated), images: updated.images ?? [], categoryId: updated.categoryId ?? '', categoryPath: categoryPathStr, discount: updated.discount ?? null, stockAlerts: await countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
  }

  if (action === 'patch-product-fields') {
    const productId = String(form.get('productId') || '');
    const claim = await ownedProduct(sellerId, productId);
    if (!claim.ok) return claim.reason === 'not-found'
      ? json({ ok: false, error: 'Product not found.' }, 404)
      : json({ ok: false, error: 'Not authorized.' }, 403);
    const { product, store: productStore } = claim;

    const patch: Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>> = {};
    if (form.has('name')) {
      const name = String(form.get('name') || '').trim();
      if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
      const spamHit = findSpamKeyword(name);
      if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
      const stuffingHit = findKeywordStuffing(name);
      if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);
      patch.name = name;
    }
    if (form.has('price')) {
      const price = parseFloat(String(form.get('price')));
      if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);
      patch.price = price;
    }
    if (form.has('stock')) {
      const stock = parseInt(String(form.get('stock')), 10);
      // Compare-and-set. `stock` is an ABSOLUTE write, and it is the only inline field the server
      // itself also changes — /api/checkout decrements it on every sale. A seller who types 20 over
      // a cell that displayed 19 is describing a shelf that no longer exists if a purchase landed in
      // between, and the plain write would resurrect the sold unit (and let it be sold twice). So
      // the figure the cell DISPLAYED rides along, and a stored value that moved since refuses the
      // write and hands back the truth. Absent `prevStock` (an older client) the write proceeds —
      // additive, per the zero-downtime rule. The full edit form needs none of this: `stock` is in
      // PRODUCT_REV_FIELDS, so mergeByFieldRev above already answers 409 for exactly this case.
      const prevRaw = form.get('prevStock');
      if (prevRaw != null) {
        const prev = parseInt(String(prevRaw), 10);
        if (!isNaN(prev) && prev !== product.stock) {
          return json({
            ok: false,
            conflict: true,
            conflictFields: ['stock'],
            currentStock: product.stock,
            error: `המלאי השתנה ל-${product.stock} מאז שפתחת את השדה (כנראה נמכר בינתיים). עדכנו לפי המספר החדש.`,
          }, 409);
        }
      }
      patch.stock = isNaN(stock) ? 0 : Math.max(0, stock);
    }
    if (form.has('sku')) {
      const sku = parseSku(form);
      if (sku && await isSkuTaken(product.storeId, sku, productId)) return json({ ok: false, error: 'This SKU is already used by another product.' }, 400);
      patch.sku = sku || undefined;
    }

    const updated = await updateProduct(productId, patch);
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    // Only clear when the stock cell itself was the one edited — a name/price/sku
    // inline edit shouldn't silently dismiss an unrelated low-stock alert.
    if ('stock' in patch) await deleteNotificationsByRelatedIds([productId], sellerId);
    // An inline cell edit changes name/price — both of which the product page and the feed
    // publish, so it is as public a change as the full form's.
    pingProductChange(productStore, updated.slug);
    // The partial-save actions return the new revision so the open edit row — which the
    // client patches field-by-field to match — stays in step and doesn't report the
    // seller's own inline edit as a conflict.
    return json({ ok: true, rev: productEditRev(updated), product: { name: updated.name, price: updated.price, stock: updated.stock, sku: updated.sku ?? '' }, stockAlerts: await countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
  }

  // Inline edit of a single variant combo's stock from the products-table
  // breakdown dropdown — the per-combo mirror of `patch-product-fields`' whole
  // `stock` edit. Writes a bucket for THAT combo only: the combos the seller did
  // not touch keep selling from the shared pool, which is what `variantStock`
  // being a partial map has always meant (variant-combo.ts#comboStockRows).
  if (action === 'patch-variant-stock') {
    const productId = String(form.get('productId') || '');
    const claim = await ownedProduct(sellerId, productId);
    if (!claim.ok) return claim.reason === 'not-found'
      ? json({ ok: false, error: 'Product not found.' }, 404)
      : json({ ok: false, error: 'Not authorized.' }, 403);
    const { product } = claim;
    if (!product.variants?.length) return json({ ok: false, error: 'Product has no variants.' }, 400);

    const key = String(form.get('comboKey') || '');
    const validKeys = new Set(generateCombos(product.variants).map(comboKey));
    if (!validKeys.has(key)) return json({ ok: false, error: 'Unknown variant combination.' }, 400);
    const value = parseInt(String(form.get('stock')), 10);
    const clamped = isNaN(value) ? 0 : Math.max(0, value);

    // Only the edited combo gets a bucket. This used to materialise the FULL map first — every
    // sibling combo written out at an even split of the shared pool — so editing one row silently
    // asserted a count for every other row the seller never touched, and any combo that had been
    // selling from the pool was pinned to a number nobody entered.
    const map = { ...(product.variantStock ?? {}) };
    // Same compare-and-set as the whole-product stock above, on the one combo being written: a sale
    // of THIS combo between render and save would otherwise be undone by the absolute number the
    // seller typed. `effective` is what the row displayed — its own bucket, or the shared pool it
    // reads from — so the comparison is against the number the seller was actually looking at.
    const prevRaw = form.get('prevStock');
    if (prevRaw != null) {
      const prev = parseInt(String(prevRaw), 10);
      const current = comboStockRows(product.variants, product.variantStock, product.stock)
        .find((r) => r.key === key)?.effective ?? 0;
      if (!isNaN(prev) && prev !== current) {
        return json({
          ok: false,
          conflict: true,
          conflictFields: ['stock'],
          comboKey: key,
          currentStock: current,
          error: `המלאי של הווריאנט הזה השתנה ל-${current} מאז שפתחת את השדה (כנראה נמכר בינתיים). עדכנו לפי המספר החדש.`,
        }, 409);
      }
    }
    map[key] = clamped;

    // The overall number keeps meaning what it means everywhere else: the sum of the buckets once
    // every combo has one, and otherwise the shared pool the uncounted combos still sell from —
    // left exactly as it was, because this edit said nothing about it.
    const total = isFullyPerCombo(product.variants, map) ? sumComboOverrides(map) : product.stock;

    const updated = await updateProduct(productId, { variantStock: map, stock: total });
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    await deleteNotificationsByRelatedIds([productId], sellerId);
    return json({ ok: true, rev: productEditRev(updated), comboKey: key, comboStock: clamped, stock: total, stockAlerts: await countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
  }

  if (action === 'patch-product-images') {
    const productId = String(form.get('productId') || '');
    const images = parseImages(form);
    if (!productId) return json({ ok: false, error: 'Missing productId.' }, 400);
    const claim = await ownedProduct(sellerId, productId);
    if (!claim.ok) return claim.reason === 'not-found'
      ? json({ ok: false, error: 'Product not found.' }, 404)
      : json({ ok: false, error: 'Not authorized.' }, 403);
    const { product, store: productStore } = claim;
    const updated = await updateProduct(productId, { images });
    warmImageDerivations(images.filter((u) => !(product.images ?? []).includes(u)));
    // The gallery IS the listing to a shopping surface — image_link is what the feed leads with.
    if (updated) pingProductChange(productStore, updated.slug);
    return json({ ok: true, rev: updated ? productEditRev(updated) : undefined, images: updated?.images ?? [] });
  }

  if (action === 'set-product-visibility') {
    const productId = String(form.get('productId') || '');
    const claim = await ownedProduct(sellerId, productId);
    if (!claim.ok) return claim.reason === 'not-found'
      ? json({ ok: false, error: 'Product not found.' }, 404)
      : json({ ok: false, error: 'Not authorized.' }, 403);
    const { product, store: visStore } = claim;
    // A seller can only flip their own take-down flag; an admin `blocked` product
    // stays hidden regardless (isProductVisible gates on both).
    const hidden = String(form.get('hidden') || '') === '1';
    const updated = await updateProduct(productId, { hidden });
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    // Indexability just changed (show → wants indexing / hide → drop) — notify.
    pingProductChange(visStore, updated.slug);
    // Taking a product off the shelf resolves any outstanding stock alert for it —
    // the seller has consciously decided it's not for sale, so nagging about its
    // stock would be exactly the noise this feature removes.
    if (hidden) await deleteNotificationsByRelatedIds([productId], sellerId);
    return json({ ok: true, hidden: updated.hidden === true, stockAlerts: await countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
  }

  // Apply (or clear) the same discount across many products at once — the "run a sale on
  // these 12 items" flow, driven by the products table's existing bulk selection. Each row is
  // normalized against ITS OWN price, so one ₪-off never zeroes out the cheapest product in the
  // batch; a blank/zero value clears instead of storing an inert discount.
  if (action === 'bulk-discount') {
    const storeId = String(form.get('storeId') || '');
    const ownerStore = await ownedStore(sellerId, storeId);
    if (!ownerStore) return json({ ok: false, error: 'Not authorized' }, 403);

    const ids = String(form.get('productIds') || '').split(',').map((v) => v.trim()).filter(Boolean);
    if (!ids.length) return json({ ok: false, error: 'No products selected.' }, 400);
    const clear = String(form.get('clear') || '') === '1';

    // Scope the ids to this store's own products — an id from another seller's store is
    // dropped here rather than reaching updateProduct.
    const owned = new Map((await getProductsByStoreId(storeId)).map((p) => [p.id, p]));
    const targets = ids.map((id) => owned.get(id)).filter((p): p is StoreProduct => !!p);
    if (!targets.length) return json({ ok: false, error: 'No products selected.' }, 400);

    const applied: Array<{ id: string; discount: StoreProduct['discount'] | null }> = [];
    for (const p of targets) {
      const discount = clear ? undefined : normalizeProductDiscount({
        type: form.get('discount_type'),
        value: form.get('discount_value'),
        showBadge: form.get('discount_badge') === null ? '0' : '1',
        startsAt: form.get('discount_starts'),
        endsAt: form.get('discount_ends'),
      }, p.price);
      await updateProduct(p.id, { discount });
      applied.push({ id: p.id, discount: discount ?? null });
    }
    // Price is the single attribute a shopping surface re-checks most, so a markdown nobody is
    // told about is the least useful kind of silence. One submission for the whole batch.
    pingProductsChanged(ownerStore, targets.map((p) => p.slug));
    return json({ ok: true, count: applied.length, applied });
  }

  if (action === 'delete-product') {
    const productId = String(form.get('productId') || '');
    const claim = await ownedProduct(sellerId, productId);
    if (!claim.ok) return claim.reason === 'not-found'
      ? json({ ok: false, error: 'Product not found.' }, 404)
      : json({ ok: false, error: 'Not authorized.' }, 403);
    const { product, store: productStore } = claim;
    await deleteProduct(productId);
    // Submitting a URL that is now GONE is correct IndexNow usage, not a mistake: the point is to
    // get it recrawled, and what the crawler finds is a 404 — which is how it leaves the index.
    // Without this a deleted product goes on being offered in results, and in AI shopping answers,
    // until an organic crawl happens to trip over it. Read the slug BEFORE the row is gone.
    pingProductChange(productStore, product.slug);
    return json({ ok: true, stockAlerts: await countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
