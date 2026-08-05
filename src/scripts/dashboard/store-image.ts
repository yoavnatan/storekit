import { openCropModal } from './crop-modal.js';
import { cloudinaryUpload } from './cloudinary.js';
import { cdnSrc } from '../../config/store.config.js';

export interface StoreImageWidgetConfig {
  frameId: string;
  fileInputId: string;
  hiddenInputId: string;
  uploadBtnId: string;
  removeBtnId: string;
  aspect: number;   // width/height
  vpWidth: number;  // crop viewport CSS width in px
  previewWidth: number; // cdn width for the rendered preview
  cloud: string;
  preset: string;
  labels: { upload: string; change: string; remove: string; uploading: string };
}

export function initStoreImageWidget(cfg: StoreImageWidgetConfig): void {
  const frame      = document.getElementById(cfg.frameId);
  const fileInput  = document.getElementById(cfg.fileInputId) as HTMLInputElement | null;
  const hiddenInput = document.getElementById(cfg.hiddenInputId) as HTMLInputElement | null;
  const uploadBtn  = document.getElementById(cfg.uploadBtnId) as HTMLButtonElement | null;
  const removeBtn  = document.getElementById(cfg.removeBtnId) as HTMLButtonElement | null;
  if (!frame || !fileInput || !hiddenInput || !uploadBtn) return;

  // `cover` for both widgets, because that is what both of their render targets do
  // — the banner is a crop by nature, and the avatar is drawn by StoreAvatar the
  // same way. The one thing this preview must never do is flatter the upload: what
  // the seller sees after cropping is a promise about their own storefront, and a
  // preview that disagrees with the site fails silently.
  const previewStyle = 'width:100%;height:100%;object-fit:cover;border-radius:inherit';

  function render() {
    const url = hiddenInput!.value;
    frame!.innerHTML = url
      ? `<img src="${cdnSrc(url, cfg.previewWidth)}" alt="" loading="lazy" decoding="async" style="${previewStyle}">`
      : '';
    uploadBtn!.textContent = url ? cfg.labels.change : cfg.labels.upload;
    if (removeBtn) removeBtn.hidden = !url;
  }

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    openCropModal(file, false, (croppedBlob) => {
      void (async () => {
        const busyLabel = uploadBtn.textContent ?? '';
        uploadBtn.disabled = true;
        uploadBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:0.5em">${cfg.labels.uploading}<span class="dot-pulse" role="status" aria-label="${cfg.labels.uploading}"><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span><span class="dot-pulse__dot"></span></span></span>`;
        try {
          const url = await cloudinaryUpload(croppedBlob, cfg.cloud, cfg.preset);
          hiddenInput!.value = url;
        } catch {
          uploadBtn.textContent = busyLabel;
        } finally {
          uploadBtn.disabled = false;
          render();
        }
      })();
    }, { vpWidth: cfg.vpWidth, aspect: cfg.aspect });
  });

  removeBtn?.addEventListener('click', () => {
    hiddenInput!.value = '';
    render();
  });

  render();
}
