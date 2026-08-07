/**
 * The date-window popover shared by the admin toolbars that have one.
 *
 * It exists because there were about to be two of them. The money journal had a picker — two bare
 * date inputs — and the Alerts tab was getting one, and a second hand-rolled copy is how the two
 * screens end up disagreeing about what "this month" means, which end of an RTL row the start date
 * sits on, and whether a half-open range is allowed. One module, both callers, and the answers can
 * only be the same answer.
 *
 * It renders into `toolbar-portal.ts`'s floating panel and hands the caller `{from, to}` — it does
 * not know what a money event or an error entry is, and must not learn: each tab owns its own query
 * params and its own navigation.
 *
 * **The panel is built as an HTML string, so everything interpolated into it is an injection sink.**
 * The two date values are re-validated here even though the server already drops anything else,
 * because a sink guarded in another module is a sink guarded by a rule someone can change without
 * ever opening this file. The preset labels are module constants, never input.
 */
import { isDayISO } from './business-day.js';
import { QUICK_RANGE_PRESETS, quickRange, type QuickRangeId } from './date-range.js';
import type { FloatingPortal } from './toolbar-portal.js';

export interface RangePickerOptions {
  /** Currently applied bounds, as the server rendered them. Either may be empty. */
  from: string;
  to: string;
  /** Applied when a preset chip or "הצג" is pressed. Empty strings mean "no bound". */
  onApply: (range: { from: string; to: string }) => void;
  /** "נקה" — back to whatever the tab treats as no window of its own choosing. */
  onClear: () => void;
  /** Wording for the clear button. The journal always has SOME window (it never opens
   *  unbounded), so there "clear" means "back to the default 30 days", not "everything". */
  clearLabel?: string;
}

/** `isDayISO`, not a shape regex: `2026-02-30` has the shape and is not a day, and feeding it to a
 *  `type="date"` input silently blanks the field so the admin's current window vanishes on open. */
const isDay = (v: string | undefined): string => (v && isDayISO(v) ? v : '');

/**
 * Open the picker under `trigger`.
 *
 * A preset chip applies IMMEDIATELY and closes, rather than filling the two inputs and waiting for
 * "הצג". "היום" that still needs a second press is not the one-click answer it looks like, and the
 * whole reason the chips exist is that reaching today's data cost two calendar interactions.
 */
export function openRangePicker(portal: FloatingPortal, trigger: HTMLElement, opts: RangePickerOptions): void {
  const from = isDay(opts.from);
  const to = isDay(opts.to);

  // Each bound gets its own labelled row rather than the two sitting side by side with a dash
  // between them: a `type="date"` renders its own internal dd/mm/yyyy order, so in an RTL panel
  // nothing on screen said which of the two was the start (owner). The <label> wrapper is also
  // what gives each input an accessible name.
  const dateRow = (key: 'from' | 'to', label: string, value: string) => `
    <label class="flex items-center gap-2 mb-1.5 text-[.78rem]">
      <span class="w-[4.5rem] shrink-0 [color:var(--color-muted)]">${label}</span>
      <input type="date" data-range-${key} value="${value}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
    </label>`;

  // Which preset the current window IS, worked out by comparing it to what each preset resolves
  // to today — not remembered in a URL parameter (owner, 2026-08-07: "I have no indication which
  // one is selected"). Deriving it beats storing it: a window can also arrive from the two date
  // inputs, from a permalink, or from a URL typed by hand, and a stored `?preset=today` would go
  // on claiming "היום" the next morning, when those same dates are yesterday. Comparing the actual
  // bounds is right in every one of those cases, and cannot go stale.
  const selected = QUICK_RANGE_PRESETS.find((p) => {
    const r = quickRange(p.id);
    return r.from === from && r.to === to;
  })?.id ?? null;

  const chips = QUICK_RANGE_PRESETS.map((p) => `
    <button type="button" data-range-preset="${p.id}"${p.id === selected ? ' aria-pressed="true"' : ''}
      class="text-[.76rem] px-2.5 py-[.25rem] rounded-full border cursor-pointer transition-colors duration-[120ms] ${
        p.id === selected
          ? 'border-[color:var(--color-primary)] bg-[color:var(--color-primary)] text-white font-semibold'
          : '[border-color:var(--color-border)] [color:var(--color-text)] bg-[color:var(--color-surface)] hover:border-[color:var(--color-primary)] hover:[color:var(--color-primary)]'
      }"
    >${p.label}</button>`).join('');

  portal.open(trigger, '19rem', () => `
    <div class="px-3 pt-2 pb-2">
      <div class="text-[.72rem] [color:var(--color-muted)] mb-1.5">טווח תאריכים</div>
      <div class="flex flex-wrap gap-1.5 mb-2.5">${chips}</div>
      ${dateRow('from', 'מתאריך', from)}
      ${dateRow('to', 'עד תאריך', to)}
      <div class="flex gap-1.5 mt-2">
        <button type="button" class="btn btn--ghost btn--sm" data-range-clear style="flex:1">${opts.clearLabel ?? 'נקה'}</button>
        <button type="button" class="btn btn--accent btn--sm" data-range-apply style="flex:1">הצג</button>
      </div>
    </div>`, (p) => {
    for (const chip of p.querySelectorAll<HTMLButtonElement>('[data-range-preset]')) {
      chip.addEventListener('click', () => {
        portal.close();
        opts.onApply(quickRange(chip.dataset.rangePreset as QuickRangeId));
      });
    }
    p.querySelector('[data-range-apply]')?.addEventListener('click', () => {
      portal.close();
      // Either bound alone is a valid open-ended window — requiring both would make
      // "everything since the 1st" impossible to ask for.
      opts.onApply({
        from: p.querySelector<HTMLInputElement>('[data-range-from]')?.value ?? '',
        to: p.querySelector<HTMLInputElement>('[data-range-to]')?.value ?? '',
      });
    });
    p.querySelector('[data-range-clear]')?.addEventListener('click', () => {
      portal.close();
      opts.onClear();
    });
  });
}
