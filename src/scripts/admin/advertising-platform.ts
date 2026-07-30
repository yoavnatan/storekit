import { initInfoTooltips, showTooltipAtPoint, hideTooltip } from '../tooltip.js';
import { cloudinaryUpload } from '../dashboard/cloudinary.js';
import { escapeHtml } from '../../lib/html-escape.js';
import { formatPrice, cdnSrc } from '../../config/store.config.js';
import { createFloatingPortal, type FloatingPortal } from '../../lib/toolbar-portal.js';
import { buildAdminUrl, swapPanel } from '../../lib/admin-nav.js';
import { buildBarChartSvg, type BarChartPoint } from '../../lib/chart-svg.js';
import { showErrorToast } from '../../lib/toast.js';

// Platform advertising tab (CURRENT_TASK.md → סשן ב׳). Wires three things:
//  1. the "(i)" info tooltips scattered across the panel (initInfoTooltips),
//  2. the baseline campaign form (lifetime budget + active/paused),
//  3. per-store promotion management on the "promoted stores" list — retune the
//     tier or cancel the promotion outright, right where the owner sees it.
// Everything else on the panel is read-only (derived/mock).
const PROMO_LABELS = ['—', 'קידום', 'קידום חזק'];

function initBaselineForm(): void {
  const form = document.getElementById('platform-ads-form') as HTMLFormElement | null;
  if (!form) return;

  const toggle = document.getElementById('platform-ads-status-toggle') as HTMLButtonElement | null;
  const saved = document.getElementById('platform-ads-saved');
  const budgetInput = form.querySelector<HTMLInputElement>('input[name="lifetimeBudget"]');
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  // Pending status lives on the form's dataset (seeded from SSR) so a click
  // just flips the label; the actual write happens on Save.
  function syncToggle(): void {
    if (!toggle) return;
    const paused = form!.dataset.status === 'paused';
    toggle.textContent = paused ? 'חדש את הקמפיין' : 'השהה קמפיין';
    toggle.setAttribute('aria-pressed', String(paused));
  }

  toggle?.addEventListener('click', () => {
    form.dataset.status = form.dataset.status === 'paused' ? 'active' : 'paused';
    syncToggle();
    if (saved) saved.hidden = true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.add('btn--busy'); }
    if (saved) saved.hidden = true;
    try {
      const res = await fetch('/api/admin/platform-ads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baselineStatus: form.dataset.status === 'paused' ? 'paused' : 'active',
          lifetimeBudget: Number(budgetInput?.value) || 0,
        }),
      });
      if (!res.ok) throw new Error('request failed');
      if (saved) saved.hidden = false;
    } catch {
      showErrorToast('השמירה נכשלה, נסו שוב');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.classList.remove('btn--busy'); }
    }
  });
}

// POST a new curation weight for a store (shared endpoint with the Stores tab).
async function setPromoWeight(slug: string, weight: number): Promise<number> {
  const res = await fetch('/api/admin/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeSlug: slug, weight }),
  });
  if (!res.ok) throw new Error('request failed');
  const { weight: applied } = await res.json() as { weight: number };
  return applied;
}

