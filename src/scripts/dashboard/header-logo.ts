// Settings → "ראש החנות" (components/dashboard/HeaderStyleCard.astro).
//
// Upload a header logo, take its background off, remove it — and keep the preview beside the radio
// honest while all of that happens.
//
// **Not `store-image.ts`, and the difference is one word: CROP.** That widget exists to fit a photo
// into a shape the layout dictates — a 3:1 banner, a circular avatar — so its whole flow is the
// crop modal, an aspect ratio, and an uncropped original kept beside the result so the seller can
// re-frame. A logo has no such shape: its aspect ratio is the thing it IS, it is drawn
// `object-fit: contain` into a fixed box, and cropping it is how a wordmark loses its last letters.
// So there is no crop modal here, no `aspect`, and no `_source` column (migration 0021 says why).
// What is shared is shared by IMPORT — the uploader and the background worker — rather than by
// bending a crop widget into a shape it was not written for.

import { cloudinaryUpload } from './cloudinary.js';
import { removeBackgroundInWorker, warmBgWorker } from './bg-worker.js';
import { cdnContain } from '../../config/store.config.js';
import { showErrorToast } from '../../lib/toast.js';
import { announceValueChange } from './unsaved-guard.js';
import { outboundFetch } from '../../lib/outbound-fetch.js';

/** Re-fetching an already-stored logo (to take its background off after the fact) crosses the
 *  network. Generous, for the same reason store-image.ts's is: the alternative to waiting is
 *  telling the seller their own saved image failed. */
const SOURCE_FETCH_TIMEOUT_MS = 30_000;

export interface HeaderLogoConfig {
  cloud: string;
  preset: string;
  labels: { upload: string; change: string; uploading: string; failed: string; removingBg: string; bgFailed: string; loadFailed: string };
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function initHeaderLogoCard(cfg: HeaderLogoConfig): void {
  const card = el<HTMLElement>('header-style-card');
  if (!card || card.dataset['ready'] === '1') return;
  card.dataset['ready'] = '1';

  const fileInput = el<HTMLInputElement>('header-logo-file-input');
  const hidden    = el<HTMLInputElement>('header-logo-input');
  const uploadBtn = el<HTMLButtonElement>('header-logo-upload-btn');
  const bgBtn     = el<HTMLButtonElement>('header-logo-bg-btn');
  const removeBtn = el<HTMLButtonElement>('header-logo-remove-btn');
  const previewBox = el<HTMLElement>('header-logo-preview-box');
  const previewImg = el<HTMLImageElement>('header-logo-preview');
  const emptyNote = el<HTMLElement>('header-logo-empty');
  const logoRadio = el<HTMLInputElement>('header-style-logo');
  if (!fileInput || !hidden || !uploadBtn) return;

  /**
   * Everything the card shows about "is there a logo", from the ONE value that decides it.
   *
   * Called after every mutation rather than each handler patching the three or four pieces it
   * happens to remember: the radio's enabled state, the preview, the placeholder and the two
   * buttons are four expressions of a single fact, and four handlers maintaining them separately is
   * how one of them ends up saying something the others do not.
   */
  const sync = (): void => {
    const url = hidden.value.trim();
    if (previewImg) previewImg.src = url ? cdnContain(url, 480, 64) : '';
    previewBox?.toggleAttribute('hidden', !url);
    emptyNote?.toggleAttribute('hidden', !!url);
    bgBtn?.toggleAttribute('hidden', !url);
    removeBtn?.toggleAttribute('hidden', !url);
    uploadBtn.textContent = url ? cfg.labels.change : cfg.labels.upload;
    if (logoRadio) {
      logoRadio.disabled = !url;
      // Removing the logo cannot leave "logo" selected — that would publish an empty bar. The
      // choice falls back to the name, which is the only other thing the header can render.
      if (!url && logoRadio.checked) {
        const nameRadio = card.querySelector<HTMLInputElement>('input[name="headerStyle"][value="name"]');
        if (nameRadio) { nameRadio.checked = true; announceValueChange(nameRadio); }
      }
    }
  };

  /** A hidden input assigned by script fires no event at all, so the unsaved-guard would never see
   *  it — `announceValueChange` is the one way to say a field moved (memory:
   *  `project_hidden_input_silent_writes`). */
  const write = (url: string): void => {
    hidden.value = url;
    announceValueChange(hidden);
    sync();
  };

  /** Run `job` with the button showing what is happening, and put the button back whatever
   *  happens — including on the throw, which is the case a bare try/finally-less version loses. */
  const busy = async (btn: HTMLButtonElement, label: string, job: () => Promise<void>): Promise<void> => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try {
      await job();
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : cfg.labels.failed);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
      // `sync` owns the upload button's own label, so restoring `original` above would put back a
      // stale "העלאה" after the first successful upload.
      sync();
    }
  };

  uploadBtn.addEventListener('click', () => fileInput.click());
  // The background worker's model is a few MB and is fetched on first use. Warmed on intent —
  // picking a file — so the wait, if the seller then presses "הסרת רקע", has already happened.
  fileInput.addEventListener('click', () => warmBgWorker());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    // Cleared immediately so re-picking the SAME file fires `change` again — without this, an
    // upload that failed cannot be retried with the same file.
    fileInput.value = '';
    if (!file) return;
    void busy(uploadBtn, cfg.labels.uploading, async () => {
      write(await cloudinaryUpload(file, cfg.cloud, cfg.preset));
    });
  });

  bgBtn?.addEventListener('click', () => {
    const url = hidden.value.trim();
    if (!url) return;
    void busy(bgBtn, cfg.labels.removingBg, async () => {
      // Through `outboundFetch`: this reaches a third-party host, and undici's default is a 300s
      // wait that would leave the button stuck long past the point the seller gave up.
      const res = await outboundFetch(url, { timeoutMs: SOURCE_FETCH_TIMEOUT_MS });
      if (!res.ok) throw new Error(cfg.labels.loadFailed);
      const cutout = await removeBackgroundInWorker(await res.blob());
      write(await cloudinaryUpload(cutout, cfg.cloud, cfg.preset));
    });
  });

  removeBtn?.addEventListener('click', () => write(''));

  sync();
}
