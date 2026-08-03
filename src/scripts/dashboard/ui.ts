import { reportClientError } from '../error-reporter.js';
import { arrowStep, wrapIndex } from '../../lib/arrow-step.js';
import { markDashboardStale, conflictMessage } from './tab-sync.js';

const checkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>`;

function getI18nDict(): Record<string, unknown> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export function initSettingsForm(): void {
  const settingsForm = document.getElementById('settings-form') as HTMLFormElement | null;
  // A single button pinned to the bottom of the whole Settings tab (below
  // Categories too), associated via form="settings-form" rather than living
  // inside the <form> — Categories has its own nested <form> lower down, so
  // settings-form's own closing tag can't just be moved past it. Not found
  // with settingsForm.querySelector() because of that, hence the plain
  // getElementById.
  const saveBtn = document.getElementById('settings-save-btn') as HTMLButtonElement | null;

  settingsForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const origText = saveBtn?.textContent ?? '';

    if (saveBtn) {
      saveBtn.style.minWidth = `${saveBtn.offsetWidth}px`;
      saveBtn.disabled = true;
      // btn--busy: the save is in progress, not blocked — show the "working"
      // cursor (progress), never the disabled "no-entry" (not-allowed).
      saveBtn.classList.add('btn--busy');
      saveBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:0.5em">שומר<span class="dot-pulse" role="status" aria-label="שומר"><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span></span>`;
    }

    const toastError = (title: string, body: string) =>
      window.dispatchEvent(new CustomEvent('toast:show', { detail: { title, body, duration: 6000 } }));
    const reEnableSave = () => {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove('btn--busy'); saveBtn.style.minWidth = ''; saveBtn.textContent = origText; }
    };

    const fd = new FormData(settingsForm);
    // The revisions this form was rendered with — what lets the server merge this save
    // into the stored settings field by field instead of overwriting them. `force` rides
    // alongside (never instead), settling only the fields two tabs set differently.
    if (settingsForm.dataset.baseRev) fd.set('baseRev', settingsForm.dataset.baseRev);
    if (settingsForm.dataset.forceSave === '1') fd.set('force', '1');
    delete settingsForm.dataset.forceSave;

    // 1) Could we even reach the server? A rejected fetch = offline / server
    //    unreachable. Nothing to log server-side (the log endpoint lives on the
    //    same server), so just tell the seller it's a connection problem.
    let res: Response;
    try {
      res = await fetch('/api/store', { method: 'POST', body: fd });
    } catch {
      toastError('לא הצלחנו להתחבר לשרת', 'בדקו את החיבור לאינטרנט ונסו שוב.');
      reEnableSave();
      return;
    }

    // 2) Server answered — read its verdict (a crash page may not be JSON).
    type StoreSaveResult = { ok?: boolean; name?: string; error?: string; conflict?: boolean; conflictFields?: string[]; rev?: string };
    let data: StoreSaveResult | null = null;
    try { data = await res.json() as StoreSaveResult; } catch { /* non-JSON body */ }

    // 2a) Some field here was set differently in another tab (or on another device)
    //     after this form was rendered. Nothing was written; everything else in the form
    //     merges either way, so the only question is whose value those fields take.
    if (data?.conflict) {
      const i18n = getI18nDict();
      reEnableSave();
      markDashboardStale();
      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: String(i18n.conflictTitle ?? 'Changed somewhere else'),
          message: conflictMessage(data.conflictFields, i18n),
          okLabel: String(i18n.conflictOverwrite ?? 'Use my value'),
          onConfirm: () => { settingsForm.dataset.forceSave = '1'; settingsForm.requestSubmit(); },
        },
      }));
      return;
    }

    if (!res.ok || !data?.ok) {
      // A 4xx WITH a message is normal input validation — show it, don't alert
      // the admin. Anything else (5xx, unparseable body) is a genuine fault the
      // server may not have logged itself (proxy/infra/parse) — best-effort
      // report it to the admin error log (per-session capped in reportClientError).
      const isValidation = res.status >= 400 && res.status < 500 && !!data?.error;
      if (isValidation) {
        toastError('השמירה נכשלה', data!.error!);
      } else {
        reportClientError(`settings save failed (status ${res.status})`);
        toastError('שגיאה בשמירה', 'משהו השתבש בצד השרת. נסו שוב בעוד רגע.');
      }
      reEnableSave();
      return;
    }

    // The form stays on screen, so it now represents what was just saved — take the
    // new revision before anything else, or the seller's own next save conflicts with
    // this one.
    if (data.rev) settingsForm.dataset.baseRev = data.rev;

    // Settings is the one guarded form that stays on screen after saving, so it can't
    // go clean by being closed the way an edit row does — tell the unsaved guard
    // (unsaved-guard.ts) to retake its baseline, or leaving would still prompt.
    window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form: settingsForm } }));

    const newName = data.name ?? String(fd.get('name'));
    const storeNameEl = document.querySelector<HTMLElement>('.dash-store-name');
    if (storeNameEl) storeNameEl.textContent = newName;

    if (saveBtn) {
      // btn--confirmed: stays disabled through the 1.5s ✓ hold to block a
      // double-submit, but reads as a success confirmation — full opacity +
      // default cursor, not the disabled not-allowed.
      saveBtn.classList.remove('btn--busy');
      saveBtn.classList.add('btn--confirmed');
      saveBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px">${checkSvg}נשמר</span>`;
      saveBtn.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
        { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
      );
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.classList.remove('btn--confirmed');
        saveBtn.style.minWidth = '';
        saveBtn.textContent = origText;
      }, 1500);
    }
  });
}

