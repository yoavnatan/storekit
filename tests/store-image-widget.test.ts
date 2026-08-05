/**
 * The store banner / profile-image widget, checked at its seams rather than at its logic.
 *
 * Everything this widget does starts with `document.getElementById(<a string from a config
 * object>)`, and every one of those lookups fails the same way: `null`, no error, no console
 * warning, a button that simply does nothing when clicked. The same is true of the API side — the
 * hidden inputs reach `api/store.ts` as `form.get('<a string>')`, and a renamed field arrives as
 * `null` and is written as "no image" without anybody being told.
 *
 * So the ids and the field names are pinned here, in the two directions a rename can break them.
 * There is no DOM in this suite; these are the checks that do not need one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'src/pages/seller/dashboard.astro'), 'utf8');
const widget = fs.readFileSync(path.join(root, 'src/scripts/dashboard/store-image.ts'), 'utf8');
const cropModal = fs.readFileSync(path.join(root, 'src/scripts/dashboard/crop-modal.ts'), 'utf8');
const storeApi = fs.readFileSync(path.join(root, 'src/pages/api/store.ts'), 'utf8');

/** The config object of every `initStoreImageWidget({…})` call in the dashboard. */
function widgetConfigs(): string[] {
  return [...dashboard.matchAll(/initStoreImageWidget\(\{([\s\S]*?)\n\s*\}\)/g)].map((m) => m[1]!);
}

describe('the store image widget is wired to elements that exist', () => {
  it('finds two widgets — the banner and the profile image', () => {
    expect(widgetConfigs()).toHaveLength(2);
  });

  it('names an id that is actually rendered, for every element it looks up', () => {
    const ids = widgetConfigs().flatMap((cfg) => [...cfg.matchAll(/\w+Id:\s*'([^']+)'/g)].map((m) => m[1]!));
    // 6 per widget: frame, file input, hidden input, source input, upload, adjust, remove.
    expect(ids.length).toBeGreaterThanOrEqual(12);
    for (const id of ids) expect(dashboard, `#${id} is looked up but never rendered`).toContain(`id="${id}"`);
  });

  it('gives the avatar the circular crop preview and the banner none', () => {
    const [banner, avatar] = widgetConfigs();
    // The avatar is drawn in a circle site-wide (StoreAvatar); framing it against a square is
    // what cut a fifth of the picture the seller had lined up. The banner is a 3:1 band.
    expect(avatar).toContain('round: true');
    expect(banner).not.toContain('round: true');
    expect(dashboard).toMatch(/id="avatar-frame"[\s\S]{0,200}rounded-full/);
  });

  it('renders the element the crop modal reveals for a round target', () => {
    expect(cropModal).toContain("getElementById('crop-round')");
    expect(dashboard).toContain('id="crop-round"');
    // Hidden in the markup, shown only when `round` is asked for — an overlay that defaults to
    // visible flashes a circle over every product crop before the JS gets a chance to hide it.
    expect(dashboard).toMatch(/id="crop-round"[^>]*hidden/);
  });
});

describe('the hidden fields survive the trip to the API', () => {
  it('posts each image and its original under the name the route reads', () => {
    for (const field of ['bannerImage', 'profileImage', 'bannerImageSource', 'profileImageSource']) {
      expect(dashboard, `${field} is not in the settings form`).toContain(`name="${field}"`);
      expect(storeApi, `${field} is posted but never read`).toContain(`'${field}'`);
    }
  });

  it('keeps the source out of the <img> path entirely', () => {
    // The source is the uncropped original: bigger, unframed, and never what a visitor should
    // get. It exists for one purpose — re-opening the crop tool — so it must never be rendered.
    expect(widget).not.toMatch(/cdnSrc\([^)]*ource/);
  });
});
