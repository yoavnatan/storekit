import { formatPrice } from '../../config/store.config.js';
import { formatAgorot, fromAgorot } from '../../lib/money.js';
import { escapeHtml as escHtml } from '../../lib/html-escape.js';
import { showStatus } from './status.js';
import { initInfoTooltips } from '../tooltip.js';
import { initSelectDropdown, refreshSelectDropdown } from './select-dropdown.js';
import { roasTierChipHtml, ctrTierChipHtml } from '../../lib/ad-tier.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';
import { presetRange, shortDate } from '../../lib/date-range.js';
import { scrollBelowPinnedChrome } from './scroll-utils.js';
import { campaignScopeName, campaignTargetingLabel, campaignHealthNote, campaignFeeOf, type AdScopeKind, type CampaignHealthView } from '../../lib/ad-scope-label.js';
import { MIN_CAMPAIGN_BUDGET, MAX_CAMPAIGN_BUDGET, isValidCampaignBudget } from '../../lib/ad-budget.js';
import { initProductMultiPicker, readProductOptions, type ProductPickerOption } from './product-multi-picker.js';

interface CampaignStats { impressions: number; clicks: number; ctr: number; spend: number; adSpend?: number; cpc: number; conversions: number; roas: number }
interface RunPeriod { start: string; end: string; days: number }
interface Campaign {
  id: string; scope: AdScopeKind;
  productName?: string; productNames?: string[]; categoryNames?: string[];
  platform: 'google' | 'meta' | 'both'; monthlyBudgetAgorot: number; status: 'active' | 'paused';
  durationDays?: 7 | 14 | 30;
  audience?: { gender: 'all' | 'women' | 'men'; age: 'all' | 'infant' | 'kids' | 'adult' };
  stats: CampaignStats;
  runPeriod?: RunPeriod;
  /** How much of what it advertises is still on the storefront, and whether the platform is what
   *  paused it (lib/ad-campaign-health.ts). */
  health?: CampaignHealthView;
  pausedReason?: string;
  /** Derived server-side (ad-metrics.ts): ran its full fixed duration / is in the history block. */
  ended?: boolean;
  archived?: boolean;
}

/** A boost scope option row — the shared picker's shape plus the audience the product's own
 *  category/name/tags imply (computed server-side, where the category tree lives). */
interface AdProductOption extends ProductPickerOption { inferGender: string; inferAge: string }

/** "מאז 8.7" while still running, "8.7–17.7" once paused/ended — the label that
 *  tells the seller which period the (lifetime by default) numbers cover. */
function runPeriodLabel(c: Campaign, i18n: Record<string, string>): string {
  if (!c.runPeriod) return '';
  if (c.status === 'active') return `${i18n.adRunSince ?? ''} ${shortDate(c.runPeriod.start)}`.trim();
  return `${shortDate(c.runPeriod.start)}–${shortDate(c.runPeriod.end)}`;
}

/** Budget label reflecting the campaign's billing mode: a fixed-duration boost
 *  is a one-time TOTAL budget; an ongoing boost is a recurring MONTHLY budget.
 *  (CURRENT_TASK.md item 2 — the old flat "monthly budget" label on a 7-day
 *  campaign was the source of the confusion.) */
function budgetLabel(c: Campaign, i18n: Record<string, string>): string {
  return c.durationDays ? (i18n.adBudgetTotal ?? '') : (i18n.adBudgetMonthly ?? '');
}

/** The server answers with a CODE for anything the seller can act on, so the wording lives here,
 *  in the language he is actually reading the dashboard in. Anything else is passed through. */
function errorText(code: string | undefined, i18n: Record<string, string>): string {
  const known: Record<string, string | undefined> = {
    CAMPAIGN_UNAVAILABLE: i18n.adResumeUnavailable,
    CAMPAIGN_OUT_OF_STOCK: i18n.adResumeOutOfStock,
    CAMPAIGN_ENDED: i18n.adResumeEnded,
    PRODUCT_NOT_ADVERTISABLE: i18n.adProductNotAdvertisable,
  };
  return (code ? known[code] : undefined) ?? code ?? (i18n.errorSaving ?? 'Error saving.');
}

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

