export const prerender = false;
import type { APIRoute } from 'astro';
import { getStoreBySlugOrPrevious, canStoreSell } from '../../../lib/stores.js';
import { getProductBySlug, isProductVisible, getEffectiveStock } from '../../../lib/store-products.js';
import { resolvePrice } from '../../../lib/discounts.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';

/** A cart lives in the buyer's browser and can sit there for days. Prices do not: a seller can
 *  start a sale, end one, or change a price while an item waits in a cart. This re-prices those
 *  lines from the catalog so the cart and the checkout summary show what `/api/checkout` will
 *  actually charge — the alternative is a shopper reading one number and being billed another,
 *  which is the single worst thing this feature could produce.
 *
 *  Read-only and public: it returns nothing a shopper can't already see on the product page.
 *  Deliberately NOT /api/store-product in a loop — that endpoint records a product VIEW and a
 *  funnel `view_item` event, so re-pricing a cart through it would fabricate traffic on every
 *  page load.
 */

/** A cart with more lines than this isn't a cart. Caps the work one request can ask for. */
const MAX_LINES = 200;

interface PriceRequestLine {
  storeSlug?: unknown;
  slug?: unknown;
  /** Which variant combo this cart line holds. Stock lives per combo, so without it a variant
   *  line can only be answered from the shared pool — which is the wrong number for it. */
  selectedVariants?: unknown;
}

export interface CartPriceRow {
  storeSlug: string;
  slug: string;
  /** What the buyer would pay right now. Absent `gone`, this is authoritative for display. */
  price: number;
  /** Pre-discount price — present only while the line is discounted. */
  basePrice?: number;
  /** Units available for THIS line right now (the variant combo's bucket when the request named
   *  one, else the shared pool). Present only when the request identified the line precisely
   *  enough to answer it — a client that sends no variants gets no stock for a variant product,
   *  because the shared-pool number would be a wrong ceiling rather than a missing one.
   *
   *  Lets the cart correct itself at a moment of attention instead of at the pay button: the
   *  quantity stepper stops offering units that no longer exist, and a line that sold out says
   *  so before the buyer has filled in anything. /api/checkout's own atomic check remains the
   *  guarantee — this only stops the common case from reaching it. */
  stock?: number;
  /** Echoed back so the client can match this row to the exact cart line it asked about. */
  selectedVariants?: Record<string, string>;
  /** The product or its store is no longer purchasable (deleted, hidden, blocked). The client
   *  leaves the line's price alone in that case: checkout will refuse it with a real message,
   *  which is clearer than a price silently changing to something meaningless. */
  gone?: true;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const read = await readJsonBody<{ items?: unknown }>(request, BODY_LIMIT.collection);
  if (!read.ok) return json({ ok: false, error: read.status === 413 ? 'Body too large' : 'Invalid JSON body' }, read.status);
  const body = read.value;

  const lines = Array.isArray(body.items) ? body.items.slice(0, MAX_LINES) : [];

  const items: CartPriceRow[] = [];
  for (const raw of lines) {
    const line = raw as PriceRequestLine;
    const storeSlug = typeof line.storeSlug === 'string' ? line.storeSlug.trim() : '';
    const slug = typeof line.slug === 'string' ? line.slug.trim() : '';
    if (!storeSlug || !slug) continue;
    // An EMPTY object counts as "no combo named", not as a combo: it resolves to the shared pool,
    // which for a variant product is a different line's number. Treating it as absent is what
    // keeps the withholding rule below from being bypassed by `selectedVariants: {}`.
    const named = line.selectedVariants && typeof line.selectedVariants === 'object' && !Array.isArray(line.selectedVariants)
      ? line.selectedVariants as Record<string, string>
      : undefined;
    const selectedVariants = named && Object.keys(named).length ? named : undefined;

    // Tolerates a renamed store the same way checkout does, so an older cart still re-prices.
    const store = await getStoreBySlugOrPrevious(storeSlug);
    // canStoreSell, not merely "reachable": a line from a store that stopped selling is
    // reported `gone`, exactly like a deleted product, so the drawer stops quoting a price
    // checkout would refuse a moment later.
    const product = store && canStoreSell(store) ? await getProductBySlug(store.id, slug) : null;
    if (!product || !isProductVisible(product)) {
      items.push({ storeSlug, slug, price: 0, gone: true });
      continue;
    }

    // The exact resolution /api/checkout uses — one source of truth for what a line costs.
    const view = resolvePrice(product, store!.sale);
    // Same bucket /api/checkout will decrement (getEffectiveStock is what resolves it there too).
    // Withheld for a variant product the request didn't identify: answering from the shared pool
    // would hand the client a ceiling that belongs to a different line.
    const answersStock = !product.variants?.length || !!selectedVariants;
    items.push({
      storeSlug,
      slug,
      price: view.price,
      ...(view.isDiscounted ? { basePrice: view.basePrice } : {}),
      ...(answersStock ? { stock: Math.max(0, getEffectiveStock(product, selectedVariants)) } : {}),
      ...(selectedVariants ? { selectedVariants } : {}),
    });
  }

  return json({ ok: true, items });
};
