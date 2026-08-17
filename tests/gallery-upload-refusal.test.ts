// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { galleryWidgetHtml } from '../src/lib/gallery-widget.js';
import { resolveGalleryUrls } from '../src/scripts/dashboard/gallery.js';

/**
 * **When an upload is refused, WHICH photo was it?** (owner, 2026-08-17: *"אז מה קורה כשתמונה לא
 * מאושרת מבחינת ui? בדיוק"*.)
 *
 * The shape of the flow is what makes this matter. Photos are held as local blobs when picked and
 * uploaded only on Save, one at a time — so a seller who chose five and pressed Save gets a single
 * red sentence back about one of them. Before this, that sentence was "התמונה נדחתה בבדיקת תוכן —
 * בחר/י תמונה אחרת" with nothing identifying the photo, which past a single image is a guessing
 * game played by deleting good pictures until the bad one is gone.
 *
 * It is not specific to moderation: "the file is too large" and "unsupported format" were equally
 * anonymous. The refusal now carries the slot's position, and the slot carries a ring.
 *
 * **On what is driven and what is pinned, because the split is not laziness.** The blob a slot
 * holds lives in a module-private `WeakMap` that only the widget's own picker writes, and that
 * picker runs the file through canvas decode/downscale — machinery jsdom does not have. So the
 * FAILURE path cannot be driven from outside without inventing an export that exists only for this
 * test. What can be driven is driven; the three lines inside the catch are pinned against the
 * source, and named here so the next reader knows the difference.
 */

const SRC = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const GALLERY = SRC('src/scripts/dashboard/gallery.ts');

beforeEach(() => {
  document.body.innerHTML = `<div id="host">${galleryWidgetHtml([], {})}</div>`;
});

describe('the parts that can be driven', () => {
  it('a gallery with nothing picked uploads nothing and marks nothing', async () => {
    // Also the contract that keeps an untouched product free to save: `resolveGalleryUrls` is
    // called on every edit-form submit, and a product whose photos nobody touched must not pay for
    // an upload — nor, now, for a moderation check out of a 50-a-month quota.
    const gallery = document.querySelector('.gallery-widget')!;
    await expect(resolveGalleryUrls(gallery, 'cloud', 'preset')).resolves.toBeUndefined();
    expect(gallery.querySelector('[data-upload-rejected]')).toBeNull();
  });

  it('clears a previous attempt\'s ring AND message before trying again', async () => {
    // A mark that survives the fix points at the wrong picture — the seller has already replaced
    // that photo, and the ring would now be sitting on its innocent replacement.
    const gallery = document.querySelector('.gallery-widget')!;
    const slot = gallery.querySelector('.gallery-slot')! as HTMLElement;
    slot.dataset.uploadRejected = '1';
    slot.classList.add('outline', 'outline-2');
    const stale = document.createElement('p');
    stale.dataset.galleryRefusal = '1';
    gallery.after(stale);

    await resolveGalleryUrls(gallery, 'cloud', 'preset');

    expect(gallery.querySelector('[data-upload-rejected]')).toBeNull();
    expect(slot.classList.contains('outline')).toBe(false);
    // Cleared on the path that matters most: removing the offending photo leaves nothing to upload,
    // so this runs BEFORE the "nothing pending" return or it never runs at all.
    expect(document.querySelector('[data-gallery-refusal]')).toBeNull();
  });

  it('numbers the slots from one, not from `data-slot`', () => {
    // The seller is looking at the first, second, third box — `data-slot` is 0-based and saying
    // "תמונה 0" would be worse than saying nothing.
    const slots = Array.from(document.querySelectorAll<HTMLElement>('.gallery-slot'));
    expect(slots[0]!.dataset.slot).toBe('0');
    expect(GALLERY).toContain("Number((slot as HTMLElement).dataset.slot ?? 0) + 1");
  });
});