function initPromotedList(): void {
  const list = document.getElementById('admin-ads-promoted-list');
  const empty = document.getElementById('admin-ads-promoted-empty');
  if (!list) return;

  function refreshEmptyState(): void {
    if (empty) empty.hidden = list!.querySelector('.admin-ads-promoted__row') !== null;
  }

  // Delegated: the list is re-rendered wholesale on a full page load, so one
  // listener on the container covers every row's tier + cancel buttons.
  list.addEventListener('click', async (e) => {
    const target = e.target as Element;
    const row = target.closest<HTMLElement>('.admin-ads-promoted__row');
    if (!row) return;
    const slug = row.dataset.storeSlug ?? '';

    // ── Retune tier: 1 (קידום) ⇄ 2 (קידום חזק) ──
    const tierBtn = target.closest<HTMLButtonElement>('.admin-ads-promo-tier');
    if (tierBtn) {
      const current = Number(row.dataset.weight) || 1;
      const next = current === 2 ? 1 : 2;
      tierBtn.disabled = true;
      try {
        const applied = await setPromoWeight(slug, next);
        row.dataset.weight = String(applied);
        const badge = row.querySelector<HTMLElement>('[data-promo-badge]');
        if (badge) badge.textContent = PROMO_LABELS[applied] ?? PROMO_LABELS[1]!;
        tierBtn.textContent = applied === 2 ? 'החזר לקידום רגיל' : 'הפוך לקידום חזק';
      } catch {
        showErrorToast('הפעולה נכשלה, נסו שוב');
      } finally {
        tierBtn.disabled = false;
      }
      return;
    }

    // ── Cancel promotion: weight 0, row leaves the list ──
    const cancelBtn = target.closest<HTMLButtonElement>('.admin-ads-promo-cancel');
    if (cancelBtn) {
      const name = cancelBtn.dataset.storeName ?? '';
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: 'לבטל את הקידום?',
          message: `"${name}" תפסיק לעלות קדימה בעמודי הגילוי. אפשר לקדם שוב בכל רגע.`,
          okLabel: 'בטל קידום',
          workingLabel: 'מבטל…',
          onConfirm: async () => {
            await setPromoWeight(slug, 0);
            row.remove();
            refreshEmptyState();
          },
        },
      }));
      return;
    }
  });
}

// ── Brand campaigns (platform-awareness ads the owner creates + uploads creative for) ──
const OBJECTIVE_LABELS: Record<string, string> = { buyers: 'משיכת קונים', sellers: 'משיכת מוכרים' };
const PLATFORM_LABELS: Record<string, string> = { google: 'Google', meta: 'Meta' };
const DEFAULT_DEST: Record<string, string> = { buyers: '/', sellers: '/seller/register' };

interface SelectOption { value: string; label: string }
const OBJECTIVE_OPTS: SelectOption[] = [
  { value: 'buyers', label: 'משיכת קונים (לדף הבית)' },
  { value: 'sellers', label: 'משיכת מוכרים (להרשמת חנות)' },
];
const PLATFORM_OPTS: SelectOption[] = [{ value: 'google', label: 'Google' }, { value: 'meta', label: 'Meta' }];
const DURATION_OPTS: SelectOption[] = [
  { value: '', label: 'רציף' }, { value: '7', label: '7 ימים' }, { value: '14', label: '14 ימים' }, { value: '30', label: '30 ימים' },
];

// One shared portal for all brand-form dropdowns (only one open at a time). A
// module-level singleton — createFloatingPortal wires document listeners, so it
// must not be re-created per init call.
const brandSelectPortal: FloatingPortal = createFloatingPortal('admin-brand-select-portal');

// A styled single-select in the site's dropdown design language: a button + hidden
// input, options rendered into the shared floating portal (stays pinned to the
// trigger on scroll, clamps to the viewport, closes on outside-click/Escape).
function wireStyledSelect(cfg: { trigger: string; hidden: string; label: string; options: SelectOption[]; onChange?: (v: string) => void }): void {
  const trigger = document.getElementById(cfg.trigger) as HTMLButtonElement | null;
  const hidden = document.getElementById(cfg.hidden) as HTMLInputElement | null;
  const label = document.getElementById(cfg.label);
  if (!trigger || !hidden || !label) return;

  trigger.addEventListener('click', () => {
    if (brandSelectPortal.currentTrigger() === trigger) { brandSelectPortal.close(); return; }
    brandSelectPortal.open(trigger, '14rem', () => cfg.options.map((o) => {
      const selected = o.value === hidden.value;
      return `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-value="${escapeHtml(o.value)}" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${escapeHtml(o.label)}</button>`;
    }).join(''), (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const v = btn.dataset.value ?? '';
          hidden.value = v;
          label.textContent = cfg.options.find((o) => o.value === v)?.label ?? '';
          brandSelectPortal.close();
          cfg.onChange?.(v);
        });
      });
    });
  });
}

// Re-sync a styled select's visible label to its hidden value — used after a
// form.reset() (which reverts the hidden input but not the custom label).
function syncSelectLabel(labelId: string, hiddenId: string, options: SelectOption[]): void {
  const label = document.getElementById(labelId);
  const hidden = document.getElementById(hiddenId) as HTMLInputElement | null;
  if (label && hidden) label.textContent = options.find((o) => o.value === hidden.value)?.label ?? '';
}

