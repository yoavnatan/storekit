// @vitest-environment jsdom
/**
 * Linking a colour to a photo that has not been uploaded yet.
 *
 * **The bug.** The gallery uploads to Cloudinary at SAVE time, never when a photo is picked
 * (`gallery.ts#resolveGalleryUrls`, awaited by the submit handler) — deliberately, because
 * uploading on pick spends the account's quota on every abandoned edit, and a spent quota blocks
 * every upload on the platform. Until the save, a picked photo is an in-memory blob and its
 * `.gallery-slot__url` input is EMPTY.
 *
 * The variant-image picker read those inputs and dropped the blanks, so it could not see the photo
 * the seller had just added: the popover said "upload product photos first" over a gallery that
 * visibly had one, and the link could only be made after saving and reloading — which is not how
 * anybody works (owner, 2026-08-27: *"זה לא הגיוני כי הכל נעשה בו זמנית"*). The comment above the
 * picker claimed the opposite behaviour, which is why the code read as correct.
 *
 * **The fix, and what this file pins.** A pending photo is offered by gallery POSITION and turned
 * into a URL at read time, which the submit handler guarantees is after the upload. So the two
 * cases below are the two halves that must stay true together: `collectVariantsPayload` resolves a
 * slot reference against whatever the input holds *now*, and it refuses to save a link to a slot
 * that still has nothing — a link to nothing is worse than no link, and it is what a failed upload
 * would otherwise leave behind.
 *
 * The picker's own behaviour was driven in a real browser instead (a 2×2 PNG into an empty slot, no
 * save): before the fix the popover offered one thumbnail, after it two — the second a blob preview
 * — and clicking it left the chip holding `imageSlot="1"` with its button lit. That drive also
 * found the defect this file's fixture reproduces: an EMPTY slot's `<img>` still carries a skeleton
 * src, so "has a picture" has to be read off `.gallery-slot__filled`, not off the image.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { collectVariantsPayload } from '../src/scripts/dashboard/products.js';

/** One gallery slot, in the three states the widget can leave it in. */
function slot(state: 'empty' | 'pending' | 'saved', url = ''): string {
  const filledHidden = state === 'empty' ? ' hidden' : '';
  // An empty slot keeps a skeleton image — the trap the browser drive exposed.
  const img = state === 'saved' ? url : 'data:image/gif;base64,R0lGOD';
  return `<div class="gallery-slot">
    <button type="button" class="gallery-slot__empty"${state === 'empty' ? '' : ' hidden'}></button>
    <div class="gallery-slot__filled"${filledHidden}><img class="gallery-slot__img" src="${img}"></div>
    <input class="gallery-slot__url" value="${state === 'saved' ? url : ''}">
  </div>`;
}

const SAVED = 'https://res.cloudinary.com/demo/image/upload/v1/red.jpg';
const UPLOADED = 'https://res.cloudinary.com/demo/image/upload/v1/blue.jpg';

function build(slots: string[], chips: string): HTMLFormElement {
  document.body.innerHTML = `<form>
    <div class="gallery-widget">${slots.join('')}</div>
    <div data-variants-editor>
      <div data-variant-dim><input data-dim-name value="צבע"><div>${chips}</div></div>
    </div>
  </form>`;
  return document.querySelector('form')!;
}

const chip = (value: string, attrs: string): string =>
  `<span data-variant-chip data-value="${value}" ${attrs}></span>`;

beforeEach(() => { document.body.innerHTML = ''; });

describe('a colour linked to a photo that was not uploaded yet', () => {
  it('resolves the slot to the URL the save has just written', () => {
    // The state at the moment `collectVariantsPayload` runs: the submit handler has uploaded the
    // pending photo, so slot 1's input now holds a real URL — and the chip still refers to "slot 1".
    const form = build(
      [slot('saved', SAVED), slot('saved', UPLOADED)],
      chip('אדום', `data-image="${SAVED}"`) + chip('כחול', 'data-image="" data-image-slot="1"'),
    );

    expect(collectVariantsPayload(form).variantImages).toEqual({
      'אדום': SAVED,
      'כחול': UPLOADED,
    });
  });

  it('saves no link at all when the slot still has nothing', () => {
    // The upload failed and the save is being aborted. A link to an empty slot would be a colour
    // pointing at nothing, which the storefront cannot draw and nobody can see is wrong.
    const form = build(
      [slot('saved', SAVED), slot('pending')],
      chip('כחול', 'data-image="" data-image-slot="1"'),
    );

    expect(collectVariantsPayload(form).variantImages).toEqual({});
  });

  it('leaves a colour linked to an already-saved photo exactly as it was', () => {
    const form = build([slot('saved', SAVED)], chip('אדום', `data-image="${SAVED}"`));
    expect(collectVariantsPayload(form).variantImages).toEqual({ 'אדום': SAVED });
  });
});
