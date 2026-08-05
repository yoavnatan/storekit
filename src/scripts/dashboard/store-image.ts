import { openCropModal } from './crop-modal.js';
import { cloudinaryUpload } from './cloudinary.js';
import { cdnSrc } from '../../config/store.config.js';
import { showErrorToast } from '../../lib/toast.js';
import { announceValueChange } from './unsaved-guard.js';

export interface StoreImageWidgetConfig {
  frameId: string;
  fileInputId: string;
  hiddenInputId: string;
  /** Hidden field carrying the UNCROPPED upload (migration 0012). Optional so the widget still
   *  works on a form that doesn't have one — it just loses the ability to re-frame from the
   *  original and falls back to re-cropping the delivered image. */
  sourceInputId?: string;
  uploadBtnId: string;
  /** "Adjust" — re-open the crop tool on the image that is already saved. */
  adjustBtnId?: string;
  removeBtnId: string;
  aspect: number;   // width/height
  vpWidth: number;  // crop viewport CSS width in px
  previewWidth: number; // cdn width for the rendered preview
  /** The render target is a circle (the store avatar) — show the crop tool a circular mask. */
  round?: boolean;
  cloud: string;
  preset: string;
  labels: {
    upload: string; change: string; adjust: string; remove: string;
    uploading: string; loading: string; failed: string; loadFailed: string;
  };
}