interface BrandStats { impressions: number; clicks: number; ctr: number; spend: number; conversions: number }
interface BrandCampaignDTO {
  id: string; objective: string; headline: string; body: string; imageUrl?: string;
  destinationUrl: string; platform: string; monthlyBudget: number; status: 'active' | 'paused';
}

// Mirrors the SSR markup in AdminAdvertisingPanel.astro exactly, so the delegated
// list handlers work identically on a freshly-created card. All user-entered
// text is escaped — this is AJAX-built innerHTML (stored-XSS surface).
function brandCardHtml(c: BrandCampaignDTO, s: BrandStats): string {
  const paused = c.status === 'paused';
  const img = c.imageUrl ? `<img src="${escapeHtml(cdnSrc(c.imageUrl, 320))}" alt="" class="admin-brand-card__img" loading="lazy" decoding="async" />` : '';
  return `
    <div class="admin-brand-card" data-id="${escapeHtml(c.id)}" data-status="${c.status}">
      ${img}
      <div class="admin-brand-card__body">
        <div class="admin-brand-card__meta">
          <span class="admin-badge admin-badge--promo">${OBJECTIVE_LABELS[c.objective] ?? ''}</span>
          <span class="admin-badge admin-badge--pending">${PLATFORM_LABELS[c.platform] ?? ''}</span>
          ${paused ? '<span class="admin-badge admin-badge--warning" data-status-badge>מושהה</span>' : ''}
        </div>
        <strong class="admin-brand-card__headline">${escapeHtml(c.headline)}</strong>
        <p class="admin-brand-card__text">${escapeHtml(c.body)}</p>
        <a href="${escapeHtml(c.destinationUrl)}" target="_blank" rel="noopener" class="admin-brand-card__dest">${escapeHtml(c.destinationUrl)}</a>
        <div class="admin-brand-card__stats">
          <span><b>${s.impressions.toLocaleString('en-US')}</b> חשיפות</span>
          <span><b>${s.clicks.toLocaleString('en-US')}</b> קליקים</span>
          <span><b>${s.ctr}%</b> CTR</span>
          <span><b>${s.conversions.toLocaleString('en-US')}</b> המרות</span>
          <span><b>${escapeHtml(formatPrice(s.spend))}</b> הוצאה</span>
        </div>
        <div class="admin-brand-card__actions">
          <label class="admin-brand-card__budget">תקציב ₪ <input type="number" class="input" min="0" step="50" value="${c.monthlyBudget}" data-brand-budget /></label>
          <button type="button" class="admin-link" data-brand-save>עדכן</button>
          <button type="button" class="admin-link" data-brand-toggle>${paused ? 'הפעל' : 'השהה'}</button>
          <button type="button" class="admin-link admin-link--danger" data-brand-delete data-headline="${escapeHtml(c.headline)}">מחק</button>
        </div>
      </div>
    </div>`;
}

function initBrandImageUpload(): void {
  const btn = document.getElementById('brand-image-btn') as HTMLButtonElement | null;
  const file = document.getElementById('brand-image-file') as HTMLInputElement | null;
  const hidden = document.getElementById('brand-image-url') as HTMLInputElement | null;
  const preview = document.getElementById('brand-image-preview') as HTMLImageElement | null;
  const status = document.getElementById('brand-image-status');
  if (!btn || !file || !hidden || !preview) return;

  const CLOUD = import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME as string | undefined;
  const PRESET = import.meta.env.PUBLIC_CLOUDINARY_UPLOAD_PRESET as string | undefined;

  btn.addEventListener('click', () => {
    if (!CLOUD || !PRESET) { if (status) status.textContent = 'העלאת תמונות לא מוגדרת (Cloudinary).'; return; }
    file.click();
  });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (status) status.textContent = 'מעלה…';
    btn.disabled = true;
    try {
      const url = await cloudinaryUpload(f, CLOUD!, PRESET!);
      hidden.value = url;
      preview.src = url;
      preview.hidden = false;
      btn.textContent = 'החלף תמונה';
      if (status) status.textContent = '';
    } catch {
      if (status) status.textContent = 'ההעלאה נכשלה, נסו שוב.';
    } finally {
      btn.disabled = false;
    }
  });
}

