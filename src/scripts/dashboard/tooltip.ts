// One shared floating tooltip (position:fixed, body-anchored) reused by every
// hover-to-explain affordance in the seller dashboard — the performance
// charts' bars and the KPI info icons (e.g. "conversion rate", CURRENT_TASK.md)
// — instead of one DOM node + positioning logic per trigger.
let tooltipEl: HTMLElement | null = null;

function getTooltipEl(): HTMLElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'dash-tooltip fixed pointer-events-none z-[400] max-w-[15rem] text-[.76rem] leading-snug font-medium text-white bg-[color:var(--color-text)] rounded-[6px] py-[.35rem] px-[.6rem] shadow-[0_4px_14px_rgba(0,0,0,0.18)] opacity-0 transition-opacity duration-100';
    tooltipEl.hidden = true;
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

export function showTooltip(anchor: Element, text: string): void {
  const el = getTooltipEl();
  el.textContent = text;
  el.style.opacity = '0';
  el.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const margin = 8;
  let left = rect.left + rect.width / 2 - elRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - elRect.width - margin));
  let top = rect.top - elRect.height - 8;
  if (top < margin) top = rect.bottom + 8; // no room above — flip below the anchor
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  requestAnimationFrame(() => { el.style.opacity = '1'; });
}

export function hideTooltip(): void {
  if (tooltipEl) { tooltipEl.style.opacity = '0'; tooltipEl.hidden = true; }
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
