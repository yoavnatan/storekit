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
import {
  productSeoHints,
  productSeoScore,
  needsSeoAttention,
  openProductSeoHints,
  type ProductSeoHintId,
  type ProductSeoInput,
  type ProductSeoLevel,
} from './product-seo-hints.js';

export interface ProductSeoLabels {
  heading: string;
  /** "3 מתוך 5" — {done}/{total} substituted. */
  progress: string;
  /** One word per band, because the meter's COLOUR must never be the only thing that says
   *  where the listing stands (WCAG: never colour-only state). */
  level: Record<ProductSeoLevel, string>;
  previewLabel: string;
  /** Shown in the preview when the seller hasn't written a description yet. */
  previewEmptyDesc: string;
  /** Prefix for the row gauge's tooltip, which then lists the open items: "Missing: Photo · …". */
  missing: string;
  /** Each tip is a short LABEL plus the explanation. One line of bare prose per item read as a
   *  nag; naming the field first tells the seller what it is about before why it matters. */
  hint: Record<ProductSeoHintId, { label: string; text: string }>;
}

const FALLBACK: ProductSeoLabels = {
  heading: 'Tips for search visibility',
  progress: '{done}/{total}',
  level: { weak: 'Basic', partial: 'Good', strong: 'Excellent' },
  previewLabel: 'How it looks in search',
  previewEmptyDesc: 'No description yet',
  missing: 'Missing',
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
    level: {
      weak: str(d.seoLevelWeak, FALLBACK.level.weak),
      partial: str(d.seoLevelPartial, FALLBACK.level.partial),
      strong: str(d.seoLevelStrong, FALLBACK.level.strong),
    },
    previewLabel: str(d.seoPreviewLabel, FALLBACK.previewLabel),
    previewEmptyDesc: str(d.seoPreviewEmptyDesc, FALLBACK.previewEmptyDesc),
    missing: str(d.seoMissingLabel, FALLBACK.missing),
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
      <p style="margin:0 0 0.3rem;font-size:0.74rem;color:var(--color-muted)">${escapeHtml(l.previewLabel)}</p>
      <div dir="auto" style="border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.55rem 0.7rem;background:var(--color-bg)">
        <span data-seo-preview-url style="display:block;font-size:0.72rem;color:var(--color-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(preview.host + path)}</span>
        <span data-seo-preview-title style="display:block;font-size:0.9rem;color:var(--color-accent);margin-top:0.1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(title)}</span>
        <span data-seo-preview-desc style="display:block;font-size:0.78rem;color:var(--color-muted);margin-top:0.15rem;line-height:1.45">${escapeHtml(desc)}</span>
      </div>
    </div>
  </div>`;
}

/**
 * One token per band — no new colour is invented for this meter, which is the first of the four
 * design-line tests ("is it already in the system?").
 *
 * `--color-accent` for `partial` rather than a fourth status colour: mid-fill is not a status,
 * it is the ordinary in-progress state of a form, and the accent is what this dashboard already
 * uses for "you are working on it". Amber and green keep the jobs they have everywhere else.
 */
const LEVEL_COLOR: Record<ProductSeoLevel, string> = {
  weak: 'var(--color-warning)',
  partial: 'var(--color-accent)',
  strong: 'var(--color-success)',
};

/** Everything the meter shows, resolved once. The SSR pass renders it into the shell's markup
 *  and the browser writes the same four values back onto that same markup as the seller types —
 *  so the fill ANIMATES (the element persists) and there is still only one rule for what it
 *  should say. A second computation in the script is the drift this module exists to prevent. */
export interface ProductSeoMeterView {
  percent: number;
  color: string;
  /** "3 מתוך 5" */
  progressText: string;
  /** "טוב" — the band in words, so the colour is never the only signal. */
  levelText: string;
}

export function productSeoMeterView(input: ProductSeoInput, l: ProductSeoLabels): ProductSeoMeterView {
  const score = productSeoScore(input);
  return {
    percent: score.percent,
    color: LEVEL_COLOR[score.level],
    progressText: l.progress.replace('{done}', String(score.done)).replace('{total}', String(score.total)),
    levelText: l.level[score.level],
  };
}

/**
 * The heading row + fill bar.
 *
 * Lives in the SHELL, not in `data-seo-body`: the body is replaced wholesale on every keystroke,
 * and a brand-new element has no previous width to transition from, so a bar rendered there
 * would jump rather than fill. Kept here it is one persistent element the script re-styles.
 *
 * The bar is `aria-hidden` — it is a picture of the two words beside it, and announcing a
 * progressbar as well would read the same state twice.
 */
function productSeoMeterHtml(view: ProductSeoMeterView, l: ProductSeoLabels): string {
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:0.6rem;flex-wrap:wrap">
      <p style="margin:0;font-size:0.87rem;font-weight:500">${escapeHtml(l.heading)}</p>
      <p style="margin:0;font-size:0.78rem;color:var(--color-muted);white-space:nowrap"><span data-seo-level style="font-weight:600;color:${view.color}">${escapeHtml(view.levelText)}</span> · <span data-seo-progress>${escapeHtml(view.progressText)}</span></p>
    </div>
    <div aria-hidden="true" style="margin-top:0.45rem;height:4px;border-radius:999px;background:var(--color-bg);overflow:hidden">
      <div data-seo-meter style="height:100%;border-radius:999px;width:${view.percent}%;background-color:${view.color};transition:width 0.3s ease-out,background-color 0.3s ease-out"></div>
    </div>`;
}