function initBrandCreate(): void {
  const form = document.getElementById('brand-create-form') as HTMLFormElement | null;
  if (!form) return;
  const list = document.getElementById('brand-list');
  const empty = document.getElementById('brand-list-empty');
  const errorEl = document.getElementById('brand-create-error');
  const destination = document.getElementById('brand-destination') as HTMLInputElement | null;
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  // Styled dropdowns (site design language). The objective's onChange auto-fills
  // the destination — but only while it still holds a default value, so a custom
  // URL the owner typed is never clobbered.
  wireStyledSelect({
    trigger: 'brand-objective-trigger', hidden: 'brand-objective', label: 'brand-objective-label', options: OBJECTIVE_OPTS,
    onChange: (v) => {
      if (!destination) return;
      const current = destination.value.trim();
      if (current === '' || current === DEFAULT_DEST.buyers || current === DEFAULT_DEST.sellers) {
        destination.value = DEFAULT_DEST[v] ?? '/';
      }
    },
  });
  wireStyledSelect({ trigger: 'brand-platform-trigger', hidden: 'brand-platform', label: 'brand-platform-label', options: PLATFORM_OPTS });
  wireStyledSelect({ trigger: 'brand-duration-trigger', hidden: 'brand-duration', label: 'brand-duration-label', options: DURATION_OPTS });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errorEl) errorEl.hidden = true;
    const fd = new FormData(form);
    const headline = String(fd.get('headline') ?? '').trim();
    const body = String(fd.get('body') ?? '').trim();
    const budget = Number(fd.get('monthlyBudget')) || 0;
    if (!headline || !body || budget <= 0) { if (errorEl) errorEl.hidden = false; return; }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.add('btn--busy'); }
    try {
      const res = await fetch('/api/admin/brand-campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: fd.get('objective'),
          headline, body,
          imageUrl: fd.get('imageUrl') || undefined,
          destinationUrl: fd.get('destinationUrl'),
          platform: fd.get('platform'),
          monthlyBudget: budget,
          durationDays: fd.get('durationDays') ? Number(fd.get('durationDays')) : undefined,
        }),
      });
      if (!res.ok) throw new Error('request failed');
      const { campaign, stats } = await res.json() as { campaign: BrandCampaignDTO; stats: BrandStats };
      if (list) list.insertAdjacentHTML('afterbegin', brandCardHtml(campaign, stats));
      if (empty) empty.hidden = true;
      // Reset the form + image widget + styled-select labels for the next campaign.
      form.reset();
      syncSelectLabel('brand-objective-label', 'brand-objective', OBJECTIVE_OPTS);
      syncSelectLabel('brand-platform-label', 'brand-platform', PLATFORM_OPTS);
      syncSelectLabel('brand-duration-label', 'brand-duration', DURATION_OPTS);
      if (destination) destination.value = '/';
      const preview = document.getElementById('brand-image-preview') as HTMLImageElement | null;
      const hidden = document.getElementById('brand-image-url') as HTMLInputElement | null;
      const imgBtn = document.getElementById('brand-image-btn');
      if (preview) preview.hidden = true;
      if (hidden) hidden.value = '';
      if (imgBtn) imgBtn.textContent = 'העלה תמונה';
    } catch {
      showErrorToast('יצירת הקמפיין נכשלה, נסו שוב');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.classList.remove('btn--busy'); }
    }
  });
}