/** The management-fee split inside a campaign's spend. Shown on the ADMIN surface only, where
 *  "what we billed vs what we paid the network" is the owner's actual business question. It is
 *  deliberately NOT on the seller's card: the fee is his cost, it is disclosed where he DECIDES
 *  (the budget field's tooltip, before he commits) and it belongs on the invoice — repeating it
 *  on every card of every load is a number he can neither act on nor change, competing with the
 *  ones he can (CTR, ROAS, what to spend next). */
let showFeeSplit = false;

function campaignCardHtml(c: Campaign, i18n: Record<string, string>): string {
  // Scope + targeting wording comes from lib/ad-scope-label.ts — the same function the
  // server-rendered cards use, so a card rebuilt here can't word a campaign differently.
  const scopeLabel = escHtml(campaignScopeName(c, i18n));
  const platformLabel = c.platform === 'google' ? (i18n.adPlatformGoogle ?? '')
    : c.platform === 'meta' ? (i18n.adPlatformMeta ?? '')
    : (i18n.adPlatformBoth ?? '');
  const isActive = c.status === 'active' && !c.archived;
  // Why a campaign stopped, or how much of it is left — same rule the server-rendered cards use.
  // A card in the history block says nothing: the campaign is over, so "put a product back" is
  // advice about a campaign that is not running either way.
  const healthNote = c.archived ? '' : campaignHealthNote(c.health, c.pausedReason, i18n);
  const fee = showFeeSplit ? campaignFeeOf(c.stats) : null;
  const feeNote = fee ? (i18n.adSpendFeeNote ?? '').replace('{fee}', formatPrice(fee)) : '';
  // History tells apart the two ways a campaign gets there: it finished its run, or it was
  // cancelled part-way. Same badge slot, different word.
  const statusText = c.archived
    ? (c.ended ? (i18n.adStatusEnded ?? '') : (i18n.adStatusCancelled ?? ''))
    : isActive ? (i18n.adStatusActive ?? '') : (i18n.adStatusPaused ?? '');
  const statusClass = isActive
    ? '[color:var(--color-success)] [background:color-mix(in_srgb,var(--color-success)_14%,transparent)]'
    : '[color:var(--color-muted)] [background:color-mix(in_srgb,var(--color-muted)_14%,transparent)]';
  return `
    <div class="border [border-color:var(--color-border)] rounded-[var(--radius)] p-3" data-campaign-id="${c.id}" data-status="${c.status}">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-2">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <span class="text-[0.85rem] font-semibold">${scopeLabel}</span>
          <span class="text-[0.72rem] font-medium [color:var(--color-muted)]">${platformLabel}</span>
          <span class="text-[0.68rem] font-bold py-[.1rem] px-[.5rem] rounded-full ${statusClass}">${statusText}</span>
        </div>
        ${c.archived ? '' : `<div class="flex items-center gap-2 shrink-0">
          <button type="button" class="btn btn--ghost btn--sm" data-ad-action="edit-budget" data-campaign-id="${c.id}">${i18n.adEditBudget ?? ''}</button>
          <button type="button" class="btn btn--ghost btn--sm" data-ad-action="toggle" data-campaign-id="${c.id}">${isActive ? (i18n.adPauseCampaign ?? '') : (i18n.adResumeCampaign ?? '')}</button>
          <button type="button" class="btn btn--ghost btn--sm !text-[color:var(--color-danger)]" data-ad-action="delete" data-campaign-id="${c.id}">${i18n.adDeleteCampaign ?? ''}</button>
        </div>`}
      </div>
      <p class="text-[0.74rem] [color:var(--color-muted)] m-0 mb-2 flex items-center gap-1.5 flex-wrap">
        <span>${escHtml(campaignTargetingLabel(c, i18n))}</span>
        ${c.runPeriod ? `<span aria-hidden="true">·</span><span class="inline-flex items-center gap-1"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${escHtml(runPeriodLabel(c, i18n))}</span>` : ''}
      </p>
      ${healthNote ? `<p class="text-[0.74rem] m-0 mb-2 py-1.5 px-2 rounded-[var(--radius-sm)] [color:var(--color-text)] [background:color-mix(in_srgb,var(--color-danger)_9%,transparent)]">${escHtml(healthNote)}</p>` : ''}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[0.82rem]">
        <div data-budget-cell data-budget="${fromAgorot(c.monthlyBudgetAgorot)}"><span class="[color:var(--color-muted)]">${budgetLabel(c, i18n)}</span><br /><strong>${formatAgorot(c.monthlyBudgetAgorot)}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adImpressions ?? ''}</span><br /><strong>${c.stats.impressions.toLocaleString('he-IL')}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adClicks ?? ''}</span><br /><strong>${c.stats.clicks.toLocaleString('he-IL')}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adCtr ?? ''}</span><br /><strong>${c.stats.ctr}%</strong>${ctrTierChipHtml(c.stats.ctr, { low: i18n.adTierLow ?? '', mid: i18n.adTierMid ?? '', high: i18n.adTierHigh ?? '' })}</div>
        <div><span class="[color:var(--color-muted)]">${i18n.adSpend ?? ''}</span><br /><strong>${formatPrice(c.stats.spend)}</strong>${feeNote ? `<br /><span class="[color:var(--color-muted)] text-[0.7rem]">${escHtml(feeNote)}</span>` : ''}</div>
        <div><span class="[color:var(--color-muted)]">${i18n.adCpc ?? ''}</span><br /><strong>${formatPrice(c.stats.cpc)}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adConversions ?? ''}</span><br /><strong>${c.stats.conversions.toLocaleString('he-IL')}</strong></div>
        <div><span class="[color:var(--color-muted)]">${i18n.adRoas ?? ''}</span><br /><strong>x${c.stats.roas}</strong>${roasTierChipHtml(c.stats.roas, { low: i18n.adTierLow ?? '', mid: i18n.adTierMid ?? '', high: i18n.adTierHigh ?? '' })}</div>
      </div>
    </div>`;
}