describe('the failure path, pinned against the source', () => {
  it('marks the slot and appends the position, without replacing the reason', () => {
    // The refusal already says what to DO ("בחר/י תמונה אחרת"); the position says which photo it
    // is about. Dropping either half makes the message useless in a different way.
    expect(GALLERY).toContain('markSlotRejected(slot);');
    expect(GALLERY).toMatch(/err\.message = `\$\{err\.message\} \(\$\{slotPositionLabel\(slot\)\}\)`/);
    expect(GALLERY).toContain('throw err;');
  });

  it('rings the slot INSIDE its box, where an ancestor cannot clip it', () => {
    // A positive outline-offset draws outside the element, and the gallery sits inside panels that
    // clip — memory `project_focus_ring_clipped_by_scroller`.
    expect(GALLERY).toContain("'-outline-offset-2'");
    expect(GALLERY).not.toContain("'outline-offset-2'");
  });
});

describe('the message lands at the photo, not at the top of the tab', () => {
  /**
   * Owner, 2026-08-17: *"האם היא די ברורה?"* — asked about a message that appeared, for both Save
   * buttons alike, in `#ajax-status` right under `.products-header`. On the Products tab that is
   * ABOVE the whole table, and `showStatus` scrolls the page to it. So a refusal on a product low
   * in the list threw the seller to the top of the tab, away from the form they were in and from
   * the ringed slot the message was about — worst of all from the Save button at the BOTTOM of a
   * long form, which is the one a seller actually reaches for.
   */
  it('renders the refusal next to the widget that owns the photo', () => {
    expect(GALLERY).toContain('gallery.after(note)');
    expect(GALLERY).toContain("note.dataset.galleryRefusal = '1'");
    // Announced, not just drawn: it appears in response to a press, and the seller may be looking
    // anywhere on a tall form.
    expect(GALLERY).toContain("note.setAttribute('role', 'alert')");
  });

  it('scrolls the RINGED SLOT into view, not the message', () => {
    // The slot is the answer to "which photo"; the sentence is only the explanation. Landing on the
    // sentence would put the picture back off-screen, which is the bug being fixed.
    expect(GALLERY).toContain('scrollBelowPinnedChrome(slot as HTMLElement)');
  });

  it('marks the error so the caller does not repeat it at the top of the page', () => {
    expect(GALLERY).toContain('shownAtField = true');
    const products = SRC('src/scripts/dashboard/products.ts');
    // Both form submits — the edit form and the add form — check before falling back to the banner.
    const guarded = products.match(/if \(!refusalShownAtField\(err\)\) showStatus\(uploadErrorText\(err, i18n\), true\);/g) ?? [];
    expect(guarded).toHaveLength(2);
  });

  it('a non-refusal still goes to the page banner, because it is about no photo in particular', () => {
    // A dropped connection or a provider 500 is not about a picture, and "try again" is the whole
    // instruction — so nothing marks it and the fallback runs.
    expect(GALLERY).toMatch(/shownAtField = true;[\s\S]{0,40}\}\s*\n\s*throw err;/);
    expect(SRC('src/scripts/dashboard/products.ts'))
      .toContain('return !!(err as { shownAtField?: boolean } | null)?.shownAtField;');
  });
});

describe('the refusal keeps its own wording all the way to the seller', () => {
  it('a refusal is shown verbatim, with no "try again" wrapper around it', () => {
    // A refused file is refused identically next time, so the generic retry wording is the wrong
    // instruction and buries the only actionable sentence in a parenthesis.
    expect(SRC('src/scripts/dashboard/products.ts')).toContain('if (isUploadRefusal(err)) return reason;');
  });

  it('a moderation rejection is raised AS a refusal, so it takes that path', () => {
    const cloudinary = SRC('src/scripts/dashboard/cloudinary.ts');
    expect(cloudinary).toMatch(/const refusal = moderationRefusal\(json\);[\s\S]{0,40}if \(refusal\) throw refuse\(refusal\);/);
    expect(cloudinary).toContain('err.name = UPLOAD_REFUSED;');
  });
});