/**
 * "View store" opens a preview tab.
 *
 * It goes through `window.open` rather than letting the link navigate, because a link-opened
 * context is only script-closable while it holds a single history entry — script-creating it is
 * what lets the store page's "back to dashboard" bar close the tab and return here however far the
 * seller browsed. The link itself stays the no-JS fallback.
 *
 * **`_blank`, never a named target — reported by a seller 2026-08-03.** This used to open into a
 * window NAMED `dezabin-store-preview`, so that a second click reused one preview tab instead of
 * piling them up. A window name is browser-wide and it STICKS: once a tab has been given that name
 * it keeps it after the seller navigates it somewhere else entirely, so the next "צפה בחנות"
 * reached across and took over whatever they had open in it. Reusing one tab was never worth
 * hijacking an unrelated one, and `_blank` costs nothing that mattered — the tab is still
 * script-created, so it is still closable, which is the only reason `window.open` is here at all.
 */
export function initStorePreviewLink(): void {
  const link = document.getElementById('dash-view-store') as HTMLAnchorElement | null;
  link?.addEventListener('click', (e) => {
    const opened = window.open(link.href, '_blank');
    if (opened) { e.preventDefault(); opened.focus(); }
  });
}

export function initFormToggles(): void {
  const toggleAdd  = document.getElementById('toggle-add-form');
  const addFormWrap = document.getElementById('add-product-form');
  const cancelAdd  = document.getElementById('cancel-add');

  toggleAdd?.addEventListener('click', () => {
    addFormWrap?.removeAttribute('hidden');
    toggleAdd.setAttribute('hidden', '');
    document.getElementById('csv-panel')?.setAttribute('hidden', '');
  });
  cancelAdd?.addEventListener('click', () => {
    addFormWrap?.setAttribute('hidden', '');
    toggleAdd?.removeAttribute('hidden');
  });
}

export function initStoreHours(): void {
  const container = document.getElementById('hours-editor');
  container?.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    if (!target.matches('.hours-closed-toggle')) return;
    target.closest('.hours-row')?.querySelectorAll<HTMLInputElement>('.hours-time')
      .forEach((input) => { input.disabled = target.checked; });
  });

  const visibilityToggles: [string, string][] = [
    ['address-visible-toggle', 'store-address-field'],
    ['hours-visible-toggle', 'store-hours-field'],
  ];
  for (const [toggleId, fieldsId] of visibilityToggles) {
    const toggle = document.getElementById(toggleId) as HTMLInputElement | null;
    const fieldsWrap = document.getElementById(fieldsId);
    toggle?.addEventListener('change', () => {
      fieldsWrap?.setAttribute('data-open', String(toggle.checked));
    });
  }
}

export function initStoreSwitcher(): void {
  const btn  = document.getElementById('store-switcher-btn') as HTMLButtonElement | null;
  const menu = document.getElementById('store-switcher-menu') as HTMLElement | null;
  if (!btn || !menu) return;

  function open() {
    menu!.hidden = false;
    btn!.setAttribute('aria-expanded', 'true');
    (menu!.querySelector<HTMLAnchorElement>('a'))?.focus();
  }

  function close(returnFocus = true) {
    menu!.hidden = true;
    btn!.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn?.focus();
  }

  btn.addEventListener('click', () => menu.hidden ? open() : close(false));

  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target as Node) && !menu.contains(e.target as Node)) {
      if (!menu.hidden) close(false);
    }
  });

  btn.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    const items = [...menu.querySelectorAll<HTMLAnchorElement>('a')];
    const idx   = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
}

export function initAutoHideStatus(): void {
  document.querySelectorAll<HTMLElement>('.dash-success, .dash-error').forEach((el) => {
    setTimeout(() => el.remove(), 3000);
  });
}

