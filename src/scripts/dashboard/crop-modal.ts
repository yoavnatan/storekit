const cropModal    = document.getElementById('crop-modal') as HTMLDivElement | null;
const cropViewport = document.getElementById('crop-viewport') as HTMLDivElement | null;
const cropImgEl    = document.getElementById('crop-img') as HTMLImageElement | null;
const cropZoomEl   = document.getElementById('crop-zoom') as HTMLInputElement | null;
const cropApplyBtn = document.getElementById('crop-apply') as HTMLButtonElement | null;
const cropCancelEl = document.getElementById('crop-cancel') as HTMLButtonElement | null;

const VP_SIZE_DEFAULT = 280;
const OUT_SIZE_MAX = 2560; // ceiling only — real output size matches the source pixels selected.
// 2560 keeps the widest surface (the store banner, ~1128px CSS → ~2256px at DPR 2)
// sharp on retina desktop without upscaling; f_auto/q_auto still compress delivery.

export interface CropOptions {
  vpWidth?: number;  // viewport CSS width in px (default 280 — square gallery crop)
  aspect?: number;   // output width/height ratio (default 1 = square)
  /** Draw a circular mask over the viewport, dimming everything the circle will cut.
   *  PREVIEW ONLY — the blob handed back is still the full square, because that is what the
   *  render target actually consumes: StoreAvatar paints a square `object-fit: cover` image and
   *  lets CSS round it. Cutting real transparent corners here would change nothing on screen and
   *  would hand the ad feeds a circle on a black square (`cdnFill` is `f_jpg`, no alpha).
   *  It exists because the seller was framing to a square and the site was showing a circle:
   *  ~21% of what they lined up was cropped away by a shape they could not see. */
  round?: boolean;
  /**
   * How the image is SIZED to the viewport when the tool opens.
   *
   * `cover` (default) scales until the frame is full, which is right for a photo: a banner or an
   * avatar is a window onto a picture, and empty space inside it is a defect.
   *
   * `contain` scales until the whole image is INSIDE the frame, leaving transparent space around
   * it. That is what a logo needs, and it is a different job rather than a preference: a logo's
   * aspect ratio is the thing it is, so opening at `cover` means the tool's first frame has already
   * cut the ends off a wordmark, and the seller's only move is to zoom out to a place the slider
   * cannot reach. Opening `contain` shows them their whole mark in the header's own slot, and every
   * adjustment from there is theirs.
   *
   * The render needs nothing else: `applyCrop` already asks `drawImage` for a source region that
   * may fall outside the image, the canvas starts transparent, and the output is PNG — so the space
   * around a contained logo comes out transparent rather than black or white.
   */
  fit?: 'cover' | 'contain';
}

let cropApplyCallback: ((blob: Blob, isProcessed: boolean) => void) | null = null;
let cropIsProcessed = false;
let cropFitScale = 1;
let cropZoomVal = 1;
let cropPanX = 0;
let cropPanY = 0;
let cropVpW = VP_SIZE_DEFAULT;
let cropVpH = VP_SIZE_DEFAULT;
let isDragging = false;
let dragStartX = 0, dragStartY = 0, dragStartPanX = 0, dragStartPanY = 0;

function clampCropPan() {
  if (!cropImgEl?.naturalWidth) return;
  const s = cropFitScale * cropZoomVal;
  const halfW = Math.max(0, (cropImgEl.naturalWidth * s - cropVpW) / 2);
  const halfH = Math.max(0, (cropImgEl.naturalHeight * s - cropVpH) / 2);
  cropPanX = Math.min(halfW, Math.max(-halfW, cropPanX));
  cropPanY = Math.min(halfH, Math.max(-halfH, cropPanY));
}

function updateCropDisplay() {
  if (!cropImgEl?.naturalWidth) return;
  const s = cropFitScale * cropZoomVal;
  const w = cropImgEl.naturalWidth * s;
  const h = cropImgEl.naturalHeight * s;
  cropImgEl.style.width = `${w}px`;
  cropImgEl.style.height = `${h}px`;
  cropImgEl.style.left = `${(cropVpW - w) / 2 + cropPanX}px`;
  cropImgEl.style.top = `${(cropVpH - h) / 2 + cropPanY}px`;
}

const cropHint  = document.getElementById('crop-hint');
const cropRound = document.getElementById('crop-round');

