/**
 * Keeps the "will this product be found" panel true while the seller types.
 *
 * The panel's markup is built by lib/product-seo-field.ts — the same function the server used to
 * render it — so this file re-runs that builder and swaps the body. There is deliberately no
 * second copy of the rules here: a hint the script computed differently from the SSR pass is
 * exactly the drift the shared builder exists to prevent.
 *
 * **Never interrupts.** It only rewrites a block of static text: no focus stealing, no scrolling,
 * no overlay, no disabled controls, nothing that could strand a seller mid-form (which on mobile
 * means a half-typed product with no way back). The panel it writes into contains no focusable
 * element, so replacing it on a keystroke cannot move the caret out of the field being typed in.
 *
 * Delegated at the document, so a form the products table rebuilds (search/sort/paging) is
 * covered with no re-init — the same reason the other dashboard editors delegate.
 */

import { productSeoBodyHtml, productSeoLabels, productSeoMeterView, type ProductSeoLabels, type ProductSeoPreview } from '../../lib/product-seo-field.js';
import type { ProductSeoInput } from '../../lib/product-seo-hints.js';

/** The dashboard strings live under `.dashboard` in `#i18n-data` — the same accessor shape
 *  products.ts uses. Reading the bag's root instead silently yields English fallbacks in a
 *  Hebrew UI, which is the failure mode `tests/dashboard-i18n.test.ts` exists to catch. */
function labels(): ProductSeoLabels {
  let bag: Record<string, unknown> = {};
  try { bag = JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; } catch { /* fall through to English */ }
  return productSeoLabels(bag);
}

/**
 * Read the live product out of whichever form the panel sits in.
 *
 * Counts what the seller can SEE, not what is stored: an image just added to the gallery widget
 * (and not yet saved) already counts, because the advice has to describe the product they are
 * looking at. Every selector here matches markup both renderers emit.
 */
function readForm(form: HTMLFormElement): ProductSeoInput {
  const value = (name: string): string => {
    const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    return el ? el.value : '';
  };
  // The gallery widget keeps one hidden input per image (lib/gallery-widget.ts), which is what
  // both the add and the edit form submit — so counting them counts unsaved additions too.
  const imageCount = form.querySelectorAll('input[name="images"]').length;
  // A spec row only counts once it has a label; a blank pair is dropped server-side too
  // (product-form.ts#parseSpecs), so counting them would promise a hint the save then undoes.
  const specCount = [...form.querySelectorAll<HTMLInputElement>('input[name="specs_label"]')]
    .filter((el) => el.value.trim()).length;
  return {
    name: value('name'),
    description: value('description'),
    imageCount,
    hasCategory: !!value('categoryId').trim(),
    specCount,
  };
}

function previewOf(panel: HTMLElement): ProductSeoPreview {
  return {
    storeName: panel.dataset.storeName ?? '',
    storeSlug: panel.dataset.storeSlug ?? '',
    productSlug: panel.dataset.productSlug || undefined,
    host: panel.dataset.host ?? '',
  };
}

let cached: ProductSeoLabels | null = null;

/**
 * The meter is UPDATED, never rebuilt — the fill has to keep the element it already had or the
 * width transition has nothing to animate from (see productSeoMeterHtml's note). Every value
 * written here comes out of productSeoMeterView(), the same function that rendered the markup
 * on the server, so there is no second definition of the bands or their colours.
 */
function paintMeter(panel: HTMLElement, input: ProductSeoInput, l: ProductSeoLabels): void {
  const view = productSeoMeterView(input, l);
  const fill = panel.querySelector<HTMLElement>('[data-seo-meter]');
  if (fill) {
    fill.style.width = `${view.percent}%`;
    fill.style.backgroundColor = view.color;
  }
  const level = panel.querySelector<HTMLElement>('[data-seo-level]');
  if (level) {
    level.textContent = view.levelText;
    level.style.color = view.color;
  }
  const progress = panel.querySelector<HTMLElement>('[data-seo-progress]');
  if (progress) progress.textContent = view.progressText;
}

function refresh(panel: HTMLElement): void {
  const form = panel.closest('form');
  const body = panel.querySelector<HTMLElement>('[data-seo-body]');
  if (!form || !body) return;
  cached ??= labels();
  const input = readForm(form);
  body.innerHTML = productSeoBodyHtml(input, previewOf(panel), cached);
  paintMeter(panel, input, cached);
}

function refreshFrom(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const form = target.closest('form');
  const panel = form?.querySelector<HTMLElement>('[data-seo-panel]');
  if (panel) refresh(panel);
}

export function initProductSeoHints(): void {
  // `input` covers typing and most widget writes; `change` catches the category picker and the
  // gallery, which set values programmatically. Both are cheap — the work is one innerHTML swap
  // of a few hundred bytes, no layout read, no network — so there is nothing to debounce.
  document.addEventListener('input', (e) => refreshFrom(e.target));
  document.addEventListener('change', (e) => refreshFrom(e.target));
}

/** Repaint every panel currently in the DOM — for after the products table rebuilds its rows,
 *  where the new forms carry a server-shaped body that has never seen the seller's live edits. */
export function refreshProductSeoPanels(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-seo-panel]').forEach(refresh);
}
