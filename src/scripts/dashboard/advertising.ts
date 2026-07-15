import { formatPrice } from '../../config/store.config.js';
import { showStatus } from './status.js';

interface CampaignStats { impressions: number; clicks: number; ctr: number; spend: number; roas: number }
interface Campaign {
  id: string; scope: 'store' | 'product'; productName?: string;
  platform: 'google' | 'meta'; monthlyBudget: number; status: 'active' | 'paused';
  stats: CampaignStats;
}

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function campaignCardHtml(c: Campaign, i18n: Record<string, string>): string {
  const scopeLabel = c.scope === 'product' ? escHtml(c.productName ?? '') : (i18n.adScopeStore ?? '');
  const platformLabel = c.platform === 'google' ? (i18n.adPlatformGoogle ?? '') : (i18n.adPlatformMeta ?? '');
  const isActive = c.status === 'active';
  const statusClass = isActive
    ? '[color:var(--color-success)] [background:color-mix(in_srgb,var(--color-success)_14%,transparent)]'
    : '[color:var(--color-muted)] [background:color-mix(in_srgb,var(--color-muted)_14%,transparent)]';
  return `
    <div class="border [border-color:var(--color-border)] rounded-[var(--radius)] p-3" data-campaign-id="${c.id}" data-status="${c.status}">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div class="flex items-center gap-2">
          <span class="text-[0.85rem] font-semibold">${scopeLabel}</span>
          <span class="text-[0.72rem] font-medium [color:var(--color-muted)]">${platformLabel}</span>
          <span class="text-[0.68rem] font-bold py-[.1rem] px-[.5rem] rounded-full ${statusClass}">${isActive ? (i18n.adStatusActive ?? '') : (i18n.adStatusPaused ?? '')}</span>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" class="btn btn--ghost btn--sm" data-ad-action="toggle" data-campaign-id="${c.id}">${isActive ? (i18n.adPauseCampaign ?? '') : (i18n.adResumeCampaign ?? '')}</button>
          <button type="button" class="btn btn--ghost btn--sm !text-[color:var(--color-danger)]" data-ad-action="delete" data-campaign-id="${c.id}">${i18n.adDeleteCampaign ?? ''}</button>
        </div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 text-[0.82rem]">
        <div><span class="[color:var(--color-muted)]">${i18n.adBudgetLabel ?? ''}</span><br /><strong>${formatPrice(c.monthlyBudget)}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adImpressions ?? ''}</span><br /><strong>${c.stats.impressions.toLocaleString('he-IL')}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adClicks ?? ''}</span><br /><strong>${c.stats.clicks.toLocaleString('he-IL')}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adSpend ?? ''}</span><br /><strong>${formatPrice(c.stats.spend)}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adRoas ?? ''}</span><br /><strong>x${c.stats.roas}</strong></div>
      </div>
    </div>`;
}

function renderCampaigns(list: HTMLElement, campaigns: Campaign[], i18n: Record<string, string>): void {
  if (campaigns.length === 0) {
    list.innerHTML = `<p class="muted text-[0.85rem] m-0" id="ad-empty-msg">${i18n.adNoCampaigns ?? ''}</p>`;
    return;
  }
  list.innerHTML = campaigns.map((c) => campaignCardHtml(c, i18n)).join('');
}

export function initAdvertisingTab(): void {
  const listMaybe = document.getElementById('ad-campaigns-list');
  const form = document.getElementById('ad-create-form') as HTMLFormElement | null;
  if (!listMaybe || !form) return;
  // Re-bound as a plain HTMLElement: TS's control-flow narrowing from the
  // guard above doesn't carry into the nested `refetch`/listener functions
  // below (a known limitation for closures over outer `let`/`const`).
  const list = listMaybe as HTMLElement;
  const storeSlug = list.dataset.storeSlug ?? '';
  const i18n = getI18n();

  const scopeSelect = document.getElementById('ad-scope-select') as HTMLSelectElement | null;
  const productField = document.getElementById('ad-product-field');
  scopeSelect?.addEventListener('change', () => {
    if (productField) productField.hidden = scopeSelect.value !== 'product';
  });

  async function refetch(): Promise<void> {
    const res = await fetch(`/api/seller/ad-campaigns?storeSlug=${encodeURIComponent(storeSlug)}`);
    if (!res.ok) return;
    const data = await res.json() as { ok?: boolean; campaigns?: Campaign[] };
    if (data.campaigns) renderCampaigns(list, data.campaigns, i18n);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const fd = new FormData(form);
    const scope = String(fd.get('scope') ?? 'store');
    const platform = String(fd.get('platform') ?? 'google');
    const monthlyBudget = parseFloat(String(fd.get('monthlyBudget') ?? '0'));
    const productId = scope === 'product' ? String(fd.get('productId') ?? '') : undefined;

    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch('/api/seller/ad-campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeSlug, scope, platform, monthlyBudget, productId }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!data.ok) { showStatus(data.error ?? (i18n.errorSaving ?? 'Error saving.'), true); return; }
      showStatus(i18n.adCampaignCreated ?? 'Campaign launched.');
      await refetch();
    } catch {
      showStatus(i18n.errorSaving ?? 'Error saving.', true);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  list.addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-ad-action]');
    if (!btn) return;
    const campaignId = btn.dataset.campaignId ?? '';
    const action = btn.dataset.adAction;

    if (action === 'toggle') {
      // '[data-status]', not '[data-campaign-id]' — the button itself also
      // carries data-campaign-id (used above to read the id), so .closest()
      // would match the button itself first and never reach the card, always
      // reading dataset.status as undefined.
      const card = btn.closest<HTMLElement>('[data-status]');
      const currentStatus = card?.dataset.status;
      const nextStatus = currentStatus === 'active' ? 'paused' : 'active';
      btn.disabled = true;
      try {
        const res = await fetch('/api/seller/ad-campaigns', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: campaignId, storeSlug, status: nextStatus }),
        });
        const data = await res.json() as { ok?: boolean; error?: string };
        if (!data.ok) { showStatus(data.error ?? (i18n.errorSaving ?? 'Error saving.'), true); return; }
        showStatus(i18n.adCampaignUpdated ?? 'Campaign updated.');
        await refetch();
      } finally { btn.disabled = false; }
      return;
    }

    if (action === 'delete') {
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: i18n.adConfirmDeleteTitle ?? 'Cancel this campaign?',
          message: i18n.adConfirmDeleteMsg ?? 'The campaign will stop and its budget will no longer be charged.',
          okLabel: i18n.delete ?? 'Delete',
          workingLabel: i18n.deleting ?? 'Deleting…',
          onConfirm: async () => {
            const res = await fetch('/api/seller/ad-campaigns', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: campaignId, storeSlug }),
            });
            const data = await res.json() as { ok?: boolean; error?: string };
            if (!data.ok) { showStatus(data.error ?? (i18n.errorDeleting ?? 'Error deleting.'), true); return; }
            await refetch();
          },
        },
      }));
    }
  });
}
