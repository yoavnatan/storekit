/** The "will this product be found" block in the product form, as one HTML string.
 *
 *  Same reason as discount-field.ts: the product edit form exists TWICE — server-rendered in
 *  dashboard.astro and rebuilt client-side by scripts/dashboard/products.ts — so a block defined
 *  in only one silently disappears from the other. Defined once here, called by both.
 *
 *  **It is advice, not a gate.** Nothing here disables the save button, blocks a submit, opens an
 *  overlay, or links off the page: a seller mid-form must never be thrown out of the flow with no
 *  way back, which on mobile is how an unsaved product gets lost. It is a plain block of text in
 *  normal flow that the browser can scroll past — and one that renders CORRECT on first paint
 *  (SSR computes the same hints from the stored product), so it never flashes a wrong state.
 *
 *  Pure/isomorphic; every interpolated value is escaped. The behaviour that makes it live —
 *  recomputing as the seller types — is initProductSeoHints() in scripts/dashboard/product-seo.ts.
 */

import { escapeHtml } from './html-escape.js';
import { toSlug } from './url-base.js';
import { productSeoHints, type ProductSeoHintId, type ProductSeoInput } from './product-seo-hints.js';

export interface ProductSeoLabels {
  heading: string;
  /** "3 מתוך 5" — {done}/{total} substituted. */
  progress: string;
  previewLabel: string;
  /** Shown in the preview when the seller hasn't written a description yet. */
  previewEmptyDesc: string;
  /** Each tip is a short LABEL plus the explanation. One line of bare prose per item read as a
   *  nag; naming the field first tells the seller what it is about before why it matters. */
  hint: Record<ProductSeoHintId, { label: string; text: string }>;
}

const FALLBACK: ProductSeoLabels = {
  heading: 'Tips for search visibility',
  progress: '{done}/{total}',
  previewLabel: 'How it looks in search',
  previewEmptyDesc: 'No description yet',
  hint: {
    image: { label: 'Photo (required)', text: 'Without one it cannot be advertised' },
    name: { label: 'A specific name', text: 'What it is and who it suits — briefly' },
    description: { label: 'Short description', text: 'Two or three lines' },
    category: { label: 'Category', text: 'Pick an accurate one' },
    specs: { label: 'Technical spec', text: 'Material or fixed attributes — not variants' },
  },
};

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v : fallback;

/** Pull the labels out of the dashboard's translation bag, with English fallbacks — the same
 *  shape discountFieldLabels() uses, so the client can build them from `#i18n-data` too. */
export function productSeoLabels(d: Readonly<Record<string, unknown>>): ProductSeoLabels {
  return {
    heading: str(d.seoHeading, FALLBACK.heading),
    progress: str(d.seoProgress, FALLBACK.progress),
    previewLabel: str(d.seoPreviewLabel, FALLBACK.previewLabel),
    previewEmptyDesc: str(d.seoPreviewEmptyDesc, FALLBACK.previewEmptyDesc),
    hint: {
      image: { label: str(d.seoLabelImage, FALLBACK.hint.image.label), text: str(d.seoHintImage, FALLBACK.hint.image.text) },
      name: { label: str(d.seoLabelName, FALLBACK.hint.name.label), text: str(d.seoHintName, FALLBACK.hint.name.text) },
      description: { label: str(d.seoLabelDescription, FALLBACK.hint.description.label), text: str(d.seoHintDescription, FALLBACK.hint.description.text) },
      category: { label: str(d.seoLabelCategory, FALLBACK.hint.category.label), text: str(d.seoHintCategory, FALLBACK.hint.category.text) },
      specs: { label: str(d.seoLabelSpecs, FALLBACK.hint.specs.label), text: str(d.seoHintSpecs, FALLBACK.hint.specs.text) },
    },
  };
}

/** What the search-result preview needs beyond the hint inputs. */
export interface ProductSeoPreview {
  storeName: string;
  storeSlug: string;
  /** The stored slug on an edit; empty while adding, where it is derived from the typed name. */
  productSlug?: string;
  /** Bare host, e.g. "dezabin.co.il" — the preview shows a readable URL, not a live link. */
  host: string;
}

/** Google truncates around here; showing more would preview a snippet nobody will see. */
const PREVIEW_DESC_MAX = 160;

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const CHECK_ON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const CHECK_OFF = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>';

