import { esc } from '../../lib/gallery-widget.js';
import { showStatus } from './status.js';
import { applyPagination } from './products.js';
import { CSV_FIELDS, parseCsv } from '../../lib/csv-bulk.js';
import { guessMapping, buildCanonicalCsv, mappingStatus, mappingToRecord, type MappingEntry, type MappableKey } from '../../lib/feed-mapping.js';
import { buildPreviewHtml, csvErrorMessage } from './csv-preview.js';
import { scrollProductsPanelIntoView } from './scroll-utils.js';
import type { MergedRowResult } from '../../lib/variant-csv.js';

// Drives the "External inventory sync" panel (see dashboard.astro #feed-panel + feed-mapping.ts).
// Two sources feed the SAME server import routine (which matches id-less rows to existing products by
// sku): an uploaded file (client reads headers → seller maps columns → canonical CSV → /bulk) and a
// saved feed URL pulled server-side (/store-product/feed-sync). The mapping the seller confirms on an
// upload is saved to the store, so the URL pull reuses it.

function getDashI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function feedErrorMessage(i: Record<string, string>, error?: string): string {
  switch (error) {
    case 'no-feed-url':        return i.feedNoUrl ?? 'No feed URL set.';
    case 'feed-blocked-host':  return i.feedFetchBlocked ?? 'URL blocked.';
    case 'feed-bad-url':       return i.feedInvalidUrl ?? 'Invalid URL.';
    case 'feed-timeout':       return i.feedFetchTimeout ?? 'Timed out.';
    case 'feed-too-large':     return i.feedFetchTooLarge ?? 'File too large.';
    case 'feed-dns':
    case 'feed-unreachable':
    case 'feed-http-error':    return i.feedFetchFailed ?? 'Could not fetch the feed.';
    default:                   return csvErrorMessage(i, error);
  }
}

// Outbound side: create / copy / rotate / revoke the tokenized feed URL other systems pull from.
function initExportSharing(storeId: string, i: Record<string, string>): void {
  const root     = document.getElementById('feed-export');
  const genBtn    = document.getElementById('feed-export-gen') as HTMLButtonElement | null;
  const active    = document.getElementById('feed-export-active') as HTMLElement | null;
  const urlInput  = document.getElementById('feed-export-url') as HTMLInputElement | null;
  const copyBtn   = document.getElementById('feed-export-copy');
  const regenBtn  = document.getElementById('feed-export-regen') as HTMLButtonElement | null;
  const revokeBtn = document.getElementById('feed-export-revoke') as HTMLButtonElement | null;
  if (!root || !genBtn || !active || !urlInput) return;
  const base = root.dataset.feedBase ?? '';

  async function post(action: 'gen-export-token' | 'clear-export-token'): Promise<{ ok: boolean; token?: string }> {
    const form = new FormData();
    form.set('_action', action);
    form.set('storeId', storeId);
    try {
      const res = await fetch('/api/store', { method: 'POST', body: form });
      return await res.json() as { ok: boolean; token?: string };
    // silent: the caller renders `feedErrorMessage` from this.
    } catch { return { ok: false }; }
  }

  async function generate(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    const data = await post('gen-export-token');
    btn.disabled = false;
    if (!data.ok || !data.token) { showStatus(i.feedSyncFailed ?? 'Failed.', true); return; }
    urlInput!.value = base + data.token;
    genBtn!.hidden = true;
    active!.hidden = false;
  }

  genBtn.addEventListener('click', () => generate(genBtn));
  regenBtn?.addEventListener('click', () => generate(regenBtn));

  revokeBtn?.addEventListener('click', async () => {
    revokeBtn.disabled = true;
    const data = await post('clear-export-token');
    revokeBtn.disabled = false;
    if (!data.ok) { showStatus(i.feedSyncFailed ?? 'Failed.', true); return; }
    urlInput!.value = '';
    active!.hidden = true;
    genBtn!.hidden = false;
    showStatus(i.feedExportRevoked ?? 'Revoked.');
  });

  copyBtn?.addEventListener('click', async () => {
    if (!urlInput!.value) return;
    try { await navigator.clipboard.writeText(urlInput!.value); }
    catch { urlInput!.select(); document.execCommand('copy'); } // clipboard API blocked (insecure ctx) → legacy fallback
    showStatus(i.feedExportCopied ?? 'Copied.');
  });
}

