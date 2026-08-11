// One shared floating tooltip (position:fixed, body-anchored) reused by every
// hover-to-explain affordance on the site — the dashboard performance charts'
// bars, the KPI info icons, and the site-wide hover labels for icon-only
// controls (icon-tooltips.ts) — instead of one DOM node + positioning logic
// per trigger. Lived under scripts/dashboard/ until it gained non-dashboard
// callers.
// Nodes are pooled rather than singular because a chart with two lines shows two tooltips at once,
// one per point. Slot 0 is the one every other caller on the site uses; slots 1+ are created only
// when a multi-series chart is first hovered, and are hidden again the moment anything else takes
// over (see hideFrom, called by every single-tooltip entry point).
const nodes: HTMLElement[] = [];

function tooltipNode(index: number): HTMLElement {
  while (nodes.length <= index) {
    const el = document.createElement('div');
    el.className = 'dash-tooltip fixed pointer-events-none z-[400] max-w-[15rem] text-[.76rem] leading-snug font-medium text-white bg-[color:var(--color-text)] rounded-[var(--radius-sm)] py-[.35rem] px-[.6rem] shadow-[0_4px_14px_rgba(0,0,0,0.18)] opacity-0 transition-opacity duration-100';
    el.hidden = true;
    nodes.push(el);
  }
  const el = nodes[index]!;
  // Re-attach when the node has been carried out of the document. `mountTooltipIn` re-parents these
  // into a <dialog> (a body-anchored tooltip paints behind one opened with showModal), so anything
  // that removes that dialog's subtree takes the tooltip with it — and since the module still holds
  // the reference, every later tooltip ANYWHERE on the page would be written into a detached node
  // and simply never appear. Checked rather than assumed: a tooltip legitimately living inside an
  // OPEN dialog is still connected, so this leaves it exactly where it is.
  if (!el.isConnected) document.body.appendChild(el);
  return el;
}

const getTooltipEl = (): HTMLElement => tooltipNode(0);

/** Hide every pooled node from `index` up. Called by the single-tooltip entry points so moving from
 *  a two-line chart onto a bar, an info icon or another chart cannot leave a second box stranded. */
function hideFrom(index: number): void {
  for (let i = index; i < nodes.length; i++) { nodes[i]!.style.opacity = '0'; nodes[i]!.hidden = true; }
}

// `color` overrides the default dark background (e.g. a chart tooltip tinted to
// its own series colour). Cleared to '' when omitted so the shared node falls
// back to the class default for the next unrelated caller (info icons, etc.).
export function showTooltip(anchor: Element, text: string, color?: string): void {
  const el = getTooltipEl();
  el.textContent = text;
  el.style.background = color ?? '';
  el.style.opacity = '0';
  el.hidden = false;
  place(el, anchor);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  hideFrom(1);
}

/** One series' tooltip: what to say, where, and in which colour. */
export interface SeriesTip { anchor: Element; text: string; color?: string }

/**
 * SEVERAL tooltips at once — one per series, each beside its OWN point, in its own colour
 * (owner, 2026-08-11).
 *
 * The visits chart draws two lines, and a single box explaining both was the confusion: it read as
 * one sentence in one colour, and the colour was one of the two series' own. Two boxes need no
 * legend and no swatch — where each one sits, and what colour it is, already say which line it
 * belongs to.
 *
 * The one thing needing care is that they must not land on top of each other. The topmost point
 * takes the space ABOVE it and every other point takes the space below its own, which separates
 * them by construction rather than by measuring and nudging — and holds even when two series cross
 * and their values are equal.
 */
export function showSeriesTooltips(tips: SeriesTip[]): void {
  // Top-down, so "the first one goes above, the rest go below" is a statement about the screen.
  const ordered = [...tips].sort((a, b) => a.anchor.getBoundingClientRect().top - b.anchor.getBoundingClientRect().top);
  ordered.forEach((tip, i) => {
    const el = tooltipNode(i);
    el.textContent = tip.text;
    el.style.background = tip.color ?? '';
    el.style.opacity = '0';
    el.hidden = false;
    place(el, tip.anchor, i === 0 ? 'above' : 'below');
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  });
  hideFrom(ordered.length);
}

/** Centre `el` over or under `anchor`, flipping when the chosen side has no room. Shared by every
 *  element-anchored entry point so a second copy cannot drift from the first. */
function place(el: HTMLElement, anchor: Element, side: 'above' | 'below' = 'above'): void {
  const rect = anchor.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const margin = 8;
  let left = rect.left + rect.width / 2 - elRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - elRect.width - margin));
  const above = rect.top - elRect.height - 8;
  const below = rect.bottom + 8;
  let top = side === 'above' ? above : below;
  if (side === 'above' && above < margin) top = below;
  if (side === 'below' && below + elRect.height > window.innerHeight - margin) top = Math.max(margin, above);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// Position the tooltip at an arbitrary viewport point (cursor) rather than an
// element's bounding box — used by the donut slices, whose <circle> bboxes all
// resolve to the same full-ring rect, so anchoring to the element would stack
// every slice's tooltip at one spot. Follows the cursor via mousemove.
export function showTooltipAtPoint(clientX: number, clientY: number, text: string, color?: string): void {
  const el = getTooltipEl();
  el.textContent = text;
  el.style.background = color ?? '';
  el.hidden = false;
  const elRect = el.getBoundingClientRect();
  const margin = 8;
  let left = clientX - elRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - elRect.width - margin));
  let top = clientY - elRect.height - 14; // sit just above the cursor
  if (top < margin) top = clientY + 18;   // no room above — below the cursor
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  hideFrom(1);
}

export function hideTooltip(): void {
  hideFrom(0);
}

// Re-parent the shared tooltip. A tooltip triggered from inside a <dialog>
// opened with showModal() lives in the browser's top layer; a tooltip appended
// to <body> (a normal layer) paints BEHIND it and is invisible. Callers inside
// a modal mount the tooltip into the dialog while it's open, and back onto
// <body> on close. Position stays viewport-fixed (the dialog sets no transform,
// so it isn't a containing block for the fixed tooltip).
export function mountTooltipIn(parent: HTMLElement): void {
  // Every pooled node, not just slot 0: a modal that ever shows a multi-series chart would
  // otherwise leave its second tooltip behind on <body>, painting under the dialog.
  parent.appendChild(getTooltipEl());
  for (const el of nodes) parent.appendChild(el);
}

// Generic hover/focus wiring for any static "(i)" info trigger — reads its
// own explanation from data-tooltip so a new one only needs that attribute,
// no bespoke JS. dataset.tooltipBound guards against double-binding if this
// runs again after a panel re-render.
export function initInfoTooltips(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-tooltip]').forEach((el) => {
    if (el.dataset.tooltipBound === '1') return;
    el.dataset.tooltipBound = '1';
    const text = el.dataset.tooltip ?? '';
    el.addEventListener('mouseenter', () => showTooltip(el, text));
    el.addEventListener('mouseleave', () => hideTooltip());
    el.addEventListener('focus', () => showTooltip(el, text));
    el.addEventListener('blur', () => hideTooltip());
  });
}
