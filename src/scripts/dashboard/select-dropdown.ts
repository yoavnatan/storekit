import { createFloatingPortal } from '../../lib/toolbar-portal.js';
import { escapeHtml as escHtml } from '../../lib/html-escape.js';

// Upgrades a native <select> into a site-design dropdown backed by the shared
// floating portal (createFloatingPortal): the menu stays pinned to its trigger
// on scroll and is viewport-clamped so it never runs off the page — the two
// things a raw <select>'s native popup can't guarantee inside the dashboard's
// scrollable panels (CURRENT_TASK.md, advertising tab).
//
// The native <select> is kept in the DOM (display:none via [hidden]) as the
// single source of truth: it still holds the value and still submits with the
// form, so the existing advertising.ts logic (reads `.value`, listens to
// `change`) is untouched — a portal pick sets `select.value` and fires a real
// `change` event. Programmatic value changes (e.g. audience auto-fill) don't
// fire `change`, so the caller must call refreshSelectDropdown() to re-sync the
// visible trigger label.

let counter = 0;

const SYNC_EVENT = 'select-dropdown:sync';

// Default trigger = a full-width, form-field-sized control (advertising selects).
const DEFAULT_TRIGGER_CLASS =
  'group w-full flex items-center justify-between gap-2 py-[0.65rem] px-[0.8rem] border [border-color:var(--color-border)] rounded-[var(--radius)] [background:var(--color-bg)] font-[inherit] text-[inherit] [color:var(--color-text)] cursor-pointer text-start transition-colors duration-[120ms] hover:border-[color:var(--color-primary)] aria-expanded:border-[color:var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-[1px] focus-visible:outline-[color:var(--color-primary)]';

// Compact pill — matches the .table-toolbar-btn sort/filter chips so a select
// can sit inline in a dashboard toolbar row (page-size, CURRENT_TASK 2).
export const COMPACT_TRIGGER_CLASS =
  'group inline-flex items-center gap-[.35rem] py-[.35rem] px-[.7rem] border [border-color:var(--color-border)] rounded-full [background:var(--color-surface)] font-[inherit] text-[.82rem] [color:var(--color-text)] cursor-pointer transition-colors duration-[120ms] hover:border-[color:var(--color-primary)] aria-expanded:border-[color:var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-[1px] focus-visible:outline-[color:var(--color-primary)]';

