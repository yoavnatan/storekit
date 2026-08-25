/**
 * The cookie notice's dismiss, and the preference control that lives on `/privacy`.
 *
 * Two entry points because they are two different jobs and only one of them is on every page:
 * `initConsentNotice` closes a notice, and `initConsentPreferences` changes what runs. Read
 * `lib/consent.ts` for why the second one is not on the bar.
 *
 * **Nothing is ever unloaded here, and that is not laziness.** A tag cannot be recalled — the
 * request has already been made. So switching a category off writes the preference and RELOADS, and
 * the server then renders a page with no such tag on it. Hiding it, or deleting the script element,
 * would be exactly the false comfort a preference control must not give.
 */
import {
  CONSENT_COOKIE,
  CONSENT_COOKIE_DAYS,
  consentModeSignal,
  effectiveConsent,
  parseConsent,
  serializeConsent,
  type Consent,
} from '../lib/consent.js';

function writeCookie(c: Consent): void {
  const maxAge = CONSENT_COOKIE_DAYS * 24 * 60 * 60;
  // Not `httpOnly` by design (lib/consent.ts) — the server reads it on the next request and the
  // page has to write it without one. `SameSite=Lax` so it survives arriving from an ad click.
  document.cookie = `${CONSENT_COOKIE}=${serializeConsent(c)};path=/;max-age=${maxAge};SameSite=Lax`;
}

function readCookie(name: string): string | undefined {
  const hit = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}

/**
 * The bar: show it if this visitor has never been told, and record the dismissal.
 *
 * **Dismissing records `CONSENT_ALL`, not "seen".** There is no separate "was notified" flag on
 * purpose: the state a dismissal leaves is the state that was already in force while the bar was
 * on screen, so pressing "הבנתי" changes nothing about what runs — it only stops the notice
 * returning. A second flag would be a second thing that can disagree with the first.
 */
/**
 * The height the notice is occupying at the bottom of the viewport, published on `documentElement`
 * so anything else pinned down there can get out of its way.
 *
 * **This is not polish — without it the bar HID the "add to cart" button.** Measured 2026-08-25 at
 * 375px on a product page: the notice was 124px tall at `z-index: 60`, the sticky cart bar 69px at
 * `z-index: 40`, and the overlap was the entire cart bar. A shopper arriving on a product page from
 * an ad — the main traffic shape this site is built for — could not buy. Nothing reported it,
 * because both elements were behaving exactly as written.
 *
 * Two consequences needing two different fixes, which is why this function does two things:
 *   · a `position: fixed` bar is NOT moved by page padding, so it reads this variable and lifts
 *     (`#sticky-cart-bar`, styles/pages/product.css);
 *   · content at the very end of the document IS fixed by padding, so the body gets it.
 *
 * Re-measured on resize because the bar's height changes as its text rewraps, and cleared on
 * dismissal so nothing goes on reserving space for an element that is gone.
 */
function publishBarHeight(bar: HTMLElement): void {
  const h = bar.classList.contains('!hidden') ? 0 : Math.ceil(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--consent-bar-h', `${h}px`);
  document.body.style.paddingBottom = h ? `${h}px` : '';
}

export function initConsentNotice(): void {
  const bar = document.getElementById('consent-notice');
  if (!bar) return;

  if (bar.dataset.consentShow !== undefined) bar.classList.remove('!hidden');
  publishBarHeight(bar);
  window.addEventListener('resize', () => publishBarHeight(bar));

  document.getElementById('consent-dismiss')?.addEventListener('click', () => {
    writeCookie(effectiveConsent(parseConsent(readCookie(CONSENT_COOKIE))));
    bar.classList.add('!hidden');
    publishBarHeight(bar);
  });
}

/**
 * The preference control, rendered only inside the cookies clause of `/privacy`.
 *
 * Reflects what is in force — through `effectiveConsent`, so a visitor who never touched it sees
 * both boxes ticked, which is the truth rather than a blank form implying nothing is running.
 */
export function initConsentPreferences(): void {
  const form = document.getElementById('consent-prefs');
  if (!form) return;

  const cbAnalytics = document.getElementById('consent-analytics') as HTMLInputElement | null;
  const cbAds = document.getElementById('consent-ads') as HTMLInputElement | null;
  const save = document.getElementById('consent-save');
  const saved = document.getElementById('consent-saved');

  const current = effectiveConsent(parseConsent(readCookie(CONSENT_COOKIE)));
  if (cbAnalytics) cbAnalytics.checked = current.analytics;
  if (cbAds) cbAds.checked = current.ads;

  save?.addEventListener('click', () => {
    const next: Consent = {
      analytics: !!cbAnalytics?.checked,
      ads: !!cbAds?.checked,
    };
    writeCookie(next);

    // Consent Mode's `update`, so Google's own gate hears the change on THIS page too and not only
    // after the reload. Built by `consentModeSignal` — the same function the server uses for the
    // `default` call, because two spellings of the same four signals is two things to get wrong.
    // Pushed as an `arguments`-shaped array, which is what `gtag()` produces and what the container
    // reads; an object literal is a different shape and is ignored.
    const w = window as unknown as { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer ?? [];
    w.dataLayer.push(['consent', 'update', consentModeSignal(next)]);

    if (saved) saved.hidden = false;

    // A tag already loaded on this page cannot be recalled, so switching something OFF only really
    // takes effect on a page the server renders without it. Reload rather than claim otherwise —
    // and only when something was actually turned off, since turning one back ON needs no reload
    // to be true (the next navigation picks it up) and a reload there would just lose the reader's
    // place in a long policy page.
    const turnedOff = (current.analytics && !next.analytics) || (current.ads && !next.ads);
    if (turnedOff) window.location.reload();
  });
}
