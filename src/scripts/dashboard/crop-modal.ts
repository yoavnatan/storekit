const cropModal    = document.getElementById('crop-modal') as HTMLDivElement | null;
const cropViewport = document.getElementById('crop-viewport') as HTMLDivElement | null;
const cropImgEl    = document.getElementById('crop-img') as HTMLImageElement | null;
const cropZoomEl   = document.getElementById('crop-zoom') as HTMLInputElement | null;
const cropApplyBtn = document.getElementById('crop-apply') as HTMLButtonElement | null;
const cropCancelEl = document.getElementById('crop-cancel') as HTMLButtonElement | null;

const VP_SIZE_DEFAULT = 280;
const OUT_SIZE_MAX = 2048; // ceiling only — real output size matches the source pixels selected

export interface CropOptions {
  vpWidth?: number;  // viewport CSS width in px (default 280 — square gallery crop)
  aspect?: number;   // output width/height ratio (default 1 = square)
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
let hadDragMotion = false;
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

const cropHint = document.getElementById('crop-hint');

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
    cropFitScale = Math.max(cropVpW / cropImgEl!.naturalWidth, cropVpH / cropImgEl!.naturalHeight);
    updateCropDisplay();
  };
  cropImgEl.src = URL.createObjectURL(blob);
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
    isDragging = true; hadDragMotion = false;
    dragStartX = e.clientX; dragStartY = e.clientY;
    dragStartPanX = cropPanX; dragStartPanY = cropPanY;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging) return;
    hadDragMotion = true;
    cropHint?.classList.add('hidden');
    cropPanX = dragStartPanX + (e.clientX - dragStartX);
    cropPanY = dragStartPanY + (e.clientY - dragStartY);
    clampCropPan(); updateCropDisplay();
  });
  document.addEventListener('mouseup', () => { isDragging = false; });

  cropViewport?.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    isDragging = true; hadDragMotion = false;
    dragStartX = e.touches[0].clientX; dragStartY = e.touches[0].clientY;
    dragStartPanX = cropPanX; dragStartPanY = cropPanY;
  }, { passive: true });
  document.addEventListener('touchmove', (e: TouchEvent) => {
    if (!isDragging || e.touches.length !== 1) return;
    hadDragMotion = true;
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
  cropModal?.addEventListener('click', (e) => {
    if (e.target === cropModal && !hadDragMotion) closeCropModal();
    hadDragMotion = false;
  });
}
