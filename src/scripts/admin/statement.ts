import { buildAdminUrl, swapPanel, wirePanelLinks } from '../../lib/admin-nav.js';

const PANEL_ID = 'dash-panel-statement';

/**
 * The accounting statement's period controls.
 *
 * Every change is a server round trip through `swapPanel`, not a client recomputation, and that is
 * the point rather than a shortcut: the figures are five aggregates over the whole orders and
 * payouts tables, and a second implementation of them in the browser is a second answer to "what
 * did August close at". The panel is small, so the swap is cheap.
 *
 * **The CSV link is a real `<a download>` whose href is rebuilt with the period**, the same shape
 * the seller reports use and for the reasons that file records: the browser performs the download
 * itself, so it lands in Downloads with the server's filename and can be re-run from the browser's
 * own download list. A fetch-and-blob would produce a file the browser does not know it has.
 */
export function initAdminStatementPanel(): void {
  wirePanelLinks(PANEL_ID, () => initAdminStatementPanel());

  const root = document.getElementById('admin-statement-controls');
  if (!root) return;

  const monthSelect = document.getElementById('admin-statement-month') as HTMLSelectElement | null;
  const rangeWrap = document.getElementById('admin-statement-range');
  const fromInput = document.getElementById('admin-statement-from') as HTMLInputElement | null;
  const toInput = document.getElementById('admin-statement-to') as HTMLInputElement | null;

  /** The period as the controls currently express it — month, or the two dates. */
  const params = (): Record<string, string | undefined> => {
    const month = monthSelect?.value ?? '';
    if (month) return { acmonth: month };
    return { acfrom: fromInput?.value || undefined, acto: toInput?.value || undefined };
  };

  const go = (): void => { swapPanel(buildAdminUrl('statement', params()), PANEL_ID, () => initAdminStatementPanel()); };

  monthSelect?.addEventListener('change', () => {
    // Reveal the date inputs before the round trip rather than after it: picking "טווח אחר…" and
    // seeing nothing change for a beat reads as the select being broken. The swap then renders the
    // same state from the server.
    // `!hidden` and not `.hidden = true`: the row is `display:flex`, which beats the UA
    // stylesheet's `[hidden]` rule — the documented trap, and the panel renders it the same way.
    rangeWrap?.classList.toggle('!hidden', Boolean(monthSelect.value));
    if (monthSelect.value) go();
  });

  // Both dates, but only once both are filled and in order — a half-entered range is not a period,
  // and asking the server about one produces a 400 the user did nothing to deserve.
  for (const input of [fromInput, toInput]) {
    input?.addEventListener('change', () => {
      const from = fromInput?.value ?? '';
      const to = toInput?.value ?? '';
      if (from && to && from <= to) go();
    });
  }

  document.getElementById('admin-statement-print')?.addEventListener('click', () => window.print());
}