export function initStoreImageWidget(cfg: StoreImageWidgetConfig): void {
  const frame      = document.getElementById(cfg.frameId);
  const fileInput  = document.getElementById(cfg.fileInputId) as HTMLInputElement | null;
  const hiddenInput = document.getElementById(cfg.hiddenInputId) as HTMLInputElement | null;
  const sourceInput = cfg.sourceInputId ? document.getElementById(cfg.sourceInputId) as HTMLInputElement | null : null;
  const uploadBtn  = document.getElementById(cfg.uploadBtnId) as HTMLButtonElement | null;
  const adjustBtn  = cfg.adjustBtnId ? document.getElementById(cfg.adjustBtnId) as HTMLButtonElement | null : null;
  const removeBtn  = document.getElementById(cfg.removeBtnId) as HTMLButtonElement | null;
  if (!frame || !fileInput || !hiddenInput || !uploadBtn) return;

  // `cover` for both widgets, because that is what both of their render targets do
  // — the banner is a crop by nature, and the avatar is drawn by StoreAvatar the
  // same way. The one thing this preview must never do is flatter the upload: what
  // the seller sees after cropping is a promise about their own storefront, and a
  // preview that disagrees with the site fails silently.
  const previewStyle = 'width:100%;height:100%;object-fit:cover;border-radius:inherit';

  /** The preview `<img>`, built as an element rather than interpolated into `innerHTML`.
   *  The URL is the upload provider's own response, so it is not seller input — but it IS a
   *  request-supplied string landing inside `src="…"`, which is the shape of the attribute-
   *  escaping hole this codebase already had to close once (lib/escape.ts, 2026-07-29). Setting
   *  the property closes it by construction: there is no attribute for a quote to break out of. */
  function previewImg(url: string): HTMLImageElement {
    const img = document.createElement('img');
    img.src = cdnSrc(url, cfg.previewWidth);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.setAttribute('style', previewStyle);
    return img;
  }

  // The photo the NEXT crop will be cut from, held for as long as it still belongs to the image
  // on screen. Two things fill it: the file the seller just picked (so re-framing right after an
  // upload costs no network at all, and works even when the source upload itself failed), and a
  // fetch of the saved original on the first "adjust" after a page load.
  let sourceBlob: Blob | null = null;
  let sourceBlobFor = '';

  function render() {
    const url = hiddenInput!.value;
    // Only when it actually differs. `render()` runs on hydration too, over a preview the server
    // already painted, and rebuilding that <img> throws away a decoded image to re-decode the
    // identical URL — a blink on a tab the seller merely opened, with nothing changed behind it.
    const want = url ? cdnSrc(url, cfg.previewWidth) : '';
    const shown = frame!.querySelector('img')?.getAttribute('src') ?? '';
    if (want !== shown) frame!.replaceChildren(...(url ? [previewImg(url)] : []));
    uploadBtn!.textContent = url ? cfg.labels.change : cfg.labels.upload;
    if (adjustBtn) adjustBtn.hidden = !url;
    if (removeBtn) removeBtn.hidden = !url;
  }

  /** Swap a button into a busy state and hand back the undo — one place, so no path can
   *  leave a button disabled or wearing a spinner after it finished. */
  function busy(btn: HTMLButtonElement, label: string): () => void {
    const before = btn.innerHTML;
    const wasDisabled = btn.disabled;
    btn.disabled = true;
    btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:0.5em">${label}<span class="dot-pulse" role="status" aria-label="${label}"><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span></span>`;
    return () => { btn.disabled = wasDisabled; btn.innerHTML = before; };
  }

  /** Upload one crop and adopt it as the image. The seller is told when it fails: the upload
   *  layer already produces a sentence they can act on ("the file is too large", "unsupported
   *  format"), and this widget used to read it off the wire and drop it — leaving a button that
   *  went back to normal with nothing changed and nothing said. */
  async function commitCrop(croppedBlob: Blob, btn: HTMLButtonElement): Promise<boolean> {
    const done = busy(btn, cfg.labels.uploading);
    try {
      hiddenInput!.value = await cloudinaryUpload(croppedBlob, cfg.cloud, cfg.preset);
      announceValueChange(hiddenInput!);
      return true;
    } catch (err) {
      showErrorToast(cfg.labels.failed, err instanceof Error ? err.message : '');
      return false;
    } finally {
      done();
      render();
    }
  }

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    openCropModal(file, false, (croppedBlob) => {
      void (async () => {
        if (!await commitCrop(croppedBlob, uploadBtn!)) return;
        // The crop is what the site serves; the original is what the seller re-frames from next
        // time. Kept in memory immediately — that half never fails — and uploaded beside it so it
        // survives the reload. A source upload that fails is NOT worth interrupting for: the image
        // itself is already saved, and "adjust" degrades to re-cropping the delivered image, which
        // is exactly what it did before this field existed.
        sourceBlob = file;
        sourceBlobFor = hiddenInput!.value;
        if (!sourceInput) return;
        // Cleared first, and left cleared if the upload fails: whatever was in there belongs to
        // the picture that was just replaced, and pairing it with the new crop would hand the
        // next "adjust" the previous photo.
        sourceInput.value = '';
        try {
          sourceInput.value = await cloudinaryUpload(file, cfg.cloud, cfg.preset);
        } catch { /* keep the crop, lose only the re-framing across reloads */ }
        announceValueChange(sourceInput);
      })();
    }, { vpWidth: cfg.vpWidth, aspect: cfg.aspect, round: cfg.round });
  });

  const adjust = adjustBtn;
  adjust?.addEventListener('click', () => {
    void (async () => {
      if (!adjust || !hiddenInput!.value) return;
      let blob = sourceBlob && sourceBlobFor === hiddenInput!.value ? sourceBlob : null;
      if (!blob) {
        // The saved original where there is one, the delivered crop where there isn't (an image
        // uploaded before 0012, or one whose source upload failed). The raw stored URL, not a
        // `cdnSrc` derivative — re-framing a 200px preview would throw away the resolution the
        // storefront is about to ask for.
        const url = sourceInput?.value || hiddenInput!.value;
        const done = busy(adjust, cfg.labels.loading);
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(String(resp.status));
          blob = await resp.blob();
          sourceBlob = blob;
          sourceBlobFor = hiddenInput!.value;
        } catch {
          // Not `failed` — nothing was uploaded here. Telling a seller their upload failed when
          // the fetch of an image they uploaded weeks ago is what broke sends them to re-upload
          // a picture that is already fine.
          showErrorToast(cfg.labels.loadFailed);
          return;
        } finally { done(); }
      }
      if (!blob) return;
      openCropModal(blob, false, (croppedBlob) => {
        void (async () => {
          const carried = sourceBlob;
          if (!await commitCrop(croppedBlob, adjust)) return;
          // The source did not change, only the crop cut from it — so it stays valid, now paired
          // with the new image. Without this the next adjust would re-fetch and, worse, fall back
          // to cropping the crop the moment the seller adjusts twice in a row.
          sourceBlob = carried;
          sourceBlobFor = hiddenInput!.value;
        })();
      }, { vpWidth: cfg.vpWidth, aspect: cfg.aspect, round: cfg.round });
    })();
  });

  removeBtn?.addEventListener('click', () => {
    hiddenInput!.value = '';
    announceValueChange(hiddenInput!);
    if (sourceInput) { sourceInput.value = ''; announceValueChange(sourceInput); }
    sourceBlob = null;
    sourceBlobFor = '';
    render();
  });

  render();
}