function initBrandList(): void {
  const list = document.getElementById('brand-list');
  const empty = document.getElementById('brand-list-empty');
  if (!list) return;

  list.addEventListener('click', async (e) => {
    const target = e.target as Element;
    const card = target.closest<HTMLElement>('.admin-brand-card');
    if (!card) return;
    const id = card.dataset.id ?? '';

    // ── Save budget ──
    const saveBtn = target.closest<HTMLButtonElement>('[data-brand-save]');
    if (saveBtn) {
      const input = card.querySelector<HTMLInputElement>('[data-brand-budget]');
      const budget = Number(input?.value) || 0;
      saveBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/brand-campaigns', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, monthlyBudget: budget }),
        });
        if (!res.ok) throw new Error('failed');
        saveBtn.textContent = 'נשמר ✓';
        setTimeout(() => { saveBtn.textContent = 'עדכן'; }, 1500);
      } catch { showErrorToast('העדכון נכשל, נסו שוב'); }
      finally { saveBtn.disabled = false; }
      return;
    }

    // ── Pause / resume ──
    const toggleBtn = target.closest<HTMLButtonElement>('[data-brand-toggle]');
    if (toggleBtn) {
      const nextStatus = card.dataset.status === 'paused' ? 'active' : 'paused';
      toggleBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/brand-campaigns', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status: nextStatus }),
        });
        if (!res.ok) throw new Error('failed');
        card.dataset.status = nextStatus;
        toggleBtn.textContent = nextStatus === 'paused' ? 'הפעל' : 'השהה';
        const meta = card.querySelector('.admin-brand-card__meta');
        let badge = meta?.querySelector<HTMLElement>('[data-status-badge]');
        if (nextStatus === 'paused') {
          if (!badge && meta) {
            badge = document.createElement('span');
            badge.className = 'admin-badge admin-badge--warning';
            badge.dataset.statusBadge = '';
            badge.textContent = 'מושהה';
            meta.appendChild(badge);
          }
        } else if (badge) { badge.remove(); }
      } catch { showErrorToast('הפעולה נכשלה, נסו שוב'); }
      finally { toggleBtn.disabled = false; }
      return;
    }

    // ── Delete (confirm) ──
    const delBtn = target.closest<HTMLButtonElement>('[data-brand-delete]');
    if (delBtn) {
      const name = delBtn.dataset.headline ?? '';
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: 'למחוק את הקמפיין?',
          message: `"${name}" יימחק לצמיתות.`,
          okLabel: 'מחק',
          workingLabel: 'מוחק…',
          onConfirm: async () => {
            const res = await fetch('/api/admin/brand-campaigns', {
              method: 'DELETE', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id }),
            });
            if (!res.ok) throw new Error('failed');
            card.remove();
            if (empty && !list.querySelector('.admin-brand-card')) empty.hidden = false;
          },
        },
      }));
      return;
    }
  });
}

// ── Date-range picker ──
// A floating-portal dropdown, same as every other range picker in the app
// (CURRENT_TASK.md) — replaced the earlier inline chips + always-visible custom
// row. Presets re-render the whole advertising panel over the chosen window via
// the admin's existing in-panel AJAX (buildAdminUrl + swapPanel); the SSR panel
// reads ?adpreset/adfrom/adto and recomputes, so there's no client-side markup
// to keep in sync. The trigger's label reflects the applied range (SSR-set).
const AD_PANEL_ID = 'dash-panel-advertising';
const AD_RANGE_PRESETS: { key: string; label: string }[] = [
  { key: 'today', label: 'היום' },
  { key: '7d', label: '7 ימים' },
  { key: '30d', label: '30 יום' },
  { key: 'thisMonth', label: 'החודש' },
];
// Cached once — initAdminAdvertisingPanel() re-runs on every panel swap, and
// createFloatingPortal registers document-level listeners per call, so building
// a fresh portal each time would leak them.
let adRangePortal: FloatingPortal | null = null;