export function initSelectDropdown(select: HTMLSelectElement, opts: { triggerClassName?: string; triggerLabel?: string; menuAutoWidth?: boolean; menuHeading?: string; optionMeta?: (value: string) => string } = {}): void {
  if (select.dataset.dropdownBound) return;
  select.dataset.dropdownBound = '1';

  const portalId = `select-portal-${select.id || 'sel'}-${counter++}`;
  const portal = createFloatingPortal(portalId);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = opts.triggerClassName ?? DEFAULT_TRIGGER_CLASS;
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const labelSpan = document.createElement('span');
  labelSpan.className = 'overflow-hidden text-ellipsis whitespace-nowrap';
  trigger.appendChild(labelSpan);
  trigger.insertAdjacentHTML(
    'beforeend',
    '<svg class="shrink-0 transition-transform duration-150 ease-out group-aria-expanded:rotate-180" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
  );

  // Native control stays for value + form submission, just visually removed.
  select.hidden = true;
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;
  select.insertAdjacentElement('afterend', trigger);

  // A fixed triggerLabel keeps the button text constant (e.g. an action label like
  // "Change method") instead of mirroring the selected option — the selected value is
  // then shown elsewhere by the caller. Omit it for the default value-mirroring behavior.
  function syncLabel(): void {
    const value = select.selectedOptions[0]?.textContent ?? '';
    labelSpan.textContent = opts.triggerLabel ?? value;
    // The native control is hidden and aria-hidden, so ITS aria-label reaches nobody — this
    // trigger is what assistive tech actually meets, and its whole content is the bare value
    // ("20"). Carrying the name over, with the value after it, is the difference between
    // "20, button" and "show per page 20, button". Re-applied on every sync so the announced
    // value never lags the visible one.
    const name = select.getAttribute('aria-label');
    if (name) trigger.setAttribute('aria-label', `${name} ${value}`.trim());
  }
  syncLabel();

  /** A non-interactive heading row for the popup. Carries no `data-value` and no `option` role, so
   *  neither `wire()` nor keyboard option-nav can land on it. Exists because a compact trigger
   *  shows only its value: opened on a phone, a page-size popup was four bare numbers with nothing
   *  saying what they counted, and the visible label beside the trigger is hidden at that width. */
  function headingHtml(): string {
    if (!opts.menuHeading) return '';
    return `<div role="presentation" class="px-3 pt-[.3rem] pb-[.35rem] text-[.72rem] font-semibold uppercase tracking-[.04em] [color:var(--color-muted)] whitespace-nowrap">${escHtml(opts.menuHeading)}</div>`;
  }

  function buildHtml(): string {
    return headingHtml() + Array.from(select.options)
      .map((o) => {
        const selected = o.value === select.value;
        // optionMeta adds trailing secondary text shown only in the popup (e.g. a price),
        // never in the trigger label — the trigger keeps mirroring the plain option text.
        const meta = opts.optionMeta?.(o.value) ?? '';
        const metaHtml = meta ? `<span class="shrink-0 text-[.8125rem] [color:var(--color-muted)]">${escHtml(meta)}</span>` : '';
        return `<button type="button" role="option" aria-selected="${selected}" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-surface)]" data-value="${escHtml(o.value)}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">${escHtml(o.textContent ?? '')}</span>${metaHtml}</button>`;
      })
      .join('');
  }

  function wire(p: HTMLElement): void {
    p.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.value ?? '';
        portal.close();
        if (v !== select.value) {
          select.value = v;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        syncLabel();
      });
    });
  }

  trigger.addEventListener('click', () => {
    if (portal.currentTrigger() === trigger) { portal.close(); return; }
    const w = trigger.offsetWidth;
    portal.open(trigger, `${w}px`, buildHtml, wire);
    // open() measures the menu at its INTRINSIC width first — a long option (e.g.
    // "רציף (עד עצירה ידנית)") stretches it wider than the trigger despite the
    // min-width — and positions against that, so it opens offset to the side and
    // only the next scroll's reposition snapped it back (user-reported). Pin the
    // width to the trigger and re-align the start edge right now (mirroring the
    // portal's own RTL-aware left math), so it's correct on open. The ellipsis on
    // each option keeps the text inside this pinned width.
    const el = document.getElementById(portalId);
    if (!el) return;
    const a = trigger.getBoundingClientRect();
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const margin = 8;
    // menuAutoWidth: widen the menu to fit the longest option's FULL text (each option is
    // overflow-hidden, so its span reports the untruncated width via scrollWidth), clamped
    // to the viewport — lets a small trigger open a popup that shows every option in full,
    // no ellipsis. Default: pin to the trigger width (compact triggers where clipping is ok).
    let menuW = w;
    if (opts.menuAutoWidth) {
      // Sum every span in the option (label + optional meta/price + the gap between them),
      // plus the option's px-3 padding (~24px), the portal's p-[.3rem] (~10px) and a small
      // buffer — so the fully-measured content never clips by a few pixels into an ellipsis.
      el.querySelectorAll<HTMLElement>('[role="option"]').forEach((opt) => {
        let content = 0;
        opt.querySelectorAll<HTMLElement>('span').forEach((s, i) => { content += Math.ceil(s.scrollWidth) + (i ? 8 : 0); });
        menuW = Math.max(menuW, content + 40);
      });
      // The heading is measured too, or the menu sizes itself to the options alone and clips the
      // very label that was added to explain them. It has no inner span, so it is measured directly.
      const heading = el.querySelector<HTMLElement>('[role="presentation"]');
      if (heading) menuW = Math.max(menuW, Math.ceil(heading.scrollWidth) + 40);
      menuW = Math.min(menuW, window.innerWidth - 2 * margin);
    }
    el.style.width = `${menuW}px`;
    let left = rtl ? a.right - menuW : a.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuW - margin));
    el.style.left = `${left}px`;

    // Open ON the current value, not at the top. The portal caps itself at 320px and scrolls
    // (toolbar-portal.ts), which is invisible for a five-option list and wrong for a long one: the
    // pager's page-select can hold forty options, and opening it on page 37 used to show pages
    // 1–10 and leave the seller to scroll for the one they are already on. `nearest` so a short
    // list — where the selected option is on screen anyway — does not move at all.
    const selected = el.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selected && el.scrollHeight > el.clientHeight) selected.scrollIntoView({ block: 'nearest' });
  });

  // Keep the visible label in step with both a real user `change` and a
  // programmatic value set the caller announces via refreshSelectDropdown().
  select.addEventListener('change', syncLabel);
  select.addEventListener(SYNC_EVENT, syncLabel);
}

/** Re-sync a dropdown's visible trigger after the caller sets `select.value`
 *  programmatically (which does not fire `change`). No-op if the select was
 *  never upgraded. */
export function refreshSelectDropdown(select: HTMLSelectElement | null): void {
  select?.dispatchEvent(new Event(SYNC_EVENT));
}
