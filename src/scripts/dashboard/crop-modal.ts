const cropModal    = document.getElementById('crop-modal') as HTMLDivElement | null;
const cropViewport = document.getElementById('crop-viewport') as HTMLDivElement | null;
const cropImgEl    = document.getElementById('crop-img') as HTMLImageElement | null;
const cropZoomEl   = document.getElementById('crop-zoom') as HTMLInputElement | null;
const cropApplyBtn = document.getElementById('crop-apply') as HTMLButtonElement | null;
const cropCancelEl = document.getElementById('crop-cancel') as HTMLButtonElement | null;

const VP_SIZE = 280;
const OUT_SIZE = 512;

let cropApplyCallback: ((blob: Blob, isProcessed: boolean) => void) | null = null;
let cropIsProcessed = false;
let cropFitScale = 1;
let cropZoomVal = 1;
let cropPanX = 0;
let cropPanY = 0;
let isDragging = false;
let hadDragMotion = false;
let dragStartX = 0, dragStartY = 0, dragStartPanX = 0, dragStartPanY = 0;

function clampCropPan() {
  if (!cropImgEl?.naturalWidth) return;
  const s = cropFitScale * cropZoomVal;
  const halfW = Math.max(0, (cropImgEl.naturalWidth * s - VP_SIZE) / 2);
  const halfH = Math.max(0, (cropImgEl.naturalHeight * s - VP_SIZE) / 2);
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
  cropImgEl.style.left = `${(VP_SIZE - w) / 2 + cropPanX}px`;
  cropImgEl.style.top = `${(VP_SIZE - h) / 2 + cropPanY}px`;
}

const cropHint = document.getElementById('crop-hint');

export function openCropModal(blob: Blob, isProcessed: boolean, onApply?: (blob: Blob, isProcessed: boolean) => void): void {
  if (!cropModal || !cropImgEl || !cropZoomEl) return;
  cropIsProcessed = isProcessed;
  cropApplyCallback = onApply ?? null;
  cropPanX = 0; cropPanY = 0; cropZoomVal = 1;
  cropZoomEl.value = '1';
  cropImgEl.onload = () => {
    cropFitScale = Math.max(VP_SIZE / cropImgEl!.naturalWidth, VP_SIZE / cropImgEl!.naturalHeight);
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
  const canvas = document.createElement('canvas');
  canvas.width = OUT_SIZE; canvas.height = OUT_SIZE;
  const ctx = canvas.getContext('2d')!;
  const s = cropFitScale * cropZoomVal;
  const srcSize = VP_SIZE / s;
  const srcX = cropImgEl.naturalWidth / 2 - (VP_SIZE / 2 + cropPanX) / s;
  const srcY = cropImgEl.naturalHeight / 2 - (VP_SIZE / 2 + cropPanY) / s;
  ctx.drawImage(cropImgEl, srcX, srcY, srcSize, srcSize, 0, 0, OUT_SIZE, OUT_SIZE);

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
