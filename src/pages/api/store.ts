export const prerender = false;
import crypto from 'node:crypto';
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getStoresBySellerId, updateStore, addStoreBgColor, isCustomDomainTaken, renameStoreSlug, isSlugTaken, isReservedSlug, normalizeSlug } from '../../lib/stores.js';
import { renameStoreSlugInUserData } from '../../lib/user-carts.js';
import { renameStoreSlugInOrders } from '../../lib/orders.js';
import { getCustomDomainProvider, normalizeHostname } from '../../lib/custom-domain.js';
import { pingStoreChange } from '../../lib/indexnow.js';
import { sanitizeStoreCategories } from '../../lib/store-taxonomy.js';
import { parseStoreHoursForm } from '../../lib/store-hours.js';
import { sanitizeImageUrl } from '../../lib/image-url.js';
import { CSV_FIELDS } from '../../lib/csv-bulk.js';
import { normalizeStoreSale } from '../../lib/discount-input.js';
import { resolveSaleScope, resolveSaleProductScope } from '../../lib/store-sale-scope.js';
import { findSpamKeyword, spamRejectionMessage, findKeywordStuffing, stuffingRejectionMessage } from '../../lib/spam-filter.js';
import { storeSettingsRev, mergeByFieldRev, STORE_REV_FIELDS } from '../../lib/record-rev.js';
import { warmBannerDerivations } from '../../lib/image-derive.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const form = await request.formData();
  const action = String(form.get('_action') || '');

  if (action === 'save-settings') {
    const storeId = String(form.get('storeId') || '');
    const stores = await getStoresBySellerId(sellerId);
    const target = stores.find((s) => s.id === storeId) ?? stores[0];
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);

    // The picker in the dashboard is convenience; THIS is the rule. Normalizes,
    // strips unsafe wording via the shared spam word list, de-dupes and caps —
    // a hand-crafted POST gets the same treatment as the form (store-taxonomy.ts).
    // Image URLs get the same validation as product images (image-url.ts): they render
    // into `<img src>` and into off-site ad/OG creatives, so an unusable value is dropped.
    // Shaped exactly as it will be stored — the merge below compares it field by field
    // against the stored record, and a difference in shape alone would read as an edit.
    const submitted = {
      name: String(form.get('name') || '').trim(),
      tagline: String(form.get('tagline') || '').trim(),
      description: String(form.get('description') || '').trim(),
      categories: sanitizeStoreCategories(String(form.get('categories') ?? '').split(',')),
      bannerImage: sanitizeImageUrl(form.get('bannerImage')) || undefined,
      profileImage: sanitizeImageUrl(form.get('profileImage')) || undefined,
      address: String(form.get('address') ?? '').trim() || undefined,
      addressVisible: form.get('addressVisible') === 'on',
      hoursVisible: form.get('hoursVisible') === 'on',
      hours: parseStoreHoursForm(form),
      shipping: { selfPickup: form.get('selfPickup') === 'on' },
    };

    // Merge rather than overwrite — see the same treatment in api/product.ts. The fields
    // are only the ones THIS form owns (record-rev.ts), so the sale, the categories tree,
    // the domain and the feed token — each saving live from its own section — are outside
    // it entirely and can never collide with a settings save.
    const { merged, conflicts } = mergeByFieldRev({
      fields: STORE_REV_FIELDS,
      submitted,
      stored: target,
      baseline: form.get('baseRev'),
      force: String(form.get('force') || '') === '1',
    });
    if (conflicts.length) {
      return json({ ok: false, conflict: true, conflictFields: conflicts, error: 'הגדרות החנות עודכנו במקום אחר מאז שפתחת את הטופס.' }, 409);
    }

    const name = String(merged.name ?? '');
    const address = merged.address as string | undefined;
    const categories = (merged.categories ?? []) as string[];
    if (!name) return json({ ok: false, error: 'Store name is required.' }, 400);

    // Self-pickup is the seller's only shipping lever (prices are platform-set). It needs
    // a pickup address — a buyer can't collect from "nowhere" — so block enabling it blank.
    const selfPickup = (merged.shipping as { selfPickup?: boolean } | undefined)?.selfPickup === true;
    if (selfPickup && !address) return json({ ok: false, error: 'כדי לאפשר איסוף עצמי יש להזין כתובת חנות.' }, 400);

    const saved = await updateStore(target.id, {
      name,
      tagline: String(merged.tagline ?? ''),
      description: String(merged.description ?? ''),
      colors: target.colors,
      categories,
      bannerImage: merged.bannerImage as string | undefined,
      profileImage: merged.profileImage as string | undefined,
      address,
      addressVisible: merged.addressVisible === true,
      hours: merged.hours as ReturnType<typeof parseStoreHoursForm>,
      hoursVisible: merged.hoursVisible === true,
      shipping: { selfPickup },
    });
    // A NEW banner: ask Cloudinary to render its four widths now, while the seller is already
    // waiting on a save, rather than leaving the bill with whoever visits this store first. The
    // banner is the store page's LCP element, so that visitor was watching ~0.8s of render before
    // a byte moved — the same reason product images have been pre-derived since 2026-07-29, on the
    // one image that was missed (lib/image-derive.ts). Only when it actually changed: re-requesting
    // renders that already exist is a pointless burst at the CDN.
    const newBanner = merged.bannerImage as string | undefined;
    if (newBanner && newBanner !== target.bannerImage) warmBannerDerivations(newBanner);

    // Store page content changed — notify the index (fire-and-forget, no-op in dev).
    pingStoreChange(target);
    // The form stays on screen after saving, so it takes the revision it now holds —
    // without it the seller's own next save would conflict with his previous one.
    return json({ ok: true, name, rev: saved ? storeSettingsRev(saved) : '' });
  }

  // Store-wide sale — the banner copy AND the optional percent that applies to every product
  // without its own discount, saved as one record so the promise and the price can't drift
  // (see discounts.ts). The headline/subtitle are public seller copy, so they go through the
  // same spam/keyword-stuffing gate as product text before they can reach a storefront.
  if (action === 'save-store-sale') {
    const storeId = String(form.get('storeId') || '');
    const target = (await getStoresBySellerId(sellerId)).find((s) => s.id === storeId);
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);

    // Scope resolved + ownership-checked server-side; a blank/foreign category or product id
    // falls back to "whole store" rather than being stored as an unmatched filter.
    const scopeMode = String(form.get('saleScope') ?? '');
    const scope = scopeMode === 'products'
      ? await resolveSaleProductScope(target.id, String(form.get('saleProductIds') ?? '').split(','))
      : scopeMode === 'category'
        // One comma-joined field rather than repeated inputs: the picker owns a single hidden
        // input, and `resolveSaleScope` drops anything blank or not this store's anyway.
        ? await resolveSaleScope(target.id, String(form.get('saleCategoryId') ?? '').split(','))
        : undefined;

    const sale = normalizeStoreSale({
      active: form.get('saleActive') === null ? '0' : '1',
      title: form.get('saleTitle'),
      text: form.get('saleText'),
      percent: form.get('salePercent'),
      showBadge: form.get('saleBadge') === null ? '0' : '1',
      startsAt: form.get('saleStarts'),
      endsAt: form.get('saleEnds'),
    }, scope);

    if (sale?.title) {
      const spamHit = findSpamKeyword(sale.title, sale.text ?? '');
      if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
      const stuffingHit = findKeywordStuffing(sale.title, sale.text ?? '');
      if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);
    }
    // An active sale needs something to say — an empty banner would render as a blank strip.
    if (sale?.active && !sale.title) return json({ ok: false, error: 'sale-title-required' }, 400);

    await updateStore(target.id, { sale });
    // Prices/badges on every product page in this store just changed — re-notify the index.
    pingStoreChange(target);
    return json({ ok: true, sale: sale ?? null });
  }

  // Products tab → "add to the running sale". Widens the SAME sale record rather than writing
  // per-product discounts, so the seller's one campaign stays one campaign. Only meaningful for a
  // product-scoped sale: a store-wide or category-wide one already covers whatever it covers, and
  // pinning it to a product list here would silently NARROW it.
  if (action === 'add-to-store-sale') {
    const storeId = String(form.get('storeId') || '');
    const target = (await getStoresBySellerId(sellerId)).find((s) => s.id === storeId);
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);
    const sale = target.sale;
    if (!sale?.active) return json({ ok: false, error: 'no-active-sale' }, 400);
    if (!sale.productIds?.length) return json({ ok: false, error: 'sale-not-product-scoped' }, 400);

    const requested = String(form.get('productIds') ?? '').split(',');
    const scope = await resolveSaleProductScope(target.id, [...sale.productIds, ...requested]);
    if (!scope?.productIds?.length) return json({ ok: false, error: 'No products selected.' }, 400);

    await updateStore(target.id, { sale: { ...sale, productIds: scope.productIds } });
    pingStoreChange(target);
    // No per-product discount changed, so every row's own chip stays as it was.
    return json({ ok: true, count: scope.productIds.length, applied: [] });
  }

  if (action === 'save-feed-config') {
    const storeId = String(form.get('storeId') || '');
    const target = (await getStoresBySellerId(sellerId)).find((s) => s.id === storeId);
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);

    // Empty = clear the saved URL. A non-empty value must at least be an http(s) URL — the deep
    // SSRF/reachability validation happens at pull time (feed-fetch.ts), not here.
    const url = String(form.get('feedUrl') ?? '').trim();
    if (url && !/^https?:\/\//i.test(url)) return json({ ok: false, error: 'invalid-url' }, 400);

    // Only keep entries whose target is a real canonical field — never trust the client-sent key.
    const validKeys = new Set<string>(CSV_FIELDS.map((f) => f.key));
    const mapping: Record<string, string> = {};
    try {
      const raw = JSON.parse(String(form.get('mapping') ?? '{}')) as Record<string, unknown>;
      for (const [src, key] of Object.entries(raw)) {
        if (typeof key === 'string' && validKeys.has(key)) mapping[String(src)] = key;
      }
    } catch { /* malformed mapping → save just the URL */ }

    await updateStore(target.id, {
      feedSync: { ...target.feedSync, url: url || undefined, mapping },
    });
    return json({ ok: true });
  }

  if (action === 'gen-export-token' || action === 'clear-export-token') {
    const storeId = String(form.get('storeId') || '');
    const target = (await getStoresBySellerId(sellerId)).find((s) => s.id === storeId);
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);
    // 192-bit random — the token is the only credential guarding the outbound feed, so it must be
    // long enough to be unguessable. Regenerating (gen on an existing token) rotates it, instantly
    // invalidating the URL the seller shared before.
    const token = action === 'gen-export-token' ? crypto.randomBytes(24).toString('hex') : undefined;
    await updateStore(target.id, { feedExportToken: token });
    return json({ ok: true, token });
  }

  if (action === 'add-bg-color') {
    const storeId = String(form.get('storeId') || '');
    const color = String(form.get('color') || '').trim().toLowerCase();
    // Only a 6-digit hex is ever stored — never trust the client-sent value.
    if (!/^#[0-9a-f]{6}$/.test(color)) return json({ ok: false, error: 'Invalid color.' }, 400);
    const target = (await getStoresBySellerId(sellerId)).find((s) => s.id === storeId);
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);
    const colors = await addStoreBgColor(target.id, color);
    return json({ ok: true, colors });
  }

  // ── Custom domain (see custom-domain.ts + middleware.ts) — seller connects/verifies/removes their
  //    own domain. The local /<slug> path is unaffected throughout: it stays live + canonical. ──
  if (action === 'set-custom-domain' || action === 'check-custom-domain' || action === 'remove-custom-domain') {
    const storeId = String(form.get('storeId') || '');
    const target = (await getStoresBySellerId(sellerId)).find((s) => s.id === storeId);
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);
    const provider = getCustomDomainProvider();

    if (action === 'remove-custom-domain') {
      if (target.customDomain) await provider.remove(target.customDomain.hostname);
      await updateStore(target.id, { customDomain: undefined });
      return json({ ok: true });
    }

    if (action === 'check-custom-domain') {
      if (!target.customDomain) return json({ ok: false, error: 'no-domain' }, 400);
      const { status } = await provider.checkStatus(target.customDomain.hostname);
      if (status !== target.customDomain.status) {
        await updateStore(target.id, { customDomain: { ...target.customDomain, status } });
      }
      return json({ ok: true, status });
    }

    // set-custom-domain — normalize + validate (rejects the platform's own domain), then register
    // with the provider so it can issue SSL. Stored as 'pending' until verification confirms it.
    const hostname = normalizeHostname(String(form.get('hostname') || ''));
    if (!hostname) return json({ ok: false, error: 'invalid-domain' }, 400);
    // A custom domain must be globally unique — another store already claiming it would make routing
    // ambiguous (getStoreByCustomDomain is first-match). Reject before registering with the provider.
    if (await isCustomDomainTaken(hostname, target.id)) return json({ ok: false, error: 'domain-taken' }, 409);
    const { ok, verification, error } = await provider.register(hostname);
    if (!ok) return json({ ok: false, error: error || 'register-failed' }, 502);
    await updateStore(target.id, { customDomain: { hostname, status: 'pending', addedAt: new Date().toISOString() } });
    return json({ ok: true, hostname, verification });
  }

  // ── Change store URL (slug) — SEO-safe: the old slug is remembered and 301-redirects to the new
  //    one (see stores.ts renameStoreSlug + the store/product routes), and slug-keyed data is migrated. ──
  if (action === 'change-store-url') {
    const storeId = String(form.get('storeId') || '');
    const target = (await getStoresBySellerId(sellerId)).find((s) => s.id === storeId);
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);

    const newSlug = normalizeSlug(String(form.get('slug') || ''));
    if (!newSlug) return json({ ok: false, error: 'invalid-slug' }, 400);
    if (newSlug === target.slug) return json({ ok: true, slug: newSlug });        // no-op
    if (isReservedSlug(newSlug)) return json({ ok: false, error: 'reserved-slug' }, 409);
    if (await isSlugTaken(newSlug, target.id)) return json({ ok: false, error: 'slug-taken' }, 409);

    const oldSlug = target.slug;
    const updated = await renameStoreSlug(target.id, newSlug);
    if (!updated) return json({ ok: false, error: 'Store not found.' }, 404);
    // Migrate the durable slug-keyed buyer state (cart lines + the recently-visited list) and notify
    // the index. Page-view history is NOT in that list any more, and neither are saved stores or
    // wishlist entries: all three are keyed by id, so a rename cannot split them and there is
    // nothing to move (DB_MIGRATION_PLAN.md §5).
    await renameStoreSlugInUserData(oldSlug, newSlug);
    // Awaited, not fired and forgotten: it is two UPDATEs in a transaction now, and returning 200
    // before it lands means the seller's dashboard can reload on the new slug while its orders are
    // still under the old one — an empty orders tab, and a swallowed error if it fails.
    await renameStoreSlugInOrders(oldSlug, newSlug);
    pingStoreChange(updated);
    return json({ ok: true, slug: newSlug });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
