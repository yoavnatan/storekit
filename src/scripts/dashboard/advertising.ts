import { formatPrice } from '../../config/store.config.js';
import { showStatus } from './status.js';
import { initInfoTooltips } from './tooltip.js';
import { initSelectDropdown, refreshSelectDropdown } from './select-dropdown.js';
import { roasTierChipHtml, ctrTierChipHtml } from '../../lib/ad-tier.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';
import { presetRange, shortDate } from '../../lib/date-range.js';

interface CampaignStats { impressions: number; clicks: number; ctr: number; spend: number; roas: number }
interface RunPeriod { start: string; end: string; days: number }
interface Campaign {
  id: string; scope: 'store' | 'product'; productName?: string;
  platform: 'google' | 'meta' | 'both'; monthlyBudget: number; status: 'active' | 'paused';
  durationDays?: 7 | 14 | 30;
  audience?: { gender: 'all' | 'women' | 'men'; age: 'all' | 'infant' | 'kids' | 'adult' };
  stats: CampaignStats;
  runPeriod?: RunPeriod;
}

/** "מאז 8.7" while still running, "8.7–17.7" once paused/ended — the label that
 *  tells the seller which period the (lifetime by default) numbers cover. */
function runPeriodLabel(c: Campaign, i18n: Record<string, string>): string {
  if (!c.runPeriod) return '';
  if (c.status === 'active') return `${i18n.adRunSince ?? ''} ${shortDate(c.runPeriod.start)}`.trim();
  return `${shortDate(c.runPeriod.start)}–${shortDate(c.runPeriod.end)}`;
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
      <p class="text-[0.74rem] [color:var(--color-muted)] m-0 mb-2 flex items-center gap-1.5 flex-wrap">
        <span>${escHtml(targetingLabel(c, i18n))}</span>
        ${c.runPeriod ? `<span aria-hidden="true">·</span><span class="inline-flex items-center gap-1"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${escHtml(runPeriodLabel(c, i18n))}</span>` : ''}
      </p>
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

  // Range picker — one trigger + the shared floating portal, matching the
  // Performance tab's picker exactly (CURRENT_TASK.md item 2). Windows the
  // campaign cards to a "recent activity" period; the DEFAULT is `lifetime`
  // ("מאז ההשקה"), the stable per-campaign totals (item 3). Baseline exposure
  // is a separate lifetime figure and is NOT touched by this picker.
  const rangeRoot = document.getElementById('ad-range-picker');
  // '' → lifetime (no range param → server returns per-campaign lifetime totals).
  let rangeQuery = '';

  async function refetch(): Promise<void> {
    const res = await fetch(`${endpoint}?storeSlug=${encodeURIComponent(storeSlug)}${rangeQuery ? `&${rangeQuery}` : ''}`);
    if (!res.ok) return;
    const data = await res.json() as { ok?: boolean; campaigns?: Campaign[] };
    if (data.campaigns) renderCampaigns(list, data.campaigns, i18n);
  }

  function initRangePicker(): void {
    if (!rangeRoot) return;
    const trigger = document.getElementById('ad-range-trigger');
    const label = document.getElementById('ad-range-label');
    if (!trigger) return;
    const rangePortal = createFloatingPortal('ad-range-portal');
    // The custom date inputs are pre-filled with a sensible default window (last
    // 30 days) and remember the last applied custom range — so "Apply" always has
    // valid dates to submit even if the user opens it and clicks straight through
    // (an empty pair silently no-op'd before, which read as "Apply is broken").
    const def = presetRange('30d') ?? { from: '', to: '' };
    let customFrom = def.from;
    let customTo = def.to;

    // key → i18n label key. The query string is derived (lifetime = no window =
    // empty query, the default; everything else is just `preset=<key>`).
    const PRESETS: readonly [string, string][] = [
      ['lifetime', 'adPresetLifetime'],
      ['today', 'perfPresetToday'],
      ['7d', 'perfPreset7d'],
      ['30d', 'perfPreset30d'],
      ['thisMonth', 'perfPresetThisMonth'],
    ];
    const queryFor = (key: string): string => (key === 'lifetime' ? '' : `preset=${key}`);

    const setLabel = (text: string): void => { if (label) label.textContent = text; };

    function applyPreset(key: string): void {
      rangeRoot!.dataset.activePreset = key;
      rangeQuery = queryFor(key);
      const labelKey = PRESETS.find((p) => p[0] === key)?.[1] ?? 'adPresetLifetime';
      setLabel(i18n[labelKey] ?? key);
      rangePortal.close();
      void refetch();
    }

    function applyCustom(from: string, to: string): void {
      if (!from || !to || from > to) return;
      customFrom = from;
      customTo = to;
      rangeRoot!.dataset.activePreset = 'custom';
      rangeQuery = `preset=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      setLabel(`${shortDate(from)}–${shortDate(to)}`);
      rangePortal.close();
      void refetch();
    }

    function buildPanelHtml(): string {
      const active = rangeRoot!.dataset.activePreset ?? 'lifetime';
      const presetsHtml = PRESETS.map(([key, labelKey]) =>
        `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-preset="${key}" style="${key === active ? 'font-weight:700;color:var(--color-primary)' : ''}">${i18n[labelKey] ?? key}</button>`).join('');
      // The custom-range row is a distinct labelled sub-group with its OWN small
      // "Apply" scoped to the two date fields — a full-width Apply at the very
      // bottom read as "apply the whole menu" when the presets above already
      // apply on click (user feedback). The label + inline button make it clear
      // this button only commits the custom dates.
      return `${presetsHtml}
        <div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>
        <div class="px-3 pt-1.5 pb-2">
          <div class="text-[.72rem] [color:var(--color-muted)] mb-1.5">${i18n.perfPresetCustom ?? 'Custom'}</div>
          <div class="flex items-center gap-1.5">
            <input type="date" dir="ltr" data-range-from value="${customFrom}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
            <span class="muted text-[0.8rem] shrink-0">–</span>
            <input type="date" dir="ltr" data-range-to value="${customTo}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
            <button type="button" class="btn btn--sm btn--accent shrink-0" data-range-apply>${i18n.perfApply ?? 'Apply'}</button>
          </div>
        </div>`;
    }

    trigger.addEventListener('click', () => {
      if (rangePortal.currentTrigger() === trigger) { rangePortal.close(); return; }
      // Wider than the perf picker (13rem): the custom row lays both date inputs
      // AND the inline Apply button on one line, which needs the extra room.
      rangePortal.open(trigger, '19rem', buildPanelHtml, (portal) => {
        portal.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
          btn.addEventListener('click', () => applyPreset(btn.dataset.preset ?? 'lifetime'));
        });
        portal.querySelector('[data-range-apply]')?.addEventListener('click', () => {
          const from = portal.querySelector<HTMLInputElement>('[data-range-from]')?.value ?? '';
          const to = portal.querySelector<HTMLInputElement>('[data-range-to]')?.value ?? '';
          applyCustom(from, to);
        });
      });
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

    if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.add('btn--busy'); }
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
      if (submitBtn) { submitBtn.disabled = false; submitBtn.classList.remove('btn--busy'); }
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
      // btn--busy: keep the double-submit guard (disabled) but show a "working"
      // cursor, not the "no-entry" not-allowed, for this brief in-flight moment.
      btn.disabled = true;
      btn.classList.add('btn--busy');
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
      } finally { btn.disabled = false; btn.classList.remove('btn--busy'); }
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
