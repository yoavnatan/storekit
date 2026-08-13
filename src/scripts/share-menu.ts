/**
 * Behaviour for `ShareMenu.astro` — open/close, copy link, OS share sheet.
 *
 * **Everything this file adds is an ENHANCEMENT.** The four network items are server-rendered
 * `<a href>`s that work with the script missing or broken; what runs here is the panel's
 * open/close, the two items that are not navigations (copy, native sheet), and the analytics
 * event. Nothing here may be the only way to share.
 *
 * Delegated from `document`, and menus are located by attribute rather than id: the component
 * appears once per page today (store banner / product page), but a page that renders two — a
 * product page that grows a "share this store" — must not need a second wiring.
 */
import { showToast, showActionFailedToast } from '../lib/toast.js';

let wired = false;

function panelOf(menu: HTMLElement): HTMLElement | null {
  return menu.querySelector<HTMLElement>('[data-share-panel]');
}

function closeMenu(menu: HTMLElement): void {
  const panel = panelOf(menu);
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  menu.querySelector<HTMLButtonElement>('[data-share-trigger]')?.setAttribute('aria-expanded', 'false');
}

function closeAll(except?: HTMLElement): void {
  for (const menu of document.querySelectorAll<HTMLElement>('[data-share-menu]')) {
    if (menu !== except) closeMenu(menu);
  }
}

/** Clear of the viewport edge, in px. Below this the panel reads as pinned to the screen rather
 *  than dropped from the button — and at 320px it was leaving the screen outright. */
const EDGE_MARGIN = 12;

/**
 * Keep the open panel inside the viewport.
 *
 * The CSS anchors it to one edge of the trigger and lets it grow outward, which is right until the
 * trigger sits near the edge of the screen — and this one does, at both ends: the store banner's
 * actions row starts at the container's inline-start, and the product page's row is in the buy
 * column. Measured across seven widths it overflowed at four of them, worst 17px off-screen on the
 * product page at 768.
 *
 * Nudged with a PHYSICAL `left`, not with `transform`: the panel's entrance animation animates
 * `transform`, and an animation outranks an inline style for its whole duration — the nudge would
 * have been ignored for 130ms and then jumped into place. Physical rather than logical because the
 * sign of a logical inset flips with `dir`, while this is arithmetic on a measured rect, which is
 * physical already. The CSS inset is released in the same breath, or it keeps anchoring the side
 * the nudge is moving away from.
 */
function positionPanel(panel: HTMLElement): void {
  panel.style.left = '';
  panel.style.insetInlineStart = '';
  panel.style.insetInlineEnd = '';

  const parent = panel.offsetParent as HTMLElement | null;
  if (!parent) return;
  const rect = panel.getBoundingClientRect();

  const maxLeft = window.innerWidth - EDGE_MARGIN - rect.width;
  const wantedLeft = Math.max(EDGE_MARGIN, Math.min(rect.left, maxLeft));
  if (Math.abs(wantedLeft - rect.left) < 0.5) return;

  panel.style.insetInlineStart = 'auto';
  panel.style.insetInlineEnd = 'auto';
  panel.style.left = `${wantedLeft - parent.getBoundingClientRect().left}px`;
}

function openMenu(menu: HTMLElement): void {
  const panel = panelOf(menu);
  if (!panel) return;
  closeAll(menu);
  panel.hidden = false;
  positionPanel(panel);
  menu.querySelector<HTMLButtonElement>('[data-share-trigger]')?.setAttribute('aria-expanded', 'true');
}

/**
 * GA4's own `share` event. Which channel a shopper reaches for is the only signal that says
 * whether this feature earns its place, and it costs one push.
 *
 * `item_id` is the CATALOG id the server put on the element, and it is omitted rather than sent
 * empty — both rules are `lib/tracking.ts`'s (`reportable`, and the ad-item-id join), and this
 * event has to obey them for the same reason: an id that joins to nothing is counted as a failed
 * match, which is a number the owner would then be debugging instead of reading.
 *
 * Never throws into the caller: a GTM container edited by someone who never touches this repo can
 * throw straight back out of `push`, and a share that opened WhatsApp must not depend on that.
 */