function initAdRangePicker(): void {
  const root = document.getElementById('admin-ads-range');
  const trigger = document.getElementById('admin-ads-range-trigger');
  if (!root || !trigger) return;
  if (!adRangePortal) adRangePortal = createFloatingPortal('admin-ads-range-portal');
  const portal = adRangePortal;

  function navigate(params: Record<string, string | undefined>): void {
    portal.close();
    swapPanel(buildAdminUrl('advertising', params), AD_PANEL_ID, () => initAdminAdvertisingPanel());
  }

  function buildPanelHtml(): string {
    const active = root!.dataset.preset ?? '7d';
    const from = root!.dataset.from ?? '';
    const to = root!.dataset.to ?? '';
    const presetsHtml = AD_RANGE_PRESETS.map((p) =>
      `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-preset="${p.key}" style="${p.key === active ? 'font-weight:700;color:var(--color-primary)' : ''}">${p.label}</button>`).join('');
    return `${presetsHtml}
      <div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>
      <div class="px-3 pt-1.5 pb-2">
        <div class="text-[.72rem] [color:var(--color-muted)] mb-1.5">מותאם</div>
        <div class="flex items-center gap-1.5" dir="ltr">
          <input type="date" data-ad-from value="${from}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
          <span class="muted text-[0.8rem] shrink-0">–</span>
          <input type="date" data-ad-to value="${to}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
          <button type="button" class="btn btn--sm btn--accent shrink-0" data-ad-apply>הצג</button>
        </div>
      </div>`;
  }

  trigger.addEventListener('click', () => {
    if (portal.currentTrigger() === trigger) { portal.close(); return; }
    portal.open(trigger, '19rem', buildPanelHtml, (p) => {
      p.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => navigate({ adpreset: btn.dataset.preset }));
      });
      p.querySelector('[data-ad-apply]')?.addEventListener('click', () => {
        const from = p.querySelector<HTMLInputElement>('[data-ad-from]')?.value;
        const to = p.querySelector<HTMLInputElement>('[data-ad-to]')?.value;
        if (!from || !to) return;
        navigate({ adpreset: 'custom', adfrom: from, adto: to });
      });
    });
  });
}

// ── Top-store exposure bar chart (CURRENT_TASK.md) ──
// The SSR renders it at a default viewBox width; here we re-render it at the
// container's REAL pixel width (crisp text, no preserveAspectRatio stretch) and
// again on resize — the same approach the performance charts use — then bind the
// per-bar tooltip that reveals each store's full name. Boosted stores are tinted
// a different colour (carried per-point in the JSON blob). Data comes from
// #admin-ads-exposure-data; no refetch needed since a range change re-renders
// the whole panel server-side (swapPanel).
const exposureFmt = (v: number): string => `${v.toLocaleString('en-US')} חשיפות`;
// A range change re-runs initAdminAdvertisingPanel() on freshly-swapped DOM, so
// the previous observer would keep the detached old container + its render
// closure + parsed points alive (a growing leak per preset click). Kept module-
// level and disconnected before each re-init.
let exposureObserver: ResizeObserver | null = null;

function bindExposureTooltips(container: HTMLElement): void {
  const show = (e: MouseEvent): void => {
    const bar = (e.target as Element).closest('.chart-bar');
    if (!bar) { hideTooltip(); return; }
    showTooltipAtPoint(e.clientX, e.clientY, `${bar.getAttribute('data-label') ?? ''}: ${bar.getAttribute('data-value') ?? ''}`);
  };
  container.addEventListener('mouseover', show);
  container.addEventListener('mousemove', show);
  container.addEventListener('mouseleave', () => hideTooltip());
}

function initExposureChart(): void {
  const container = document.getElementById('admin-ads-exposure-chart');
  const dataEl = document.getElementById('admin-ads-exposure-data');
  if (!container || !dataEl) return;
  let points: BarChartPoint[] = [];
  try { points = JSON.parse(dataEl.textContent ?? '[]') as BarChartPoint[]; } catch { return; }
  if (points.length === 0) return;

  let first = true;
  const render = (): void => {
    const width = Math.round(container.getBoundingClientRect().width) || 640;
    container.innerHTML = buildBarChartSvg(points, { rtl: true, height: 220, width, valueFormatter: exposureFmt, emptyMessage: 'אין עדיין נתוני חשיפה לפי חנות.', animate: first });
    first = false;
  };
  render();
  bindExposureTooltips(container);
  if (typeof ResizeObserver !== 'undefined') {
    exposureObserver?.disconnect(); // drop the observer bound to the previous (now detached) container
    let raf = 0;
    exposureObserver = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); });
    exposureObserver.observe(container);
  }
}

export function initAdminAdvertisingPanel(): void {
  initInfoTooltips();
  initAdRangePicker();
  initBaselineForm();
  initPromotedList();
  initBrandImageUpload();
  initBrandCreate();
  initBrandList();
  initExposureChart();
}