export function initDashTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-panel]');

  // Activation itself lives in the inline <DashTabsBoot /> script, which is
  // already handling clicks by the time this module arrives — that is the whole
  // point of it (a tab must not wait on a 61 KB bundle over a weak connection).
  // Here we only add what genuinely needs the module. No click binding: the
  // boot's delegated listener already covers every tab, and a second one would
  // just run the same DOM flips twice.
  const activateTab = (tab: HTMLButtonElement): void => window.__dashTabActivate?.(tab);

  tabs.forEach(tab => {
    tab.addEventListener('keydown', (e: KeyboardEvent) => {
      const list = [...tabs];
      const idx  = list.indexOf(tab);
      // Horizontal arrows go through arrowStep(), which mirrors them in RTL —
      // this strip runs right→left in Hebrew, so ArrowRight has to walk
      // BACKWARD through the source order to reach the tab that is actually to
      // the right (owner, 2026-08-01). The vertical pair never flips:
      // `direction` mirrors the inline axis only.
      const step = arrowStep(e.key, tab)
        || (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0);
      if (step === 0) return;
      e.preventDefault();
      const target = list[wrapIndex(idx, step, list.length)] as HTMLButtonElement;
      target.focus(); activateTab(target);
    });
  });

  // Roving tabindex: exactly ONE tab is in the Tab order, and it must be the
  // SELECTED one — that is what makes Tab land on the tab you are actually on
  // and Shift+Tab leave from there. This used to hardcode index 0, which quietly
  // overrode both the SSR value and whatever __dashTabActivate had already set:
  // land on /?panel=liked and focus went to "discover" instead (owner,
  // 2026-08-01). Falls back to the first tab only when nothing is marked
  // selected, so a strip is never left with no way in.
  const selected = [...tabs].find(t => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
  tabs.forEach(tab => tab.setAttribute('tabindex', tab === selected ? '0' : '-1'));

  // A section-tab strip (.dash-tabs) scrolls horizontally when it overflows, but
  // a mouse-only user with no sideways scroll wheel can't reach the hidden tabs
  // (the scrollbar is hidden) and the tabs aren't draggable — the exact gap
  // flagged in CURRENT_TASK.md item 1. So translate a vertical wheel into
  // horizontal scroll, and flag an overflowing strip so CSS fades its edges as a
  // "there's more" hint. Keyboard (arrow keys above) + touch already work.
  document.querySelectorAll<HTMLElement>('.dash-tabs').forEach((strip) => {
    // Inject the two white edge-fade overlays once (sticky flex children pinned
    // to each edge — see .dash-tab-fade in dashboard.css). aria-hidden + no role
    // so the [role="tab"] queries never treat them as tabs.
    if (!strip.querySelector('.dash-tab-fade')) {
      for (const edge of ['start', 'end'] as const) {
        const fade = document.createElement('span');
        fade.className = `dash-tab-fade dash-tab-fade--${edge}`;
        fade.setAttribute('aria-hidden', 'true');
        if (edge === 'start') strip.prepend(fade); else strip.append(fade);
      }
    }
    const syncEdges = (): void => {
      const scrollable = strip.scrollWidth > strip.clientWidth + 1;
      strip.classList.toggle('is-scrollable', scrollable);
      const max = strip.scrollWidth - strip.clientWidth;
      const sl = Math.abs(strip.scrollLeft); // RTL can report scrollLeft negative
      // Hide the fade on whichever end is fully reached, so a resting end tab
      // isn't dimmed; show it when there's still content that way.
      strip.classList.toggle('at-start', !scrollable || sl <= 1);
      strip.classList.toggle('at-end', !scrollable || sl >= max - 1);
    };
    syncEdges();
    strip.addEventListener('scroll', syncEdges, { passive: true });
    if ('ResizeObserver' in window) new ResizeObserver(syncEdges).observe(strip);
    // Wheel-down should advance the tabs start → end (intuitive direction). In
    // RTL the strip's start is on the right and scrollLeft runs negative toward
    // the end, so wheel-down must DECREASE scrollLeft there — hence the sign flip
    // (without it, scrolling down walked back toward the start).
    const rtl = getComputedStyle(strip).direction === 'rtl';
    strip.addEventListener('wheel', (e: WheelEvent) => {
      if (!e.deltaY || strip.scrollWidth <= strip.clientWidth) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // a real horizontal gesture — leave it
      strip.scrollLeft += rtl ? -e.deltaY : e.deltaY;
      e.preventDefault();
    }, { passive: false });
    // Horizontal only, via the boot's shared helper — see its comment for why a
    // scrollIntoView here scrolled the whole page instead (sticky strip).
    const active = strip.querySelector<HTMLElement>('.dash-tab--active');
    if (active) window.__dashTabReveal?.(active);
  });
}

// Overview stat cards ([data-goto-panel], e.g. AdminOverviewPanel.astro / the
// seller dashboard's overview tab) jump straight to their tab by clicking the
// matching tab button — reuses initDashTabs()'s own click handler instead of
// a real navigation, which would flash a full page reload.
export function initGotoPanelLinks(): void {
  document.querySelectorAll<HTMLElement>('[data-goto-panel]').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelector<HTMLButtonElement>(`[role="tab"][data-panel="${el.dataset.gotoPanel}"]`)?.click();
      // A source that names a control (data-goto-open) also opens it. The onboarding checklist's
      // "add your first product" step used to land the seller on the Products tab with the add
      // form still collapsed behind a toolbar of six buttons — the one step the checklist calls
      // required was the one it stopped short of. Clicking the toggle is deliberate rather than
      // un-hiding the form directly: initFormToggles() owns that pair's state (it also hides the
      // toggle and the CSV panel), and a second mechanism setting the same attributes is how the
      // two drift. Re-clicking an already-open form is a no-op.
      const openId = el.dataset.gotoOpen;
      if (openId) document.getElementById(openId)?.click();
    });
  });
}