export function openCropModal(blob: Blob, isProcessed: boolean, onApply?: (blob: Blob, isProcessed: boolean) => void, options?: CropOptions): void {
  if (!cropModal || !cropImgEl || !cropZoomEl) return;
  cropIsProcessed = isProcessed;
  cropApplyCallback = onApply ?? null;
  // Panel padding is 1.5rem (24px) per side; cap the viewport so it never
  // outgrows the panel's own 92vw ceiling on narrow screens.
  const maxPanelInner = window.innerWidth * 0.92 - 48;
  cropVpW = Math.min(options?.vpWidth ?? VP_SIZE_DEFAULT, maxPanelInner);
  cropVpH = cropVpW / (options?.aspect ?? 1);
  if (cropViewport) { cropViewport.style.width = `${cropVpW}px`; cropViewport.style.height = `${cropVpH}px`; }
  cropPanX = 0; cropPanY = 0; cropZoomVal = 1;
  cropZoomEl.value = '1';
  cropImgEl.onload = () => {
    // max = cover (fill the frame), min = contain (fit inside it). See CropOptions.fit.
    cropFitScale = options?.fit === 'contain'
      ? Math.min(cropVpW / cropImgEl!.naturalWidth, cropVpH / cropImgEl!.naturalHeight)
      : Math.max(cropVpW / cropImgEl!.naturalWidth, cropVpH / cropImgEl!.naturalHeight);
    updateCropDisplay();
  };
  cropImgEl.src = URL.createObjectURL(blob);
  if (cropRound) cropRound.hidden = !options?.round;
  cropModal.hidden = false;
  cropHint?.classList.remove('hidden');
}

function closeCropModal() {
  if (!cropModal) return;
  cropModal.hidden = true;
  if (cropImgEl) cropImgEl.src = '';
  cropApplyCallback = null;
}

async function applyCrop() {
  if (!cropImgEl?.naturalWidth) return;
  const s = cropFitScale * cropZoomVal;
  // Number of actual source pixels being cropped, at the current zoom, per axis.
  const srcW = cropVpW / s;
  const srcH = cropVpH / s;
  // Match the output to the real source resolution instead of a fixed size — a fixed size
  // would either downscale (losing detail on a large/zoomed-out selection) or pointlessly
  // upscale (a small/zoomed-in selection). Only cap for very large sources, keeping aspect exact.
  const capFactor = Math.min(1, OUT_SIZE_MAX / Math.max(srcW, srcH));
  const outW = Math.round(srcW * capFactor);
  const outH = Math.round(srcH * capFactor);
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d')!;
  const srcX = cropImgEl.naturalWidth / 2 - (cropVpW / 2 + cropPanX) / s;
  const srcY = cropImgEl.naturalHeight / 2 - (cropVpH / 2 + cropPanY) / s;
  ctx.drawImage(cropImgEl, srcX, srcY, srcW, srcH, 0, 0, outW, outH);

  const croppedBlob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
  if (!croppedBlob) { closeCropModal(); return; }

  if (cropApplyCallback) cropApplyCallback(croppedBlob, cropIsProcessed);
  closeCropModal();
}

export function initCropModal(): void {
  cropViewport?.addEventListener('mousedown', (e: MouseEvent) => {
    isDragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    dragStartPanX = cropPanX; dragStartPanY = cropPanY;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging) return;
    cropHint?.classList.add('hidden');
    cropPanX = dragStartPanX + (e.clientX - dragStartX);
    cropPanY = dragStartPanY + (e.clientY - dragStartY);
    clampCropPan(); updateCropDisplay();
  });
  document.addEventListener('mouseup', () => { isDragging = false; });

  cropViewport?.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    isDragging = true;
    dragStartX = e.touches[0].clientX; dragStartY = e.touches[0].clientY;
    dragStartPanX = cropPanX; dragStartPanY = cropPanY;
  }, { passive: true });
  document.addEventListener('touchmove', (e: TouchEvent) => {
    if (!isDragging || e.touches.length !== 1) return;
    cropPanX = dragStartPanX + (e.touches[0].clientX - dragStartX);
    cropPanY = dragStartPanY + (e.touches[0].clientY - dragStartY);
    clampCropPan(); updateCropDisplay();
  }, { passive: true });
  document.addEventListener('touchend', () => { isDragging = false; });

  cropViewport?.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    cropZoomVal = Math.min(3, Math.max(1, cropZoomVal - e.deltaY * 0.002));
    if (cropZoomEl) cropZoomEl.value = String(cropZoomVal);
    clampCropPan(); updateCropDisplay();
  }, { passive: false });

  cropZoomEl?.addEventListener('input', () => {
    cropZoomVal = parseFloat(cropZoomEl!.value);
    clampCropPan(); updateCropDisplay();
  });

  cropApplyBtn?.addEventListener('click', () => void applyCrop());
  cropCancelEl?.addEventListener('click', closeCropModal);

  // Close-on-backdrop-click must require the press to have *started* on the
  // backdrop too — not just resolved there. Otherwise a pan/zoom gesture that
  // begins on cropViewport (nested inside cropModal) but ends with the mouse
  // released over the surrounding backdrop area resolves its click event to
  // cropModal (nearest common ancestor of the mousedown/mouseup targets),
  // silently closing the modal mid-interaction.
  let backdropPressStarted = false;
  cropModal?.addEventListener('mousedown', (e) => {
    backdropPressStarted = e.target === cropModal;
  });
  cropModal?.addEventListener('click', (e) => {
    if (e.target === cropModal && backdropPressStarted) closeCropModal();
    backdropPressStarted = false;
  });
}