/** Length of the semicircle below (π × r, r = 9), pinned as a constant so the dash maths can't
 *  drift from the path if the arc is ever resized. */
const GAUGE_ARC = (Math.PI * 9).toFixed(3);
const GAUGE_PATH = 'M3 13A9 9 0 0 1 21 13';

/**
 * The products-table row marker: a small gauge, filled to the listing's score and coloured by its
 * band — the same score and the same three colours as the panel's meter, because it is the same
 * fact seen from the list.
 *
 * **It renders for `weak` rows ONLY, and that is the whole design.** A marker on every row is
 * decoration (see needsSeoAttention's own note: a catalog sitting at 4-of-5 would light up
 * completely and stop being read), so presence is the signal and the fill is the detail. It also
 * means a nearly-full amber gauge is a real state, not a bug: a listing that has everything except
 * the photo scores 4-of-5 and is still weak, because without an image it cannot be advertised at
 * all. The tooltip names what is open, so the fill is never the only thing that speaks.
 *
 * **Where it goes matters as much as what it is.** It belongs in the THUMBNAIL cell — the one
 * fixed-width column in the table, empty exactly when the commonest fault (no photo) is present,
 * and on mobile a cell that already spans the card's full height. Rendered there it adds no
 * column, no row, and no height at any width. The previous attempt at this marker lived in
 * `.name-col` (13% under `table-layout: fixed`) and was removed on 2026-08-04 because a text pill
 * wrapped to a second line and read as a fault; do not move it back there.
 *
 * No click handler of its own: the thumbnail cell already toggles the row's checkbox, and a
 * marker that quietly changed what a click does in half a cell is worse than one that doesn't.
 * The full hint list is one row-open away, in the panel this gauge summarises.
 */
export function productSeoRowGaugeHtml(input: ProductSeoInput, l: ProductSeoLabels): string {
  if (!needsSeoAttention(input)) return '';
  const score = productSeoScore(input);
  const open = openProductSeoHints(input).map((h) => l.hint[h.id].label).join(' · ');
  const label = `${l.missing}: ${open}`;
  // Dash offset, not a shortened path: one geometry for track and fill means they can never
  // disagree about where the arc runs.
  const offset = ((Number(GAUGE_ARC) * (100 - score.percent)) / 100).toFixed(3);
  return `<span class="product-seo-gauge" role="img" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" data-seo-level="${score.level}">`
    // Size pinned INLINE, all three properties, against reset.css's `img, picture, svg, video`
    // rule: `height: auto` beats a bare height attribute and flattens the arc to a hairline, and
    // `max-width: 100%` resolves against this badge's containing block — which on the ≤640px card
    // is a thumbnail cell that collapses to ZERO width when the product has no photo, i.e. exactly
    // the case the gauge is most often marking. Measured at 375px before the fix: svg width 0.
    + `<svg viewBox="0 0 24 16" width="21" height="14" style="width:21px;height:14px;max-width:none;display:block" fill="none" aria-hidden="true">`
    + `<path d="${GAUGE_PATH}" stroke="var(--color-border)" stroke-width="3" stroke-linecap="round"/>`
    + `<path d="${GAUGE_PATH}" stroke="${LEVEL_COLOR[score.level]}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${GAUGE_ARC}" stroke-dashoffset="${offset}"/>`
    + `</svg></span>`;
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
    ${productSeoMeterHtml(productSeoMeterView(input, l), l)}
    <div data-seo-body style="margin-top:0.7rem">${productSeoBodyHtml(input, preview, l)}</div>
  </section>`;
}
