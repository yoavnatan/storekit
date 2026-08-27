/**
 * Keeps the settings sheet's header preview showing what the seller has just done.
 *
 * **The bug this closes.** `HeaderStyleCard` renders the "name" option as a miniature of the real
 * store header — the avatar and the shop's name, drawn with the same components the storefront
 * uses. It was painted once on the server and never touched again, so a seller who uploaded a
 * profile picture or renamed the shop went on being shown the OLD one, in the one control whose
 * entire job is to answer "which of these two headers do I want" (owner, 2026-08-27: *"אם העלתי
 * תמונה או שיניתי את השם, עדיין רואים את הקודמים"*).
 *
 * It failed in the direction that costs the most: a preview that disagrees with the site is worse
 * than no preview, because the seller believes it. The header-LOGO half of the same card has been
 * live-updating since it was built (`header-logo.ts`), which is what made the stale half look
 * deliberate rather than missing.
 *
 * **Why it listens for `input` on a hidden field.** The picture is not typed — it arrives from the
 * crop-and-upload widget, which writes the Cloudinary URL into `#avatar-image-input` and calls
 * `announceValueChange` (`store-image.ts` → `unsaved-guard.ts`), dispatching a bubbling `input`
 * event for exactly this kind of listener. Hooking the widget instead would mean a second way to
 * learn the same fact, and the widget already publishes it.
 *
 * **What it does NOT do:** save anything. This is the settings form, and the whole sheet saves with
 * one button (memory `feedback_ajax_forms`) — a preview that wrote on its own would be the split
 * that rule exists to prevent.
 */
import { cdnSrc } from '../../lib/cdn.js';
import { storeMark } from '../../lib/store-mark.js';

/** The size StoreAvatar is rendered at inside the preview bar. Mirrors HeaderStyleCard. */
const AVATAR_SIZE = 32;

function settingsNameInput(): HTMLInputElement | null {
  // Scoped to the settings form: the "create your first store" card on the same page has an input
  // called `name` too, and a page-wide lookup binds to whichever the DOM happens to hold first.
  const form = document.getElementById('settings-form');
  if (!form) return null;
  return form.querySelector<HTMLInputElement>('input[name="name"]');
}

export function initHeaderPreview(): void {
  const card = document.getElementById('header-style-card');
  if (!card) return;
  const slug = card.dataset.slug ?? '';
  const slot = document.getElementById('header-preview-avatar');
  const nameText = card.querySelector<HTMLElement>('.store-name-text');
  const nameInput = settingsNameInput();
  const imageInput = document.getElementById('avatar-image-input') as HTMLInputElement | null;
  if (!slot || !nameText) return;

  /** The picture, or the coloured plate with the shop's first letter — never both. */
  function paintAvatar(name: string, image: string): void {
    if (image) {
      const img = slot!.firstElementChild instanceof HTMLImageElement
        ? slot!.firstElementChild
        : null;
      // Reuse the <img> when there already is one: replacing it throws away a decoded picture and
      // re-decodes the same bytes, which flashes on exactly the widget that just uploaded them.
      const src = cdnSrc(image, AVATAR_SIZE * 2);
      if (img) {
        if (img.src !== src) img.src = src;
        return;
      }
      const fresh = document.createElement('img');
      fresh.src = src;
      fresh.alt = '';
      fresh.decoding = 'async';
      fresh.width = AVATAR_SIZE;
      fresh.height = AVATAR_SIZE;
      fresh.className = 'rounded-full object-cover flex-shrink-0 store-header__logo';
      fresh.style.cssText = `width:${AVATAR_SIZE}px;height:${AVATAR_SIZE}px;border:1px solid var(--color-border);background:var(--color-surface)`;
      slot!.replaceChildren(fresh);
      return;
    }

    // No picture: the plate. The colour comes from the SLUG and only the letter from the name, so
    // typing a new name recolours nothing — which is the behaviour the storefront has.
    const mark = storeMark(slug, name);
    const plate = slot!.firstElementChild instanceof HTMLSpanElement ? slot!.firstElementChild : null;
    if (plate) {
      plate.textContent = mark.initial;
      return;
    }
    const fresh = document.createElement('span');
    fresh.className = 'rounded-full flex-shrink-0 flex items-center justify-center font-bold text-white store-header__logo';
    fresh.style.cssText = `width:${AVATAR_SIZE}px;height:${AVATAR_SIZE}px;`
      + `background:linear-gradient(135deg, ${mark.from}, ${mark.to});`
      + `font-size:${Math.round(AVATAR_SIZE * 0.42)}px;border:1px solid var(--color-border)`;
    fresh.setAttribute('aria-hidden', 'true');
    fresh.textContent = mark.initial;
    slot!.replaceChildren(fresh);
  }

  const sync = (): void => {
    const name = nameInput?.value ?? nameText.textContent ?? '';
    nameText.textContent = name;
    paintAvatar(name, imageInput?.value ?? '');
  };

  nameInput?.addEventListener('input', sync);
  // The widget writes the URL and announces it; removing the picture clears the same field and
  // announces that too, so both directions arrive here through one listener.
  imageInput?.addEventListener('input', sync);
}