/**
 * The panel's INNER html — the part that changes as the seller types.
 *
 * Split from the shell so the client can replace exactly this on every keystroke without
 * touching the container (which would drop focus if the seller were inside it) and without a
 * second copy of the markup rules living in the script.
 */
export function productSeoBodyHtml(
  input: ProductSeoInput,
  preview: ProductSeoPreview,
  l: ProductSeoLabels,
): string {
  const hints = productSeoHints(input);
  const done = hints.filter((h) => h.done).length;
  const progress = l.progress.replace('{done}', String(done)).replace('{total}', String(hints.length));

  const items = hints.map((h) => {
    // Satisfied items stay listed rather than disappearing: a list that shrinks as you work
    // hides what you already got right, and the seller then can't tell "done" from "never asked".
    // Only the LABEL is struck through when done — striking the explanation too made a five-line
    // block of crossed-out prose, which reads as broken rather than as finished.
    const { label, text } = l.hint[h.id];
    const colour = h.done ? 'var(--color-muted)' : 'var(--color-text)';
    return `<li data-seo-hint="${h.id}" data-done="${h.done ? '1' : '0'}" style="display:flex;align-items:flex-start;gap:0.4rem;padding:0.2rem 0;color:${colour}">
      <span style="display:inline-flex;flex-shrink:0;margin-top:0.2rem">${h.done ? CHECK_ON : CHECK_OFF}</span>
      <span><span style="font-weight:500${h.done ? ';text-decoration:line-through;text-decoration-thickness:1px' : ''}">${escapeHtml(label)}</span>: ${escapeHtml(text)}</span>
    </li>`;
  }).join('');

  const slug = preview.productSlug || toSlug(input.name) || '';
  const path = slug ? `/${preview.storeSlug}/${slug}` : `/${preview.storeSlug}`;
  // Mirrors Seo.astro's `fullTitle` (`${title} | ${store.name}`) and its description fallback, so
  // the preview is the actual tag the page will carry rather than a nice-looking approximation.
  const title = clip(input.name.trim() ? `${input.name} | ${preview.storeName}` : preview.storeName, 70);
  const desc = input.description.trim()
    ? clip(input.description, PREVIEW_DESC_MAX)
    : l.previewEmptyDesc;

  return `<div style="display:flex;flex-wrap:wrap;gap:1.25rem;align-items:flex-start">
    <ul data-seo-hint-list style="list-style:none;margin:0;padding:0;font-size:0.82rem;line-height:1.5;min-width:11rem;flex:1 1 11rem">${items}</ul>
    <div data-seo-preview style="flex:1 1 16rem;min-width:0">
      <p style="margin:0 0 0.3rem;font-size:0.74rem;color:var(--color-muted)">${escapeHtml(l.previewLabel)} · <span data-seo-progress>${escapeHtml(progress)}</span></p>
      <div dir="auto" style="border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.55rem 0.7rem;background:var(--color-bg)">
        <span data-seo-preview-url style="display:block;font-size:0.72rem;color:var(--color-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(preview.host + path)}</span>
        <span data-seo-preview-title style="display:block;font-size:0.9rem;color:var(--color-accent);margin-top:0.1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(title)}</span>
        <span data-seo-preview-desc style="display:block;font-size:0.78rem;color:var(--color-muted);margin-top:0.15rem;line-height:1.45">${escapeHtml(desc)}</span>
      </div>
    </div>
  </div>`;
}

/**
 * The whole panel, shell included. `data-seo-panel` carries the preview context as data
 * attributes so the client can rebuild the body without re-reading the page's config.
 */
export function productSeoPanelHtml(
  input: ProductSeoInput,
  preview: ProductSeoPreview,
  l: ProductSeoLabels,
): string {
  return `<section data-seo-panel
    data-store-name="${escapeHtml(preview.storeName)}"
    data-store-slug="${escapeHtml(preview.storeSlug)}"
    data-product-slug="${escapeHtml(preview.productSlug ?? '')}"
    data-host="${escapeHtml(preview.host)}"
    class="mt-4 border-t [border-color:var(--color-border)] pt-3">
    <p style="margin:0 0 0.5rem;font-size:0.87rem;font-weight:500">${escapeHtml(l.heading)}</p>
    <div data-seo-body>${productSeoBodyHtml(input, preview, l)}</div>
  </section>`;
}
