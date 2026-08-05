export const prerender = false;
import type { APIContext } from 'astro';
import { getStoreBySlug } from '../../../../lib/stores.js';
import { parseStoreImageFile, ROUND_ICON_FORMATS, STORE_RENDER_FORMATS } from '../../../../lib/store-image.js';
import { renderStoreMarkIconPng, renderStoreMarkPng } from '../../../../lib/store-mark-raster.js';
import { storeMark } from '../../../../lib/store-mark.js';

/**
 * `/api/store-image/<slug>/<format>.png` — the generated store mark, rendered at
 * one of the fixed sizes in `STORE_RENDER_FORMATS`: the four ad/share ratios, plus
 * the two browser icon slots a store page's own favicon uses.
 *
 * This is what makes "a store always has an image" true rather than aspirational:
 * a seller who never uploads anything still resolves to a real, correctly-sized
 * PNG on a public URL that Meta, Google and every social scraper can fetch. See
 * store-image.ts for who links here.
 *
 * Unauthenticated by design (so is every consumer), and bounded on both axes:
 * the format must be one from the whitelist, and the slug must be a real store —
 * an open size parameter would let anyone ask the server to rasterise arbitrarily
 * large images.
 *
 * The tab icon comes out ROUND with transparent corners (`ROUND_ICON_FORMATS`);
 * every other format is the full opaque tile. Why each is what it is, including
 * why the iOS touch icon is deliberately NOT round, is in store-image.ts.
 *
 * Fully deterministic output for a given slug, hence `immutable`: a slug rename
 * produces a different URL, so a stale cache entry can't show the wrong mark.
 */
export async function GET({ params }: APIContext): Promise<Response> {
  const format = parseStoreImageFile(params.file ?? '');
  if (!format) return new Response('Not found', { status: 404 });

  const store = await getStoreBySlug(params.slug ?? '');
  if (!store) return new Response('Not found', { status: 404 });

  const { width, height } = STORE_RENDER_FORMATS[format];
  const mark = storeMark(store.slug, store.name);
  const png = (ROUND_ICON_FORMATS as readonly string[]).includes(format)
    ? renderStoreMarkIconPng(mark, width)
    : renderStoreMarkPng(mark, width, height);

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
