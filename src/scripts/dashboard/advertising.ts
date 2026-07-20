import { formatPrice } from '../../config/store.config.js';
import { showStatus } from './status.js';
import { initInfoTooltips } from './tooltip.js';
import { initSelectDropdown, refreshSelectDropdown } from './select-dropdown.js';
import { roasTierChipHtml, ctrTierChipHtml } from '../../lib/ad-tier.js';

interface CampaignStats { impressions: number; clicks: number; ctr: number; spend: number; roas: number }
interface Campaign {
  id: string; scope: 'store' | 'product'; productName?: string;
  platform: 'google' | 'meta' | 'both'; monthlyBudget: number; status: 'active' | 'paused';
  durationDays?: 7 | 14 | 30;
  audience?: { gender: 'all' | 'women' | 'men'; age: 'all' | 'infant' | 'kids' | 'adult' };
  stats: CampaignStats;
}

// Compact "women · kids · 14 days" targeting summary for a campaign card.
// Mirrors the SSR version in dashboard.astro / admin advertising.astro.
function targetingLabel(c: Campaign, i18n: Record<string, string>): string {
  const ageLabels: Record<string, string> = { infant: i18n.adAgeInfant ?? '', kids: i18n.adAgeKids ?? '', adult: i18n.adAgeAdult ?? '' };
  const parts: string[] = [];
  if (c.scope === 'store') {
    // No single audience — each product self-targets by its own attributes.
    parts.push(i18n.adAutoPerProduct ?? '');
  } else {
    if (c.audience?.gender === 'women') parts.push(i18n.adGenderWomen ?? '');
    else if (c.audience?.gender === 'men') parts.push(i18n.adGenderMen ?? '');
    if (c.audience?.age && ageLabels[c.audience.age]) parts.push(ageLabels[c.audience.age]!);
    if (parts.length === 0) parts.push(i18n.adAudienceAll ?? '');
  }
  const dur = c.durationDays === 7 ? (i18n.adDuration7 ?? '')
    : c.durationDays === 14 ? (i18n.adDuration14 ?? '')
    : c.durationDays === 30 ? (i18n.adDuration30 ?? '')
    : (i18n.adDurationOngoing ?? '');
  parts.push(dur);
  return parts.filter(Boolean).join(' · ');
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
  const platformLabel = c.platform === 'google' ? (i18n.adPlatformGoogle ?? '')
    : c.platform === 'meta' ? (i18n.adPlatformMeta ?? '')
    : (i18n.adPlatformBoth ?? '');
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
      <p class="text-[0.74rem] [color:var(--color-muted)] m-0 mb-2">${escHtml(targetingLabel(c, i18n))}</p>
      <div class="grid grid-cols-2 sm:grid-cols-6 gap-3 text-[0.82rem]">
        <div><span class="[color:var(--color-muted)]">${i18n.adBudgetLabel ?? ''}</span><br /><strong>${formatPrice(c.monthlyBudget)}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adImpressions ?? ''}</span><br /><strong>${c.stats.impressions.toLocaleString('he-IL')}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adClicks ?? ''}</span><br /><strong>${c.stats.clicks.toLocaleString('he-IL')}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adCtr ?? ''}</span><br /><strong>${c.stats.ctr}%</strong>${ctrTierChipHtml(c.stats.ctr, { low: i18n.adTierLow ?? '', mid: i18n.adTierMid ?? '', high: i18n.adTierHigh ?? '' })}</div>
        <div><span class="[color:var(--color-muted)]">${i18n.adSpend ?? ''}</span><br /><strong>${formatPrice(c.stats.spend)}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adRoas ?? ''}</span><br /><strong>x${c.stats.roas}</strong>${roasTierChipHtml(c.stats.roas, { low: i18n.adTierLow ?? '', mid: i18n.adTierMid ?? '', high: i18n.adTierHigh ?? '' })}</div>
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
  // Same script drives the seller's own tab and the admin's per-store control
  // view (see /admin/store/[slug]/advertising.astro); the admin surface points
  // at the admin-guarded twin endpoint via data-endpoint. Mirrors how
  // performance.ts reads data-endpoint for the same dual-surface reuse.
  const endpoint = list.dataset.endpoint || '/api/seller/ad-campaigns';
  const i18n = getI18n();

  // Bind the static "(i)" info triggers in this tab (e.g. the baseline-impressions
  // explainer). Idempotent — guarded per-element by dataset.tooltipBound — so the
  // seller dashboard, where performance.ts also calls this, double-calls safely.
  initInfoTooltips();

  const scopeSelect = document.getElementById('ad-scope-select') as HTMLSelectElement | null;
  const productField = document.getElementById('ad-product-field');
  const productSelect = document.getElementById('ad-product-select') as HTMLSelectElement | null;
  const genderSelect = document.getElementById('ad-gender-select') as HTMLSelectElement | null;
  const ageSelect = document.getElementById('ad-age-select') as HTMLSelectElement | null;
  const inferNote = document.getElementById('ad-infer-note');

  // Upgrade every native <select> in the create-boost form to the site-design
  // floating-portal dropdown (viewport-clamped, stays pinned on scroll). The
  // selects keep holding the value + submitting; only their popup changes.
  form.querySelectorAll<HTMLSelectElement>('select').forEach((sel) => initSelectDropdown(sel));

  // Pre-fill gender + age_group from the selected product's inferred audience
  // (data-infer-gender / data-infer-age, computed server-side from its
  // category/name/tags) so a seller who already categorized under "גברים"/
  // "תינוקות" doesn't re-enter it. Only for a product-scoped boost — a
  // whole-store campaign has no single product to read from. The seller can
  // still override (the change handlers below retire the "auto-filled" note).
  function applyInferredAudience(): void {
    const isProduct = scopeSelect?.value === 'product';
    const opt = isProduct ? productSelect?.selectedOptions[0] : undefined;
    let applied = false;
    const g = opt?.dataset.inferGender ?? '';
    if (genderSelect && (g === 'men' || g === 'women')) { genderSelect.value = g; refreshSelectDropdown(genderSelect); applied = true; }
    const a = opt?.dataset.inferAge ?? '';
    if (ageSelect && (a === 'infant' || a === 'kids' || a === 'adult')) { ageSelect.value = a; refreshSelectDropdown(ageSelect); applied = true; }
    if (inferNote) inferNote.hidden = !applied;
  }

  const genderField = document.getElementById('ad-gender-field');
  const ageField = document.getElementById('ad-age-field');
  const storeAutoNote = document.getElementById('ad-store-auto-note');

  // A whole-store campaign has no single product, so a single manual gender/age
  // would wrongly force one demographic on a mixed catalog — instead each
  // product is targeted automatically by its own inferred feed attributes. So
  // the manual audience fields exist ONLY for a product-scoped boost; for store
  // scope they're hidden and replaced by the "auto per product" note.
  function updateScopeUI(): void {
    const isProduct = scopeSelect?.value === 'product';
    if (productField) productField.hidden = !isProduct;
    if (genderField) genderField.hidden = !isProduct;
    if (ageField) ageField.hidden = !isProduct;
    if (storeAutoNote) storeAutoNote.hidden = isProduct;
    applyInferredAudience();
  }

  scopeSelect?.addEventListener('change', updateScopeUI);
  productSelect?.addEventListener('change', applyInferredAudience);
  // A manual change to either field is a deliberate override — retire the note.
  const retireNote = () => { if (inferNote) inferNote.hidden = true; };
  genderSelect?.addEventListener('change', retireNote);
  ageSelect?.addEventListener('change', retireNote);
  updateScopeUI(); // sync initial visibility to the default scope

  // Date-range picker (seller tab only). Absent on the admin per-store control
  // view → rangeQuery stays '' → the API returns lifetime totals, unchanged.
  const rangeRoot = document.getElementById('ad-range');
  let rangeQuery = rangeRoot ? 'preset=7d' : '';

  async function refetch(): Promise<void> {
    const res = await fetch(`${endpoint}?storeSlug=${encodeURIComponent(storeSlug)}${rangeQuery ? `&${rangeQuery}` : ''}`);
    if (!res.ok) return;
    const data = await res.json() as { ok?: boolean; campaigns?: Campaign[]; baselineImpressions?: number };
    if (data.campaigns) renderCampaigns(list, data.campaigns, i18n);
    if (typeof data.baselineImpressions === 'number') {
      const el = document.getElementById('ad-baseline-impressions');
      if (el) el.textContent = data.baselineImpressions.toLocaleString('he-IL');
    }
  }

  function initRangePicker(): void {
    if (!rangeRoot) return;
    const custom = document.getElementById('ad-range-custom');
    const setActive = (active: Element): void => {
      rangeRoot.querySelectorAll('[data-preset]').forEach((c) => c.setAttribute('aria-pressed', String(c === active)));
    };
    rangeRoot.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const preset = chip.dataset.preset ?? '7d';
        setActive(chip);
        if (preset === 'custom') { if (custom) custom.hidden = false; return; }
        if (custom) custom.hidden = true;
        rangeQuery = `preset=${preset}`;
        void refetch();
      });
    });
    document.getElementById('ad-range-apply')?.addEventListener('click', () => {
      const from = (document.getElementById('ad-range-from') as HTMLInputElement | null)?.value;
      const to = (document.getElementById('ad-range-to') as HTMLInputElement | null)?.value;
      if (!from || !to) return;
      rangeQuery = `preset=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      void refetch();
    });
  }
  initRangePicker();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const fd = new FormData(form);
    const scope = String(fd.get('scope') ?? 'store');
    const platform = String(fd.get('platform') ?? 'google');
    const monthlyBudget = parseFloat(String(fd.get('monthlyBudget') ?? '0'));
    const productId = scope === 'product' ? String(fd.get('productId') ?? '') : undefined;
    const durationRaw = parseInt(String(fd.get('durationDays') ?? ''), 10);
    const durationDays = Number.isFinite(durationRaw) ? durationRaw : undefined;
    // Audience only applies to a product boost — a store campaign self-targets
    // per product, so it carries no single audience (server enforces this too).
    const audience = scope === 'product'
      ? { gender: String(fd.get('gender') ?? 'all'), age: String(fd.get('age') ?? 'all') }
      : undefined;

    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeSlug, scope, platform, monthlyBudget, productId, durationDays, audience }),
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
        const res = await fetch(endpoint, {
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
            const res = await fetch(endpoint, {
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
