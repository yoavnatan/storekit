// Settings → "ראש החנות" (components/dashboard/HeaderStyleCard.astro).
//
// Upload a header logo, take its background off, remove it — and keep the preview beside the radio
// honest while all of that happens.
//
// **Not `store-image.ts`, and the difference is how the frame OPENS.** That widget fits a photo into
// a shape the layout dictates — a 3:1 banner, a circular avatar — so it opens at `cover`, filling
// the frame, because empty space inside a photo's window is a defect. A logo is the other case: its
// aspect ratio is the thing it IS, so a frame that opens filled has already cut both ends off a
// wordmark before the seller has touched anything. Here the same crop tool opens `contain`
// (crop-modal.ts's `fit`), showing the whole mark inside the header's own slot, and every move from
// there is the seller's. The output is PNG on a transparent canvas, so the space around a contained
// logo stays transparent rather than becoming a white plate.
// No `_source` column either (migration 0021 says why): re-framing always starts from the stored
// image because a contained crop discards nothing.

import { openCropModal } from './crop-modal.js';
import { busyButton, type BusyButton } from './btn-busy.js';
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

/** The header's logo slot, as the crop frame. 176x40 is `.store-header__brand`'s own box, so what
 *  the seller frames is literally the shape the bar will draw — the ratio is read from those two
 *  numbers rather than typed, so a change to the CSS box is a change here too and cannot drift
 *  silently. The viewport is scaled up for a usable tool; only the RATIO travels. */
const SLOT_W = 176;
const SLOT_H = 40;
const SLOT_ASPECT = SLOT_W / SLOT_H;

export interface HeaderLogoConfig {
  cloud: string;
  preset: string;
  labels: { upload: string; change: string; adjust: string; uploading: string; loading: string; failed: string; removingBg: string; bgFailed: string; loadFailed: string };
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
  const adjustBtn = el<HTMLButtonElement>('header-logo-adjust-btn');
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
    // 480x80 — twice the 176x40 slot, so the preview is sharp on a 2x screen (cdn.ts: ask for
    // 2x a fixed-size cell). `cdnContain` never upscales, so a small logo costs nothing extra.
    if (previewImg) previewImg.src = url ? cdnContain(url, 480, 80) : '';
    previewBox?.toggleAttribute('hidden', !url);
    emptyNote?.toggleAttribute('hidden', !!url);
    adjustBtn?.toggleAttribute('hidden', !url);
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

  /** Run `work` with the button in the shared in-flight state — dots, `cursor: progress`, and a
   *  live percentage for whoever reports one — and put it back whatever happens, including on the
   *  throw, which is the case a version without `finally` loses. */
  const busy = async (btn: HTMLButtonElement, label: string, work: (job: BusyButton) => Promise<void>): Promise<void> => {
    const job = busyButton(btn, label);
    try {
      await work(job);
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : cfg.labels.failed);
    } finally {
      job.done();
      // `sync` owns the upload button's own label, so the restore above would otherwise put back a
      // stale "העלאה" after the first successful upload.
      sync();
    }
  };

  /** Fetch the stored logo as a blob — shared by "adjust" and "remove background", which both need
   *  the bytes of an image that currently exists only as a URL. */
  const storedBlob = async (url: string): Promise<Blob> => {
    // Through `outboundFetch`: a third-party host, and undici's default is a 300s wait that would
    // leave a button stuck long past the point the seller gave up.
    const res = await outboundFetch(url, { timeoutMs: SOURCE_FETCH_TIMEOUT_MS });
    if (!res.ok) throw new Error(cfg.labels.loadFailed);
    return res.blob();
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
    void busy(bgBtn, cfg.labels.removingBg, async (job) => {
      // A live percentage: the first run also downloads the model, so a blind wait of tens of
      // seconds reads as a hang rather than as work.
      const cutout = await removeBackgroundInWorker(await storedBlob(url), (p) => job.setProgress(p));
      write(await cloudinaryUpload(cutout, cfg.cloud, cfg.preset));
    });
  });

  removeBtn?.addEventListener('click', () => write(''));

  adjustBtn?.addEventListener('click', () => {
    const url = hidden.value.trim();
    if (!url) return;
    void busy(adjustBtn, cfg.labels.loading, async () => {
      const blob = await storedBlob(url);
      // `vpWidth` is a tool size, not the slot size — 420px makes the mark big enough to position by
      // hand. Only SLOT_ASPECT travels, so the frame is the header's shape at a workable scale.
      openCropModal(blob, false, (cropped) => {
        void busy(adjustBtn, cfg.labels.uploading, async () => {
          write(await cloudinaryUpload(cropped, cfg.cloud, cfg.preset));
        });
      }, { aspect: SLOT_ASPECT, vpWidth: 420, fit: 'contain' });
    });
  });

  /**
   * Clicking the preview itself opens the picker — the intuition is to click the picture (owner,
   * 2026-08-09: "האינטואיציה זה ללחוץ שם").
   *
   * Only while there is NO logo yet. Once one exists the same click has to mean "choose this
   * option", which is what the surrounding <label> already does, and re-opening a file dialog on
   * top of a choice the seller was making would be a second action they did not ask for. The
   * buttons below own change/adjust from then on.
   *
   * The listener sits on the box rather than on the caption alone so the whole empty row is the
   * target, and it skips clicks that started on a button — those have their own jobs and a <label>
   * would otherwise hand this one their click too.
   */
  el<HTMLElement>('header-logo-drop')?.addEventListener('click', (e) => {
    if (hidden.value.trim()) return;
    if ((e.target as HTMLElement).closest('button')) return;
    warmBgWorker();
    fileInput.click();
  });

  sync();
}
