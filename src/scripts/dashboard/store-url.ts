// "Store URL" editor in settings (dashboard.astro #store-url). Lets the seller change their store's
// slug; the server remembers the old slug and 301-redirects it to the new one (see /api/store.ts
// change-store-url + stores.ts renameStoreSlug), so no SEO is lost. AJAX; on success it reloads so
// every slug-derived display (top address, view-store link, custom-domain fixed address, feed URLs)
// updates at once — a deliberate exception to in-place updates, since the slug is the store identity.

import { trimDashes } from '../../lib/url-base.js';

interface UrlResponse { ok: boolean; error?: string; slug?: string }

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function errMsg(i: Record<string, string>, error?: string): string {
  switch (error) {
    case 'slug-taken':    return i.storeUrlTaken ?? 'That URL is already taken.';
    case 'reserved-slug': return i.storeUrlReservedErr ?? 'That URL is reserved.';
    default:              return i.storeUrlInvalidErr ?? 'Invalid URL.';
  }
}

const clean = (v: string) => v.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
// Runs on every keystroke against the raw input, so the quadratic `^-+|-+$` form was the one place
// this class had no accidental protection: a pasted run of dashes froze the seller's tab for
// seconds per character. url-base.ts#trimDashes scans instead. See its header.
const trimEdges = trimDashes;

export function initStoreUrl(): void {
  const root = document.getElementById('store-url');
  if (!root) return;
  const storeId = root.dataset.storeId ?? '';
  const host = root.dataset.host ?? '';
  let currentSlug = root.dataset.currentSlug ?? '';
  const i = getI18n();

  const editBtn = document.getElementById('store-url-edit') as HTMLElement | null;
  const editor  = document.getElementById('store-url-editor') as HTMLElement | null;
  const input   = document.getElementById('store-url-input') as HTMLInputElement | null;
  const preview = document.getElementById('store-url-preview');
  const saveBtn = document.getElementById('store-url-save') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('store-url-cancel');
  const msg = document.getElementById('store-url-msg') as HTMLElement | null;
  if (!editor || !input) return;

  function flash(text: string, isError = false): void {
    if (!msg) return;
    msg.textContent = text;
    msg.className = `text-[0.82rem] mt-1 py-2 px-[.85rem] rounded-[var(--radius)] ${
      isError ? 'bg-[#fef2f2] text-[color:var(--color-danger)] border border-[#fecaca]'
              : 'bg-[#f0fdf4] text-[#166534] border border-[#bbf7d0]'}`;
    msg.hidden = false;
  }

  function reflect(): void {
    const pos = input!.selectionStart;
    input!.value = clean(input!.value);
    try { input!.setSelectionRange(pos, pos); } catch { /* ignore */ }
    if (preview) preview.textContent = `${host}/${trimEdges(input!.value) || currentSlug}`;
  }

  editBtn?.addEventListener('click', () => { editor!.hidden = false; if (editBtn) editBtn.hidden = true; input!.focus(); });
  cancelBtn?.addEventListener('click', () => {
    editor!.hidden = true; if (editBtn) editBtn.hidden = false;
    input!.value = currentSlug; if (msg) msg.hidden = true;
  });
  input.addEventListener('input', reflect);

  saveBtn?.addEventListener('click', async () => {
    const slug = trimEdges(clean(input!.value));
    if (!slug) { flash(i.storeUrlInvalidErr ?? 'Invalid URL.', true); return; }
    if (slug === currentSlug) { editor!.hidden = true; if (editBtn) editBtn.hidden = false; return; }
    saveBtn.disabled = true;
    const form = new FormData();
    form.set('_action', 'change-store-url');
    form.set('storeId', storeId);
    form.set('slug', slug);
    let data: UrlResponse;
    try { const res = await fetch('/api/store', { method: 'POST', body: form }); data = await res.json() as UrlResponse; }
    catch { data = { ok: false }; }
    saveBtn.disabled = false;
    if (!data.ok) { flash(errMsg(i, data.error), true); return; }
    const newSlug = data.slug ?? slug;
    currentSlug = newSlug;

    // Update every slug-derived display in place (no reload — see file header). One sweep handles all
    // the data attributes the tab scripts read (product rows, order cards, perf/ad pickers,
    // upload-config, custom-domain); the seller APIs also tolerate the old slug (previousSlugs) for
    // any script that cached it. Then the few visible strings.
    document.querySelectorAll<HTMLElement>('[data-store-slug]').forEach((el) => { el.dataset.storeSlug = newSlug; });
    root.dataset.currentSlug = newSlug;
    const currentEl = document.getElementById('store-url-current');
    if (currentEl) currentEl.textContent = `${host}/${newSlug}`;
    input!.value = newSlug;
    if (preview) preview.textContent = `${host}/${newSlug}`;
    const addr = document.getElementById('dash-store-address');
    if (addr && addr.dataset.hasCustomDomain !== '1') addr.textContent = `/${newSlug}`;
    const viewBtn = document.getElementById('dash-view-store') as HTMLAnchorElement | null;
    if (viewBtn && (viewBtn.getAttribute('href') ?? '').startsWith('/')) viewBtn.href = `/${newSlug}`;
    const cdAddr = document.getElementById('cd-local-addr');
    if (cdAddr) cdAddr.textContent = `https://${host}/${newSlug}`;

    flash(i.storeUrlChanged ?? 'URL updated.');
    // Brief confirmation, then collapse the editor (the updated current-URL display stays as proof).
    setTimeout(() => { editor!.hidden = true; if (editBtn) editBtn.hidden = false; if (msg) msg.hidden = true; }, 1200);
  });
}
