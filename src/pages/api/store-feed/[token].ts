export const prerender = false;
import type { APIRoute } from 'astro';
import { getStoreByExportToken } from '../../../lib/stores.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import { getCategoriesByStoreId } from '../../../lib/store-categories.js';
import { productsToCsv, productsToFeedJson } from '../../../lib/store-products-bulk.js';

// Outbound inventory feed: another system (the seller's POS/ERP/other site) pulls THIS store's live
// catalog — including current stock — from an unguessable, login-free URL. The token in the path IS
// the credential (see /api/store.ts gen-export-token), so a bad/absent/blocked token returns a plain
// 404 with no detail (never leaks whether a token merely has the wrong value vs. no such store). The
// mirror image of the inbound sync (/api/store-product/feed-sync). Never indexed (X-Robots-Tag) and
// never cached (stock changes constantly). Rotating/clearing the token instantly kills the old URL.

export const GET: APIRoute = async ({ params, url }) => {
  const noindex = { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' };
  const store = await getStoreByExportToken(params.token ?? '');
  // `store.blocked` on purpose, NOT canStoreSell/isStoreDiscoverable: this is not a shopper or an
  // ad surface, it is the seller's own catalog flowing to the seller's own POS/ERP behind their
  // own secret token. A seller who pauses the storefront is usually pausing it BECAUSE they are
  // reorganising stock, and cutting their inventory pipe at that exact moment would be the
  // opposite of helpful. An admin block is the one state that stops it — that one is the platform
  // acting against the store, not the seller acting on their own.
  if (!store || store.blocked) return new Response('Not found', { status: 404, headers: noindex });

  const products = await getProductsByStoreId(store.id);
  const categories = await getCategoriesByStoreId(store.id);

  if (url.searchParams.get('format') === 'json') {
    const body = JSON.stringify({
      store: store.slug,
      updatedAt: new Date().toISOString(),
      products: productsToFeedJson(products, categories),
    }, null, 2);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...noindex } });
  }

  const lang = url.searchParams.get('lang') === 'he' ? 'he' : 'en';
  return new Response(productsToCsv(products, categories, lang), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${store.slug}-inventory.csv"`,
      ...noindex,
    },
  });
};
