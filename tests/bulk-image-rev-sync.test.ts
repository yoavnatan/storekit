import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * **A bulk image save must carry the new images alongside the new revision, or it erases itself**
 * (found 2026-08-17).
 *
 * The mechanism, because the fix is one argument and looks like nothing:
 *
 *  1. A product's inline edit row holds a gallery whose slots are `<input type="hidden"
 *     name="images">`. `FormData(form)` submits every one of them, so that form always posts the
 *     WHOLE image list — there is no such thing as it leaving images alone.
 *  2. The bulk image panel saves the same product through `patch-product-images` and then calls
 *     `syncEditRowRev`, which writes the fresh revision onto that still-open form. It has to: the
 *     revision is how the server's per-field merge tells the seller's own edit from someone else's,
 *     and a self-inflicted conflict warning is what teaches a seller to click through the real one.
 *  3. But the form's gallery still shows the pre-save list. So stamping the revision does not merely
 *     fail to help — **it removes the last defence**: the merge sees a current revision, reads the
 *     stale list as a deliberate edit, and the images the seller just uploaded are gone. No error,
 *     no conflict prompt, nothing in the log.
 *
 * `bulk-image-panel-lock.test.ts` closes the route a seller can reach this by (the panel now
 * freezes the selection and blocks the row edit for anything it holds). This file guards the layer
 * under it, because an inline cell edit stamps revisions by a path that lock never sees — and
 * because the whole failure is one dropped third argument in a call that still compiles, still
 * runs, and still looks right.
 *
 * Pinned against the source rather than driven through the DOM: what has to hold is that these
 * three facts stay wired to each other, and the way this breaks is an edit to one of them by
 * someone who cannot see the other two.
 */

const ROOT = process.cwd();
const CLIENT = read('src/scripts/dashboard/products.ts');
const WIDGET = read('src/lib/gallery-widget.ts');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('the fact that makes a stale edit form dangerous', () => {
  it('every gallery slot is a submitting `images` input', () => {
    // If this ever stops being a NAMED input inside the form, the whole hazard above disappears
    // and this file (plus the third argument it guards) is dead weight worth deleting. Until then
    // it is the reason the argument exists.
    expect(WIDGET).toContain('<input type="hidden" name="images" class="gallery-slot__url"');
  });
});

describe('the bulk image save hands its images to the revision sync', () => {
  it('passes the saved list as the third argument', () => {
    expect(CLIENT).toMatch(/syncEditRowRev\(row,\s*data\.rev,\s*savedImages\)/);
  });

  it('sends what the SERVER stored, not what the browser uploaded', () => {
    // `savedImages` is `data.images ?? urls` — the server's answer preferred over the client's
    // list. Repainting the form from `urls` would put back a list the server may have reordered,
    // deduplicated or rejected part of, which is a quieter version of the same bug.
    expect(CLIENT).toMatch(/const savedImages = data\.images \?\? urls;/);
  });
});

describe('syncEditRowRev rebuilds the form gallery when it is told images changed', () => {
  const fn = CLIENT.slice(
    CLIENT.indexOf('function syncEditRowRev('),
    CLIENT.indexOf('function repaintFormGallery('),
  );

  it('takes an images parameter', () => {
    expect(fn).toContain('images?: string[]');
  });

  it('repaints the gallery in the same branch that stamps the revision', () => {
    // Same `if (form)` block, deliberately: the two must not be able to drift apart into one
    // happening without the other.
    expect(fn).toMatch(/form\.dataset\.baseRev = rev;\s*\n\s*if \(images\) repaintFormGallery\(form, images\);/);
  });

  it('still writes the revision back to the island for a form nobody has opened', () => {
    // The pre-existing half of this function, kept honest: a pending row is built later from the
    // page's product snapshot, so the images have to reach that too — via the display row, which
    // the caller patches. Losing this line would move the same bug one open-and-close away.
    expect(CLIENT).toMatch(/syncPageProductFromRow\(displayRow, rev\);/);
  });
});

describe('the island carries images too, for a form that does not exist yet', () => {
  /**
   * The second half of the same bug, and the one the owner actually asked about: a row still marked
   * `data-edit-pending` has no gallery to repaint. `buildEditRow` builds its form from the page's
   * product island, so unless the images reach THERE, the form opened after a bulk save shows the
   * pre-save list and saving it writes that list back — the identical silent overwrite, one
   * open-and-close later.
   *
   * Behaviourally covered end to end by `bulk-image-panel-lock.test.ts` ("an edit form opened AFTER
   * the save shows the saved images"), including the ORDER, which is the part that reads as harmless
   * and is not: the row's `data-images` must move before the revision is stamped, because the island
   * patch re-reads the row rather than taking a value. Pinned here as well because that ordering is
   * two ordinary-looking statements whose sequence carries the whole guarantee.
   */
  it('reads images off the display row, like every other field it patches', () => {
    const fn = CLIENT.slice(
      CLIENT.indexOf('function syncPageProductFromRow('),
      CLIENT.indexOf('export function syncPageProduct('),
    );
    expect(fn).toContain('displayRow.dataset.images');
    expect(fn).toContain('p.images = rowImages');
  });

  it('the bulk save writes the row attribute BEFORE stamping the revision', () => {
    const save = CLIENT.slice(CLIENT.indexOf('const savedImages = data.images ?? urls;'));
    const attrAt = save.indexOf('row.dataset.images = JSON.stringify(savedImages)');
    const stampAt = save.indexOf('syncEditRowRev(row, data.rev, savedImages)');
    expect(attrAt).toBeGreaterThan(-1);
    expect(stampAt).toBeGreaterThan(-1);
    expect(attrAt).toBeLessThan(stampAt);
  });
});

describe('the repaint replaces the widget instead of patching it', () => {
  const fn = CLIENT.slice(CLIENT.indexOf('function repaintFormGallery('));

  it('swaps the element and re-initialises it', () => {
    // Per-slot state (the original upload, a background-removed variant, crop flags) lives in a
    // WeakMap keyed by the slot element. Patching values into surviving slots would leave that
    // state describing images that are no longer there; a new element starts clean, and carries no
    // `data-gallery-init`, which is what lets `initGalleryWidget` wire it.
    expect(fn).toContain('gallery.replaceWith(fresh)');
    expect(fn).toContain('initGalleryWidget(fresh)');
  });
});