function renderCampaigns(list: HTMLElement, campaigns: Campaign[], i18n: Record<string, string>, emptyMsg?: string): void {
  if (campaigns.length === 0) {
    list.innerHTML = `<p class="muted text-[0.85rem] m-0" id="ad-empty-msg">${emptyMsg ?? i18n.adNoCampaigns ?? ''}</p>`;
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
  showFeeSplit = list.dataset.showFee !== undefined;
  const i18n = getI18n();

  // Bind the static "(i)" info triggers in this tab (e.g. the baseline-impressions
  // explainer). Idempotent — guarded per-element by dataset.tooltipBound — so the
  // seller dashboard, where performance.ts also calls this, double-calls safely.
  initInfoTooltips();

  const scopeSelect = document.getElementById('ad-scope-select') as HTMLSelectElement | null;
  const productField = document.getElementById('ad-product-field');
  const productIdsInput = document.getElementById('ad-product-ids') as HTMLInputElement | null;
  const categoryField = document.getElementById('ad-category-field');
  const genderSelect = document.getElementById('ad-gender-select') as HTMLSelectElement | null;
  const ageSelect = document.getElementById('ad-age-select') as HTMLSelectElement | null;
  const inferNote = document.getElementById('ad-infer-note');

  // Upgrade every native <select> in the create-boost form to the site-design
  // floating-portal dropdown (viewport-clamped, stays pinned on scroll). The
  // selects keep holding the value + submitting; only their popup changes.
  form.querySelectorAll<HTMLSelectElement>('select').forEach((sel) => initSelectDropdown(sel));

  // Baseline card's boost CTA jumps down to the boost card (seller tab only —
  // null-safe on the admin per-store view where the CTA is absent). The card has
  // to clear the whole pinned stack — fixed site header + sticky tab strip +
  // sticky panel head ("פרסום ושיווק") — or it lands hidden beneath the panel
  // head. scroll-utils.ts measures all three live and does the RTL-safe scroll.
  document.getElementById('ad-boost-jump')?.addEventListener('click', () => {
    // 12px of breathing room, kept below the baseline card's mb (1rem) so its green tint
    // doesn't peek above the pinned head.
    scrollBelowPinnedChrome(document.getElementById('ad-boost-card') ?? form, 12);
  });

  // The seller tab's product scope is a tick-list (the shared dashboard picker), so one product
  // is simply a list of one — the server stores that as the long-standing single-product
  // campaign (ad-campaign-input.ts). Options carry the audience each product's own
  // category/name/tags imply, so the audience fields can pre-fill from the ticks.
  const productsList = document.getElementById('ad-products-list');
  const productOptions = productsList ? readProductOptions<AdProductOption>('ad-products-data') : [];
  const productPicker = productIdsInput && productsList
    ? initProductMultiPicker({
      list: productsList,
      hidden: productIdsInput,
      search: document.getElementById('ad-products-search') as HTMLInputElement | null,
      count: document.getElementById('ad-products-count'),
      options: productOptions,
      labels: { selected: i18n.saleProductsSelected ?? '', none: i18n.saleProductsNone ?? '' },
      onChange: () => applyInferredAudience(),
    })
    : null;

  /** The gender/age_group the current pick implies, or '' where it doesn't imply one. Several
   *  products only pre-fill when they AGREE — a mixed pick has no single answer, and guessing
   *  one would quietly narrow a campaign the seller never narrowed. Categories don't pre-fill:
   *  their products' inferred attributes aren't on this page, and each product self-targets by
   *  its own anyway. */
  function inferredAudience(): { gender: string; age: string } {
    if (scopeSelect?.value !== 'products' || !productPicker) return { gender: '', age: '' };
    const picked = productPicker.selected()
      .map((id) => productOptions.find((o) => o.id === id))
      .filter((o): o is AdProductOption => !!o);
    if (!picked.length) return { gender: '', age: '' };
    const agreed = (key: 'inferGender' | 'inferAge'): string => {
      const first = picked[0]![key];
      return first && picked.every((o) => o[key] === first) ? first : '';
    };
    return { gender: agreed('inferGender'), age: agreed('inferAge') };
  }

  // Pre-fill so a seller who already categorized under "גברים"/"תינוקות" doesn't re-enter it.
  // The seller can still override — the change handlers below retire the "auto-filled" note.
  function applyInferredAudience(): void {
    const { gender, age } = inferredAudience();
    let applied = false;
    if (genderSelect && (gender === 'men' || gender === 'women')) { genderSelect.value = gender; refreshSelectDropdown(genderSelect); applied = true; }
    if (ageSelect && (age === 'infant' || age === 'kids' || age === 'adult')) { ageSelect.value = age; refreshSelectDropdown(ageSelect); applied = true; }
    if (inferNote) inferNote.hidden = !applied;
  }

  const genderField = document.getElementById('ad-gender-field');
  const ageField = document.getElementById('ad-age-field');
  const storeAutoNote = document.getElementById('ad-store-auto-note');

  // A whole-store campaign covers a mixed catalog, so a single manual gender/age would wrongly
  // force one demographic on all of it — each product is targeted automatically by its own
  // inferred feed attributes instead. So the manual audience fields exist for every NARROWED
  // scope (products/categories: the seller picked that slice himself) and are replaced by the
  // "auto per product" note for the store-wide one. A scope the seller switched away from keeps
  // its ticks (switching back restores them) — the submit below reads only the ACTIVE scope's
  // field, so a set left behind can never widen or narrow the campaign that actually launches.
  function updateScopeUI(): void {
    const scope = scopeSelect?.value ?? 'store';
    const picksProducts = scope === 'products';
    if (productField) productField.hidden = !picksProducts;
    if (categoryField) categoryField.hidden = scope !== 'categories';
    if (genderField) genderField.hidden = scope === 'store';
    if (ageField) ageField.hidden = scope === 'store';
    if (storeAutoNote) storeAutoNote.hidden = scope !== 'store';
    if (picksProducts) productPicker?.render(); // a hidden container paints nothing
    applyInferredAudience();
  }

  // Billing-mode clarity (CURRENT_TASK.md item 2): the budget the seller enters
  // means different things per duration — a fixed period (7/14/30) is a one-time
  // TOTAL, "ongoing" is a recurring MONTHLY charge. Reflect that live in the
  // field label + a plain-language note so nobody has to guess whether it renews.
  const durationSelect = document.getElementById('ad-duration-select') as HTMLSelectElement | null;
  const budgetLabelEl = document.getElementById('ad-budget-label');
  const budgetModeNote = document.getElementById('ad-budget-mode-note');

  // Budget ladder → the number field. The number field is the ONLY control carrying
  // `name="monthlyBudget"`, so a preset and a typed amount reach the server by the identical
  // path; the select just writes into it and reveals it for "another amount".
  const budgetSelect = document.getElementById('ad-budget-select') as HTMLSelectElement | null;
  const budgetInput = document.getElementById('ad-budget-input') as HTMLInputElement | null;
  // The one out-of-range message, built from the constants so the numbers in it can never drift
  // from the rule the server enforces (lib/ad-budget.ts).
  const budgetError = document.getElementById('ad-budget-range-error');
  const budgetRangeMessage = (): string => (i18n.adBudgetInvalid ?? 'Invalid budget.')
    .replace('{min}', formatPrice(MIN_CAMPAIGN_BUDGET))
    .replace('{max}', formatPrice(MAX_CAMPAIGN_BUDGET));
  function showBudgetError(show: boolean): void {
    if (!budgetError) return;
    budgetError.textContent = show ? budgetRangeMessage() : '';
    budgetError.hidden = !show;
  }

  function syncBudgetChoice(): boolean {
    if (!budgetSelect || !budgetInput) return false;
    const custom = budgetSelect.value === 'custom';
    budgetInput.hidden = !custom;
    // "Another amount" hands over an EMPTY field (user, CURRENT_TASK.md item 4). Leaving the
    // last preset in it means the seller has to clear someone else's number before typing his
    // own, and the real failure is the half-cleared one — a click into "2000" and a typed "25"
    // ships "252000". A preset still writes its value here on the way out, so the POST path
    // is unchanged.
    budgetInput.value = custom ? '' : budgetSelect.value;
    // Deliberately NOT `required`: the empty field and the out-of-range one get the same Hebrew
    // message from the same place (the submit guard below), instead of one native browser bubble
    // in the browser's language for empty and our own wording for everything else.
    showBudgetError(false); // a preset is always valid, and a fresh empty field is not yet wrong
    return custom;
  }
  budgetSelect?.addEventListener('change', () => {
    // Focus only on a real choice, never on the initial sync — this panel starts hidden, and
    // focusing inside a hidden panel scrolls the page to a field nobody asked for.
    if (syncBudgetChoice()) budgetInput?.focus(); // no select(): syncBudgetChoice just emptied it
  });
  // Told on the way OUT of the field, not on every keystroke: "5" on the way to "500" is not a
  // mistake yet, and a message that appears mid-word is noise. Once it is up it clears live, so
  // a correction is acknowledged the moment it is typed rather than at the next blur.
  budgetInput?.addEventListener('blur', () => {
    if (!budgetInput || budgetInput.hidden) return;
    const raw = budgetInput.value.trim();
    showBudgetError(raw !== '' && !isValidCampaignBudget(parseFloat(raw)));
  });
  budgetInput?.addEventListener('input', () => {
    if (budgetError?.hidden === false && isValidCampaignBudget(parseFloat(budgetInput.value))) showBudgetError(false);
  });
  syncBudgetChoice();
  function updateBudgetMode(): void {
    const ongoing = !durationSelect?.value; // '' = ongoing
    if (budgetLabelEl) budgetLabelEl.textContent = ongoing ? (i18n.adBudgetMonthlyFieldLabel ?? '') : (i18n.adBudgetTotalFieldLabel ?? '');
    if (budgetModeNote) budgetModeNote.textContent = ongoing ? (i18n.adBudgetMonthlyHint ?? '') : (i18n.adBudgetTotalHint ?? '');
  }
  durationSelect?.addEventListener('change', updateBudgetMode);
  updateBudgetMode();

  scopeSelect?.addEventListener('change', updateScopeUI);
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
    const data = await res.json() as { ok?: boolean; campaigns?: Campaign[]; archived?: Campaign[] };
    if (data.campaigns) renderCampaigns(list, data.campaigns, i18n);
    // The history block is server-rendered too, so it only exists on the pages that show one.
    const history = document.getElementById('ad-history-list');
    if (history && data.archived) renderCampaigns(history, data.archived, i18n, i18n.adHistoryEmpty);
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
        `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-preset="${key}" style="${key === active ? 'font-weight:700;color:var(--color-primary)' : ''}">${i18n[labelKey] ?? key}</button>`).join('');
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

  // ── Lazy first-load (CURRENT_TASK item 1) ────────────────────────────────
  // When Advertising isn't the seller dashboard's landing tab, the server skips
  // the per-campaign mock-stats pass and renders an empty list marked
  // data-ssr-loaded="0" (a skeleton placeholder). Fetch the campaigns the first
  // time the panel is revealed. Any other value (the landing tab = "1", or the
  // admin per-store page where the attribute is absent) means the cards are
  // already server-rendered — no fetch needed.
  if (list.dataset.ssrLoaded === '0') {
    const advPanel = document.getElementById('dash-panel-advertising');
    const lazyLoad = () => { void refetch(); };
    if (!advPanel || !advPanel.hidden) lazyLoad();
    else advPanel.addEventListener('dashtab:show', lazyLoad, { once: true });
  }

  // History is filled by the same fetch, the first time it is actually opened. Not on load: when
  // Advertising IS the landing tab the live cards come from the server and nothing fetches at
  // all, and a request for a block that is collapsed by default is one nobody asked for.
  const historyEl = document.getElementById('ad-history');
  historyEl?.addEventListener('toggle', () => {
    if (!(historyEl as HTMLDetailsElement).open || historyEl.dataset.loaded === '1') return;
    historyEl.dataset.loaded = '1';
    void refetch();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const fd = new FormData(form);
    const scope = String(fd.get('scope') ?? 'store');
    const platform = String(fd.get('platform') ?? 'google');
    const monthlyBudget = parseFloat(String(fd.get('monthlyBudget') ?? ''));
    const durationRaw = parseInt(String(fd.get('durationDays') ?? ''), 10);
    const durationDays = Number.isFinite(durationRaw) ? durationRaw : undefined;
    // Audience only applies to a narrowed boost — a store campaign self-targets per product, so
    // it carries no single audience (the server enforces this too).
    const audience = scope !== 'store'
      ? { gender: String(fd.get('gender') ?? 'all'), age: String(fd.get('age') ?? 'all') }
      : undefined;
    // Only the ACTIVE scope's tick list is read — both are comma-joined in one hidden input.
    const csv = (name: string): string[] => String(fd.get(name) ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    const productIds = scope === 'products' ? csv('productIds') : undefined;
    const categoryIds = scope === 'categories' ? csv('categoryIds') : undefined;
    // Say which pick is missing here rather than sending a request that can only come back as
    // "Missing productId" — the seller is looking straight at the empty list.
    if (scope === 'products' && !productIds?.length) { showStatus(i18n.adScopeProductsMissing ?? '', true); return; }
    if (scope === 'categories' && !categoryIds?.length) { showStatus(i18n.adScopeCategoriesMissing ?? '', true); return; }
    // Budget guard, same rule as the server and the inline editor below (lib/ad-budget.ts). Also
    // the empty-field case: nothing typed parses to NaN, which JSON.stringify sends as `null`, so
    // without this the seller gets a generic server error about a field he is looking straight at.
    // The message goes UNDER the field rather than into the form's status line — that is where he
    // is looking — with the status line kept for the case the field is hidden and cannot show it.
    if (!isValidCampaignBudget(monthlyBudget)) {
      if (budgetInput && !budgetInput.hidden) {
        showBudgetError(true);
        budgetInput.focus();
      } else {
        showStatus(budgetRangeMessage(), true);
      }
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.add('btn--busy'); }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeSlug, scope, platform, monthlyBudget, productIds, categoryIds, durationDays, audience }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!data.ok) { showStatus(errorText(data.error, i18n), true); return; }
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
        if (!data.ok) {
          showStatus(errorText(data.error, i18n), true);
          await refetch(); // the card's own note explains it too
          return;
        }
        showStatus(i18n.adCampaignUpdated ?? 'Campaign updated.');
        await refetch();
      } finally { btn.disabled = false; btn.classList.remove('btn--busy'); }
      return;
    }

    if (action === 'edit-budget') {
      // Inline top-up/adjust for an existing campaign (CURRENT_TASK.md item 2 —
      // there was no way to change a live campaign's budget before). Swaps the
      // budget cell into a small input; Save PATCHes monthlyBudget and refetches
      // (server recomputes the mock spend/stats), Cancel restores the cell as-is.
      // Match on '[data-status]' (the CARD), NOT '[data-campaign-id]' — the
      // button itself also carries data-campaign-id, so .closest() would return
      // the button and never find the budget cell (the "does nothing" bug).
      const card = btn.closest<HTMLElement>('[data-status]');
      const cell = card?.querySelector<HTMLElement>('[data-budget-cell]');
      if (!cell || cell.dataset.editing) return;
      cell.dataset.editing = '1';
      const original = cell.innerHTML;
      cell.innerHTML = `
        <div class="flex items-center gap-1 flex-wrap">
          <input type="number" min="${MIN_CAMPAIGN_BUDGET}" max="${MAX_CAMPAIGN_BUDGET}" step="1" value="${escHtml(cell.dataset.budget ?? '')}" dir="ltr" data-budget-input class="input !py-[.2rem] !px-[.4rem] !w-[6.5rem] text-[0.82rem]" aria-label="${escHtml(i18n.adEditBudget ?? '')}" />
          <button type="button" data-budget-save class="btn btn--accent btn--sm !py-[.2rem] !px-[.5rem]">${escHtml(i18n.save ?? 'Save')}</button>
          <button type="button" data-budget-cancel class="btn btn--ghost btn--sm !py-[.2rem] !px-[.5rem]">${escHtml(i18n.cancel ?? 'Cancel')}</button>
        </div>`;
      const input = cell.querySelector<HTMLInputElement>('[data-budget-input]');
      const restore = (): void => { cell.innerHTML = original; delete cell.dataset.editing; };
      input?.focus();
      input?.select();
      const save = async (): Promise<void> => {
        const saveBtn = cell.querySelector<HTMLButtonElement>('[data-budget-save]');
        const val = parseFloat(input?.value ?? '');
        // Same rule the server enforces (lib/ad-budget.ts) rather than a re-typed `< 50` — and
        // the message states the real limits rather than repeating "50" in prose that goes stale
        // the moment the constant moves.
        if (!isValidCampaignBudget(val)) {
          const msg = (i18n.adBudgetInvalid ?? 'Invalid budget.')
            .replace('{min}', formatPrice(MIN_CAMPAIGN_BUDGET))
            .replace('{max}', formatPrice(MAX_CAMPAIGN_BUDGET));
          showStatus(msg, true);
          return;
        }
        if (saveBtn) { saveBtn.disabled = true; saveBtn.classList.add('btn--busy'); }
        try {
          const res = await fetch(endpoint, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: campaignId, storeSlug, monthlyBudget: val }),
          });
          const data = await res.json() as { ok?: boolean; error?: string };
          if (!data.ok) { showStatus(data.error ?? (i18n.errorSaving ?? 'Error saving.'), true); if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove('btn--busy'); } return; }
          showStatus(i18n.adBudgetSaved ?? 'Budget updated.');
          await refetch();
        } catch {
          showStatus(i18n.errorSaving ?? 'Error saving.', true);
          if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove('btn--busy'); }
        }
      };
      cell.querySelector('[data-budget-cancel]')?.addEventListener('click', restore);
      cell.querySelector('[data-budget-save]')?.addEventListener('click', () => void save());
      input?.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); void save(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); restore(); }
      });
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
