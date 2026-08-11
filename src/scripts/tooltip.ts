// One shared floating tooltip (position:fixed, body-anchored) reused by every
// hover-to-explain affordance on the site — the dashboard performance charts'
// bars, the KPI info icons, and the site-wide hover labels for icon-only
// controls (icon-tooltips.ts) — instead of one DOM node + positioning logic
// per trigger. Lived under scripts/dashboard/ until it gained non-dashboard
// callers.
let tooltipEl: HTMLElement | null = null;

function getTooltipEl(): HTMLElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'dash-tooltip fixed pointer-events-none z-[400] max-w-[15rem] text-[.76rem] leading-snug font-medium text-white bg-[color:var(--color-text)] rounded-[var(--radius-sm)] py-[.35rem] px-[.6rem] shadow-[0_4px_14px_rgba(0,0,0,0.18)] opacity-0 transition-opacity duration-100';
    tooltipEl.hidden = true;
  }
  // Re-attach when the node has been carried out of the document. `mountTooltipIn` re-parents this
  // singleton into a <dialog> (a body-anchored tooltip paints behind one opened with showModal),
  // so anything that removes that dialog's subtree takes the tooltip with it — and since the module
  // still holds the reference, every later tooltip ANYWHERE on the page would be written into a
  // detached node and simply never appear. Silent, and one of the failure classes this repo has
  // already paid for once. Checked rather than assumed: a tooltip legitimately living inside an
  // open dialog is still connected, so this leaves it exactly where it is.
  if (!tooltipEl.isConnected) document.body.appendChild(tooltipEl);
  return tooltipEl;
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
  positionAbove(el, anchor);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
}

/** One line of a multi-series tooltip: a swatch that matches the drawn line, then the series name
 *  and its value. `dashed` mirrors a secondary/envelope series, which is drawn dashed. */
export interface TooltipRow { label: string; value: string; color: string; dashed?: boolean }

/**
 * A tooltip explaining SEVERAL series at once — a title line, then one row per series carrying the
 * colour it is drawn in.
 *
 * It exists because the alternative was one flat sentence: the visits chart used to hand over
 * `"01/08: מבקרים ייחודיים 12 · ביקורים 40"` as a single string in a single colour, and the colour
 * it used was one of the two series' own — so both numbers appeared painted as the same thing that
 * only one of them was (owner, 2026-08-11). A multi-series tooltip therefore takes NO series
 * colour; the swatches carry that, against the neutral background both of them read on.
 *
 * **Built with createElement + textContent, never innerHTML, and that is load-bearing rather than
 * stylistic.** This same shared node is used for bar tooltips whose label is a PRODUCT NAME and for
 * donut slices likewise — seller-authored text, shown to an admin. A markup-parsing tooltip would
 * be an XSS sink reachable by typing a product name.
 */
export function showTooltipRows(anchor: Element, title: string, rows: TooltipRow[]): void {
  const el = getTooltipEl();
  el.textContent = '';
  el.style.background = '';

  if (title) {
    const head = document.createElement('div');
    head.className = 'mb-[.25rem] opacity-70';
    head.textContent = title;
    el.appendChild(head);
  }
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'flex items-center gap-[.4rem] whitespace-nowrap';
    const swatch = document.createElement('span');
    // The legend above the chart draws a 3px bar, solid or dashed — the same two marks, so the
    // tooltip is read without learning a second vocabulary.
    //
    // Lightened, and this is measured rather than taste: the tooltip's ground is `--color-text`
    // (#1c2333), and the muted series colour (#5a6478) sits at about 1.6:1 against it — a dashed
    // 2px rule nobody can see, which would have relocated the reported confusion instead of fixing
    // it. Mixed 70/30 with white both swatches clear 4.9:1, and hue is what identifies a series, so
    // lightening costs nothing that the mark is for.
    const tint = `color-mix(in srgb, ${row.color} 70%, white)`;
    swatch.className = 'inline-block w-[10px] shrink-0 rounded-full';
    swatch.style.background = row.dashed ? 'transparent' : tint;
    swatch.style.borderTop = row.dashed ? `2px dashed ${tint}` : '';
    swatch.style.height = row.dashed ? '0' : '3px';
    line.appendChild(swatch);
    const text = document.createElement('span');
    text.textContent = row.label ? `${row.label} ${row.value}` : row.value;
    line.appendChild(text);
    el.appendChild(line);
  }

  el.style.opacity = '0';
  el.hidden = false;
  positionAbove(el, anchor);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
}

/** Centre `el` above `anchor`, flipping below when there is no room. Shared by both element-anchored
 *  entry points so a second one cannot drift from the first. */
function positionAbove(el: HTMLElement, anchor: Element): void {
  const rect = anchor.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const margin = 8;
  let left = rect.left + rect.width / 2 - elRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - elRect.width - margin));
  let top = rect.top - elRect.height - 8;
  if (top < margin) top = rect.bottom + 8; // no room above — flip below the anchor
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
}

export function hideTooltip(): void {
  if (tooltipEl) { tooltipEl.style.opacity = '0'; tooltipEl.hidden = true; }
}

// Re-parent the shared tooltip. A tooltip triggered from inside a <dialog>
// opened with showModal() lives in the browser's top layer; a tooltip appended
// to <body> (a normal layer) paints BEHIND it and is invisible. Callers inside
// a modal mount the tooltip into the dialog while it's open, and back onto
// <body> on close. Position stays viewport-fixed (the dialog sets no transform,
// so it isn't a containing block for the fixed tooltip).
export function mountTooltipIn(parent: HTMLElement): void {
  parent.appendChild(getTooltipEl());
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