export function initFeedSync(): void {
  const panel      = document.getElementById('feed-panel') as HTMLElement | null;
  const toggleBtn  = document.getElementById('toggle-feed-panel');
  const closeBtn   = document.getElementById('feed-panel-close');
  const urlInput   = document.getElementById('feed-url-input') as HTMLInputElement | null;
  const saveBtn    = document.getElementById('feed-save-btn') as HTMLButtonElement | null;
  const syncBtn    = document.getElementById('feed-sync-now-btn') as HTMLButtonElement | null;
  const fileInput  = document.getElementById('feed-file-input') as HTMLInputElement | null;
  const fileNameEl = document.getElementById('feed-file-name');
  const mappingEl  = document.getElementById('feed-mapping') as HTMLElement | null;
  const previewEl  = document.getElementById('feed-preview') as HTMLElement | null;
  const lastSyncEl = document.getElementById('feed-last-sync');
  if (!panel || !fileInput || !mappingEl || !previewEl) return;
  const panelEl = panel; // narrowed non-null capture for the async closures below

  const storeId = panel.dataset.storeId ?? '';
  const i = getDashI18n();
  const lang: 'he' | 'en' = document.documentElement.dir === 'rtl' ? 'he' : 'en';
  let savedMapping: Record<string, MappableKey> = {};
  try { savedMapping = JSON.parse(panel.dataset.feedMapping ?? '{}'); } catch { /* keep empty */ }
  let rawRows: string[][] = [];

  const renderLastSync = (): void => {
    if (!lastSyncEl) return;
    const iso = panel.dataset.lastSync;
    lastSyncEl.textContent = iso
      ? `${i.feedLastSync ?? 'Last synced:'} ${new Date(iso).toLocaleString(lang === 'he' ? 'he-IL' : 'en-US')}`
      : (i.feedNeverSynced ?? '');
  };
  renderLastSync();

  toggleBtn?.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      document.getElementById('add-product-form')?.setAttribute('hidden', '');
      document.getElementById('toggle-add-form')?.removeAttribute('hidden');
      document.getElementById('csv-panel')?.setAttribute('hidden', '');
      scrollProductsPanelIntoView(panelEl);
    }
  });
  closeBtn?.addEventListener('click', () => { panel.hidden = true; });

  // ---- Persist URL + mapping on the store (so the URL pull reuses the confirmed mapping) ----
  async function saveFeedConfig(mapping: Record<string, MappableKey>): Promise<boolean> {
    const form = new FormData();
    form.set('_action', 'save-feed-config');
    form.set('storeId', storeId);
    form.set('feedUrl', urlInput?.value.trim() ?? '');
    form.set('mapping', JSON.stringify(mapping));
    try {
      const res = await fetch('/api/store', { method: 'POST', body: form });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) { showStatus(data.error === 'invalid-url' ? (i.feedInvalidUrl ?? 'Invalid URL.') : (i.feedSyncFailed ?? 'Failed.'), true); return false; }
      savedMapping = mapping;
      return true;
    } catch { showStatus(i.feedSyncFailed ?? 'Failed.', true); return false; }
  }

  saveBtn?.addEventListener('click', async () => {
    saveBtn.disabled = true;
    if (await saveFeedConfig(savedMapping)) showStatus(i.feedSavedOk ?? 'Saved.');
    saveBtn.disabled = false;
  });

  // ---- File source: map columns, then run the shared preview/commit ----
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (fileNameEl) fileNameEl.textContent = file.name;
    rawRows = parseCsv(await file.text());
    fileInput.value = '';
    previewEl.hidden = true; previewEl.innerHTML = '';
    if (rawRows.length < 2) { mappingEl.hidden = true; showStatus(i.csvEmptyFile ?? 'The file is empty.', true); return; }
    renderMappingEditor();
  });

  function collectEntries(): MappingEntry[] {
    const headers = rawRows[0] ?? [];
    return headers.map((source, idx) => {
      const sel = mappingEl!.querySelector<HTMLSelectElement>(`select[data-src="${idx}"]`);
      return { source, key: (sel?.value || null) as MappableKey | null };
    });
  }

  function refreshWarnings(): void {
    const warnBox = mappingEl!.querySelector('#feed-map-warn');
    if (!warnBox) return;
    const st = mappingStatus(collectEntries());
    const warn = (msg: string): string =>
      `<p class="text-[0.8rem] [color:var(--color-danger)] flex items-start gap-[0.35rem]"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="shrink-0 mt-[0.1rem]" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>${esc(msg)}</span></p>`;
    warnBox.innerHTML = [
      !st.hasMatcher ? warn(i.feedNoMatcherWarn ?? '') : '',
      !st.hasStock ? warn(i.feedNoStockWarn ?? '') : '',
    ].join('');
  }

  function renderMappingEditor(): void {
    const entries = guessMapping(rawRows[0] ?? [], savedMapping);
    const options = (selected: MappableKey | null): string =>
      `<option value="">${esc(i.feedMapIgnore ?? '— ignore —')}</option>` +
      CSV_FIELDS.map((f) => `<option value="${f.key}"${f.key === selected ? ' selected' : ''}>${esc(f[lang].replace('*', '').trim())}</option>`).join('');

    const rows = entries.map((e, idx) => `
      <div class="flex items-center gap-2 py-[0.3rem]">
        <span class="flex-1 min-w-0 text-[0.82rem] [color:var(--color-text)] font-medium overflow-hidden text-ellipsis whitespace-nowrap" title="${esc(e.source)}">${esc(e.source || '—')}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 [color:var(--color-muted)] rtl:rotate-180" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        <select data-src="${idx}" class="flex-1 min-w-0 font-[inherit] text-[.82rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-[var(--radius-sm)] py-[.3rem] px-[.5rem] outline-none cursor-pointer focus:border-[color:var(--color-primary)]">${options(e.key)}</select>
      </div>`).join('');

    mappingEl!.innerHTML = `
      <div class="border-t [border-color:var(--color-border)] pt-[0.8rem]">
        <p class="text-[0.85rem] font-semibold [color:var(--color-muted)] uppercase tracking-[0.04em] mb-1">${esc(i.feedMapColumns ?? 'Column mapping')}</p>
        <p class="muted text-[0.82rem] leading-[1.5] mb-2">${esc(i.feedMapLead ?? '')}</p>
        <div class="flex items-center gap-2 pb-1 text-[0.72rem] [color:var(--color-muted)] uppercase tracking-[0.03em]">
          <span class="flex-1">${esc(i.feedMapSource ?? 'Your column')}</span><span class="w-[14px]"></span><span class="flex-1">${esc(i.feedMapTarget ?? 'Our field')}</span>
        </div>
        <div class="flex flex-col divide-y divide-[color:var(--color-border)] max-h-[280px] overflow-y-auto mb-2 pe-[0.15rem]">${rows}</div>
        <div id="feed-map-warn" class="flex flex-col gap-1 mb-2"></div>
        <button type="button" class="btn btn--sm w-full sm:w-auto" id="feed-map-continue">${esc(i.feedMapContinue ?? 'Continue')}</button>
      </div>`;
    mappingEl!.hidden = false;
    mappingEl!.querySelectorAll('select[data-src]').forEach((s) => s.addEventListener('change', refreshWarnings));
    refreshWarnings();
    mappingEl!.querySelector('#feed-map-continue')?.addEventListener('click', () => runPreview(collectEntries()));
  }

  // ---- Shared preview/commit — src is either a client-built canonical CSV (file) or the URL pull ----
  function renderPreview(results: Array<MergedRowResult>, onCommit: (btn: HTMLButtonElement) => void): void {
    previewEl!.hidden = false;
    previewEl!.innerHTML = buildPreviewHtml(results, i);
    document.getElementById('csv-cancel-btn')?.addEventListener('click', () => { previewEl!.hidden = true; previewEl!.innerHTML = ''; });
    document.getElementById('csv-confirm-btn')?.addEventListener('click', (e) => onCommit(e.currentTarget as HTMLButtonElement));
  }

  function loading(): void { previewEl!.hidden = false; previewEl!.innerHTML = `<span class="dot-pulse" role="status" aria-label="loading"><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span>`; }
  function fail(error?: string): void { previewEl!.innerHTML = `<p class="[color:var(--color-danger)] text-[0.85rem]">${esc(feedErrorMessage(i, error))}</p>`; }

  async function runPreview(entries: MappingEntry[]): Promise<void> {
    loading();
    const csv = buildCanonicalCsv(rawRows, entries);
    try {
      const res = await fetch('/api/store-product/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, csv, commit: false }),
      });
      const data = await res.json() as { ok: boolean; results?: Array<MergedRowResult>; error?: string };
      if (!data.ok) return fail(data.error);
      renderPreview(data.results ?? [], (btn) => commitFile(btn, csv, entries));
    } catch { fail(); }
  }

  async function commitFile(btn: HTMLButtonElement, csv: string, entries: MappingEntry[]): Promise<void> {
    btn.disabled = true;
    try {
      const res = await fetch('/api/store-product/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, csv, commit: true }),
      });
      const data = await res.json() as { ok: boolean };
      if (!data.ok) { showStatus(i.feedSyncFailed ?? 'Failed.', true); return; }
      await saveFeedConfig(mappingToRecord(entries)); // remember this mapping for the URL pull
      applyPagination();
      previewEl!.hidden = true; previewEl!.innerHTML = '';
      mappingEl!.hidden = true; mappingEl!.innerHTML = '';
      if (fileNameEl) fileNameEl.textContent = '';
      showStatus(i.feedSyncDone ?? 'Sync complete.');
    } catch { showStatus(i.feedSyncFailed ?? 'Failed.', true); }
    finally { btn.disabled = false; }
  }

  // ---- URL source: server pulls + applies the saved mapping ----
  syncBtn?.addEventListener('click', async () => {
    if (!urlInput?.value.trim()) { showStatus(i.feedNoUrl ?? 'No feed URL set.', true); return; }
    mappingEl.hidden = true;
    syncBtn.disabled = true;
    await saveFeedConfig(savedMapping); // persist the (possibly just-typed) URL before pulling it
    loading();
    try {
      const res = await fetch('/api/store-product/feed-sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, commit: false }),
      });
      const data = await res.json() as { ok: boolean; results?: Array<MergedRowResult>; error?: string };
      if (!data.ok) { fail(data.error); return; }
      renderPreview(data.results ?? [], (btn) => commitSync(btn));
    } catch { fail(); }
    finally { syncBtn.disabled = false; }
  });

  initExportSharing(storeId, i);

  async function commitSync(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const res = await fetch('/api/store-product/feed-sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, commit: true }),
      });
      const data = await res.json() as { ok: boolean; lastSyncAt?: string };
      if (!data.ok) { showStatus(i.feedSyncFailed ?? 'Failed.', true); return; }
      if (data.lastSyncAt) { panelEl.dataset.lastSync = data.lastSyncAt; renderLastSync(); }
      applyPagination();
      previewEl!.hidden = true; previewEl!.innerHTML = '';
      showStatus(i.feedSyncDone ?? 'Sync complete.');
    } catch { showStatus(i.feedSyncFailed ?? 'Failed.', true); }
    finally { btn.disabled = false; }
  }
}