function trackShare(menu: HTMLElement, method: string): void {
  const itemId = menu.dataset.shareItemId ?? '';
  try {
    window.dataLayer?.push({
      event: 'share',
      method,
      content_type: menu.dataset.shareContentType ?? '',
      store_id: menu.dataset.shareStoreId ?? '',
      ...(itemId ? { item_id: itemId } : {}),
    });
  } catch {
    /* analytics must never break a share */
  }
}

/** Clipboard, with the pre-`navigator.clipboard` path for a non-secure origin (a phone opening
 *  the dev server over plain http, and any browser where the permission is refused). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** The menu items in DOM order, minus the ones the page is not offering (the native sheet is
 *  hidden where there is no `navigator.share`). */
function items(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter((el) => !el.hidden);
}

export function initShareMenus(): void {
  if (wired) return;
  wired = true;

  // The OS sheet exists only on some devices, so the item ships hidden and is revealed here —
  // the opposite order (render it, hide it if unsupported) is a menu that visibly reflows on
  // desktop the moment the script runs.
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    for (const btn of document.querySelectorAll<HTMLElement>('[data-share-native]')) btn.hidden = false;
  }

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const menu = target.closest<HTMLElement>('[data-share-menu]');
    if (!menu) {
      closeAll();
      return;
    }

    const url = menu.dataset.shareUrl ?? '';
    const title = menu.dataset.shareTitle ?? '';

    if (target.closest('[data-share-trigger]')) {
      const panel = panelOf(menu);
      if (panel?.hidden) {
        openMenu(menu);
        items(menu)[0]?.focus();
      } else {
        closeMenu(menu);
      }
      return;
    }

    const copyBtn = target.closest<HTMLElement>('[data-share-copy]');
    if (copyBtn) {
      void copyText(url).then((ok) => {
        if (ok) {
          showToast(copyBtn.dataset.strCopied ?? '');
          trackShare(menu, 'copy_link');
        } else {
          showActionFailedToast();
        }
        closeMenu(menu);
      });
      return;
    }

    if (target.closest('[data-share-native]')) {
      closeMenu(menu);
      // `text` is the TITLE ONLY, with the link left to `url` — deliberately not the one-blob form
      // the network links use. A target given both a url and a text that already contains one
      // shows the link twice (Android Chrome concatenates `text` + `url`), and duplication reads
      // as broken. The other direction costs at most a dropped title on a target that ignores it,
      // where the page's own Open Graph card supplies the name anyway.
      navigator
        .share?.({ title, text: title, url })
        .then(() => trackShare(menu, 'native'))
        // AbortError is the user closing the sheet — not a failure, and nothing to say about it.
        .catch(() => {});
      return;
    }

    const link = target.closest<HTMLElement>('[data-share-channel]');
    if (link) {
      trackShare(menu, link.dataset.shareChannel ?? '');
      closeMenu(menu);
    }
  });

  document.addEventListener('keydown', (e) => {
    const open = Array.from(document.querySelectorAll<HTMLElement>('[data-share-menu]')).find(
      (m) => panelOf(m)?.hidden === false,
    );
    if (!open) return;

    if (e.key === 'Escape') {
      closeMenu(open);
      open.querySelector<HTMLButtonElement>('[data-share-trigger]')?.focus();
      return;
    }
    // Up/Down only — a vertical menu names no on-screen direction that RTL would mirror, which
    // is what lib/arrow-step.ts exists for and why it is deliberately not used here.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const list = items(open);
    if (list.length === 0) return;
    e.preventDefault();
    const current = list.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? list.length - 1
      : e.key === 'ArrowDown' ? (current + 1 + list.length) % list.length
      : (current - 1 + list.length) % list.length;
    list[next]?.focus();
  });

  // Tabbing out of the menu closes it — an open panel with focus somewhere else is a panel the
  // keyboard has abandoned. Gated on `relatedTarget` being a real element ON PURPOSE: a mouse
  // click on a link inside the panel reports `relatedTarget: null` in the browsers that do not
  // focus a clicked anchor (Safari, Firefox on macOS), and closing there would hide the item
  // between mousedown and mouseup — the click event then never fires and the share silently
  // does nothing. Outside clicks are already handled by the document click listener above.
  document.addEventListener('focusout', (e) => {
    const menu = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-share-menu]');
    const next = e.relatedTarget as HTMLElement | null;
    if (!menu || !next) return;
    if (!menu.contains(next)) closeMenu(menu);
  });
}
